---
title: API 与配置参考
description: "@murm/core Runtime 方法、统一 send 语义、受控文件原语、Service v2 协议、swarm CLI、前台宿主 CLI、后端配置与错误契约的完整参考。"
section: 参考手册
order: 12
---

本页说明当前源码中 **`@murm/core` `0.2.0`** 的公共接口。安装与完整可运行示例见[使用 TypeScript SDK](../sdk.md)，公共声明见[类型定义与源码映射](./types.md)。

## 公共包入口

所有类型和六个运行时值从 `@murm/core` 导入。运行时值为 `createSandbox`, `createRuntime`, `getExecutorCapabilities`, `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`。

## Runtime 管理

用 `runtime.profiles.register/get/list` 管理不可变 Profile，用 `runtime.services.register/get/list/retire` 管理 Service 目录，用 `runtime.access.get/grant/revoke` 调整现有 Agent 的操作授权。变更请求使用稳定的请求 ID。Service 退役关闭新调用接纳，等待已获准的工作收敛，并返回当前状态。应用负责部署和外部设施清理。

先调用 `onEvent` 订阅，再读取 `runtime.management.get()`。缓冲读取期间的管理事件，并应用其中编号大于快照 `sequence` 的事件。发现编号跳跃时重新读取。管理请求、结果、快照和事件类型均从根入口导入。见 [Runtime 管理](../../architecture/15-core-runtime.md#runtime-management)。

## `createRuntime(options)`

```ts
import { createRuntime, createSandbox, ServiceRegistry } from '@murm/core';

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
    isolation: { disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }),
  connection: { advertiseHost: '172.17.0.1' },
  models: {
    default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: modelUrl, headers: modelHeaders } },
  },
  services: new ServiceRegistry(),
  profiles: { reader: { model: 'default', image, writable: false, services: {} } },
  maxAgents: 2,
  outputDir,
});
```

`createSandbox` 保存 OpenSandbox 部署配置，`kind` 默认 `opensandbox`。指定 Lifecycle URL、磁盘容量和 inode 数。可选 `timeoutSeconds` 默认 3600，至少为 60 且必须是安全整数。Runtime 的 `connection.advertiseHost` 为 Bridge 和 Model Gateway 提供容器可达的宿主 IPv4。需要时可单独设置 `connection.bridge` 和 `connection.modelGateway`。宿主路由凭据保留在受信任的进程中。

Runtime 拥有 `executor`（默认 Pi）、`models`、`connection`、`profiles`、`services`、`maxAgents` 与 `outputDir`。`getExecutorCapabilities('pi' | 'codex')` 无网络副作用。两者支持 steer、followUp、条件输入和队列取消；Pi 额外支持 Context Fork 与显式 `one-at-a-time`，两者支持 `all`。模型上游使用 `/v1/responses`。`connection.modelGateway.maxOutputTokens: null` 保留执行器的输出参数。

## Agent 生命周期

`spawn({ requestId, profile, parentId?, forkFrom?, writable?, files?, workspace?, secretEnv? })` 创建空闲 Agent。 `files` 为私有目录提供初始内容。共享目录用 `workspace: { id, mode: 'read-only' | 'read-write' }`。`forkFrom` 从同一 Runtime 中的活跃 Agent 复制会话上下文，能力检查在分配资源前执行。空闲 Agent 继续占用 Slot。 `get(agentId)` 返回当前 `AgentInfo`，`list({ parentId?, status? })` 返回快照列表。 `runtime.state` 为 `open`、`closing` 或 `closed`。

## 输入投递与事件

`runtime.send(agentId, text, { requestId, mode?, wakeIfIdle?, source?, steeringMode? })` 默认 `mode: 'steer'` 与 `wakeIfIdle: true`。`followUp` 请求在当前工作之后推进。条件发送可返回 `not-accepted/idle`。`accepted` 包含 `started`、`queued` 或 `handled`。未知时保留原身份和参数重试。改变参数产生 `CONFLICT`。输入受理回执只描述接纳。

### 实时观察

`onEvent(listener)` 返回取消订阅函数。先订阅再发起生命周期操作，并用 `get/list/state` 初始化视图。订阅从注册时起收到 `output`、`settled`、`error`、`exit`、`agentChanged`、`runtimeChanged`。后二者使用查询获取当前值。它们可以在操作回执前到达。监听者的异常与拒绝相互隔离，取消订阅影响该监听者。 `settled` 表示 Agent 当前执行已完成、失败或中止。应用通过自己的 Service 和业务记录验证任务完成。

## 受控文件原语（`runtime.files`）

```ts
const original = await runtime.files.snapshot(agentId, { requestId: 'capture-1', paths: ['.'] });
const receipt = await runtime.files.replace(agentId, {
  requestId: 'replace-1',
  expectedDigest: original.digest,
  files: nextTree,
  writable: true,
});
```

`FileTree` 是从项目相对路径到 UTF-8 或 base64 普通文件的映射，可指定 `0644` 或 `0755`。父目录隐式生成。完整快照使用 `paths: ['.']`，显式子路径返回部分摘要。上限为 10000 个文件、单文件 2 MiB、总计 16 MiB；`maxBytes` 可缩小快照上限。受保护路径和链接不属于文件树。

`replace` 接收完整摘要，安装整个私有目标树，包括删除缺失文件和变更模式。省略 `writable` 保留权限，`true` 可从只读切为可写。同一 Agent 和 Session 继续运行。摘要冲突或共享目录替换会被拒绝。Worker 在恢复写者后返回 `completed`。已确认回滚返回 `failed`；未知结果按同一个请求 ID 和参数查询。成功回执的重试保留 Agent 后续修改。

## 中断、停止与关闭

`interrupt(agentId, { requestId, timeoutMs? })` 中断执行、清除排队输入并保留 Session、文件与 Slot。未确认时沿用请求 ID 再试。

`stop(agentId, { timeoutMs? })` 发起时撤销模型和 Bridge 权限，确认停止后依次归档 Session、收集文件、删除 Sandbox 并释放 Slot。 `close({ timeoutMs? })` 处理所有 Agent、Runtime 宿主端点和报告。默认 60 秒。回执区分执行 `stopped/unknown` 和清理 `complete/pending`。必需导出失败保留 Sandbox。重复操作接续未完成的工作。现有外部 Service 保留自己的生命周期。

## Service v2 协议与内置 `agent` Service

- **注册（`ServiceRegistry.registerService`）**：要求 `contract_version: '2'`、唯一 `id`（不得使用保留名 `'agent'`）、`title`、`purpose`、`provider_version`、`endpoint`（`in-process` 或 `http-json`）及非空 `capabilities`。Schema 使用 Ajv `8.20.0` 严格同步 draft-07 编译（不做强制转换与默认值注入）。
- **调用（`ServiceAdapter.invoke`）**：接收 `{ manifest, capability, input, envelope: { operation_id }, caller: { runtimeId, agentId, profile, binding? }, signal, assertAuthorized }`。单次超时默认 `30_000` ms（可在能力上通过 `timeout_ms` 配置 `1..86_400_000`）。
- **状态导出（`ServiceAdapter.exportState({ signal })`）**：`runtime.close()` 期间调用一次（30 秒上限），落盘至 `service-state.<id>.json`。
- **HTTP JSON 协议（`createHttpJsonAdapter`）**：向 `endpoint.url + (capability.path ?? '/v2/' + capability.operation)` 发送 POST `{ input, envelope, caller }`，附带 `Idempotency-Key: <operation_id>` 与可选宿主 `Authorization: Bearer <token>`，要求返回 `{ "ok": true, "result": <json> }`（上限 2 MiB，禁用重定向）。
- **内置 `agent` Service**：通过 `Profile.services.agent` 逐项授权 `['spawn', 'get', 'send', 'stop']`。
  - `spawn` 需配合 `Profile.spawnProfiles` 白名单；`fork: true` 需配合 `Profile.allowContextFork: true`。
  - `get` 与 `send` 可操作自身或直属子 Agent；`stop` 仅可操作直属子 Agent。

应用可以接入已运行的 HTTP Service，也可以用宿主 adapter 调用已有命令行。消息示例可切换进程内或 HTTP 实现，Agent 使用同样的操作。GitHub 示例经 Bridge 授权后，由应用侧执行限定仓库的只读 `gh issue list`。Service 和 GitHub 凭据由应用侧持有。 [Bridge Service 示例](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services)

## `swarm` CLI（容器内使用）

`swarm` 可执行程序（`dist/scripts/swarm.js`）通过 Core 注入的受保护环境变量 `MURM_BRIDGE_URL`、`MURM_BRIDGE_TOKEN` 与 `MURM_BRIDGE_CONTRACT_VERSION=2` 与宿主通信：

```bash
# 发现授权 Services 与完整 Schema
swarm service list
swarm service view <service-id> --json

# 调用任意已注册 Service 操作
swarm <service> <operation> --input payload.json --request-id <unique-id>
swarm <service> <operation> --stdin --request-id <unique-id>
swarm service invoke <service-id> <operation> --input payload.json --request-id <unique-id>

# 内置 agent 控制（当 Profile.services.agent 授权时）
swarm agent spawn --profile worker --text 'Audit src/parser.ts' --fork true --request-id child-1
swarm agent get <agent-id>
swarm agent send <agent-id> --text 'Focus on error paths' --mode steer --wake-if-idle false --request-id steer-1
swarm agent stop <agent-id> --request-id stop-1
```

**CLI 退出码**：`0` 成功、`1` 传输或服务错误、`2` 命令行/契约参数错误、`3` 检查器成功运行但返回业务失败判定（`fail` / `failed` / `source_failure` / `mathematical_failure` / `incorrect`）。

## 仓库内部辅助函数与前台 CLI

下面的 helper 是内置 Harness 使用的源码，不属于额外的包导出。外部 SDK 用户应使用公开 Runtime 方法，或参照可运行 SDK 示例编写自己的策略。

- **`src/harnesses/shared/run-input.ts`**（`runInput`）：单输入源独占轮次辅助函数（确认 `idle`、先订阅再发送、等待 `'started'` 与对应 `settled`）。
- **`src/harnesses/shared/run-report.ts`**（`runWithReport`）：按 `createRuntime` → `run` → 有界 `close` → 可选 `afterClose` 执行，在 `harness-report.json` 中独立保留 `businessFailure`、`cleanupFailure` 与 `reportSaveFailure`。
- **前台宿主 CLI（`scripts/run-harness.ts` 与 `scripts/read-harness-result.ts`）**：通过 `stdin` JSON 行命令（`status`、`kickoff`、`input`、`wait`、`stop`）驱动已配置的 `taskpool` 或 `peermesh` Harness，并离线读取 `runtime.json` 与 `harness-report.json`：

```bash
node dist/scripts/run-harness.js --config <host-config.mjs>
node dist/scripts/read-harness-result.js --run-directory <dir> --runtime-id <id>
```

## 错误码与恢复策略

| 错误码 / 状态 | 含义 | 处理建议 |
| --- | --- | --- |
| `INVALID_CONTRACT` / `SERVICE_INPUT_INVALID` | 参数、配置或入参 Schema 不合法 | 修正参数后重发；原操作未执行 |
| `SERVICE_OUTPUT_INVALID` | Service 返回值违反 `output_schema` | 若为写操作可能已生效，重试前请先检查 Service 业务状态 |
| `NOT_FOUND` / `NOT_ALLOWED` | 目标不存在、Profile 未授权、已触发 fatal 围栏或 Runtime 正在关闭 | 检查权限与 Agent 状态，不要盲目重试 |
| `CONFLICT` | 同一 `requestId` 传了不同参数、乐观锁版本冲突或并发槽位（`maxAgents`）已满 | 新参数请换新 `requestId`，或等 `stop()` 释放槽位 |
| Runtime 输入的 `OPERATION_UNKNOWN` / `status: 'unknown'` | 输入派发后宿主等待超时或传输中断 | 使用**完全相同的 `requestId` 与参数**核对原输入 |
| `SERVICE_TIMEOUT` / 未知的 Service 写入结果 | adapter 可能已经产生副作用 | 保留 operation ID，按该 Service 的幂等契约检查或核对原结果；Registry 不会自动重试或去重写入 |
| `cleanup: 'pending'` | 停止执行、会话归档、必选 `collect` 或销毁容器尚未完成 | 检查 `pending[].action` 与 `errors`，排障后再次调用 `stop()` / `close()` |
