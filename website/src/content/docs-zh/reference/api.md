---
title: API 与配置参考
description: "@murm/core Runtime 方法、统一 send 语义、受控文件原语、Service v2 协议、swarm CLI、前台宿主 CLI、后端配置与错误契约的完整参考。"
section: 参考手册
order: 12
---

本参考严格对应 `main` 分支上的 **`@murm/core` `0.2.0`**。完整 TypeScript 声明与源码直链请见 [类型定义与源码映射](../types/)。

## 公共包入口

| 入口路径 | 公开导出 | 用途 |
| --- | --- | --- |
| `@murm/core` | `createRuntime`（及全部 Core 类型） | 创建并控制单次 Run 的 `Runtime` |
| `@murm/core/services` | `ServiceRegistry`、`createInProcessAdapter`、`createHttpJsonAdapter`、`builtinAgentRegistration`、`getAdapterMetadata`、`invokeService`、`isJson`、`snapshotServiceRegistry` | 定义、校验并注册 v2 Services |
| `@murm/core/backends/pi-opensandbox` | `createPiOpenSandboxBackend`（及 `PiOpenSandboxBackendConfig`） | 配置 Pi `1.3.0` / OpenSandbox 容器后端 |

## `createRuntime(options)`

```ts
createRuntime(options: CreateRuntimeOptions): Promise<Runtime>
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `backend` | 是 | 由 `createPiOpenSandboxBackend()` 创建的一次性后端句柄；认领后仅归属当前 Runtime |
| `profiles` | 是 | 角色名 → `Profile` 映射，装配时深拷贝冻结；未知模型别名、未注册 Service 操作或缺失 `spawnProfiles` 会立即抛 `INVALID_CONTRACT` |
| `services` | 是 | 已注册完成的 `ServiceRegistry`（ID `agent` 为内置 Agent Service 保留） |
| `maxAgents` | 是 | 正安全整数，限定并发 Agent 槽位上限 |
| `outputDir` | 是 | 根输出目录；Core 将本次运行全部记录写入 `outputDir/<runtime.id>/` |
| `modelAccessPolicy` | 否 | 同步 Model Gateway 门控（`authorize(caller): ModelPermit \| null`、`withCommit(commit)`），供 [TaskPool](../../harnesses/taskpool/) 等租约型 Harness 使用 |

装配过程受固定 60 秒宿主等待限制，且此阶段不分配任何 Agent 沙箱。

## Agent 生命周期：`spawn`、`get`、`list`

```ts
runtime.spawn(options: SpawnOptions): Promise<AgentInfo>
runtime.get(agentId: string): Promise<AgentInfo>
runtime.list(filter?: AgentListFilter): Promise<AgentInfo[]>
```

- **`spawn(options)`**：注册 `agentId` 并预占槽位，启动容器与 Pi 会话并确认就绪，以 `status: 'idle'` 返回且不触发初始推理。相同 `requestId` 与参数重放会返回原结果；相同 `requestId` 但参数不同抛 `CONFLICT`。
  - 支持字段：`requestId`、`profile`、`parentId`、`forkFrom`（同一 Runtime 内活跃 Agent）、`writable`（覆盖 `Profile.writable`）、`files`（`FileSeed`，上限 10,000 文件 / 单文件 2 MiB / 总计 16 MiB）、`workspace`（`{ id, mode: 'read-only' | 'read-write' }` 或 `{ mode: 'frozen-copy', files }`）、`bindings`、`secretEnv`、`collect`。
- **`get(agentId)`**：返回不可变 `AgentInfo` 快照（`id`、`profile`、`parentId?`、`status`、`cursor`、`latestOutput?`、`lastError?`、`lastStop?`），关闭后仍可读。
- **`list(filter?)`**：按创建顺序返回快照，支持按 `parentId`（`null` 表示根 Agent 或传指定父 ID）与 `status`（单个或数组）过滤。
- **状态流转**：`starting` → `idle` ⇄ `running` → `closing` → `closed`（异常崩溃为 `exited`）。容量槽位直到容器确认销毁进入 `closed` 后才释放。

## 输入投递与事件：`send`、`start`、`steer`、`onEvent`

```ts
runtime.send(agentId: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>
runtime.send(agentId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>

// 共用同一宿主账本的便捷别名（新建 Harness 建议统一使用 runtime.send）
runtime.start(agentId: string, input: string, options: { requestId: string }): Promise<InputReceipt>
runtime.steer(agentId: string, input: string, options: SteerOptions): Promise<InputReceipt>

runtime.onEvent(handler: (event: AgentEvent) => void): () => void
```

| 选项 | 默认值 | 行为 |
| --- | --- | --- |
| `requestId` | *(必填)* | 1–128 位标识符（`[A-Za-z0-9_.:-]`）；用于幂等去重与 `unknown` 回执对账 |
| `mode` | `'steer'` | `'steer'` 在当前工具批次后、下次模型请求前注入；`'followUp'` 排在当前轮次结束后执行 |
| `wakeIfIdle` | `true` | `true` 唤醒 `idle` Agent；`false` 仅在 `running` 时投递，空闲时返回 `{ inputId, status: 'not-accepted', reason: 'idle' }` |
| `source` | `'host'` | 可选审计来源标签（1–256 字符），与真实鉴权身份分开记录 |
| `steeringMode` | `'one-at-a-time'` | 仅与 `mode: 'steer'` 配合；`'all'` 一次合并消费全部待处理 steer 并在 Pi 会话上持久生效 |

- **受理回执**：
  - `{ inputId, status: 'accepted', disposition: 'started' | 'queued' | 'handled' }`
  - `{ inputId, status: 'not-accepted', reason: 'idle' }` *(仅当 `wakeIfIdle: false`)*
  - `{ inputId, status: 'unknown' }` —— 用**完全相同的 `requestId` 和参数**重试即可向 Worker 查询原 RPC 账本，不会重复注入。
- **事件流（`AgentEvent`）** —— 每条事件均带 `agentId` 与单调递增 `seq`：
  - `{ type: 'output', text }`
  - `{ type: 'settled', outcome: 'completed' | 'failed' | 'aborted', output?, error? }`
  - `{ type: 'error', error, fatal }` —— `fatal: true` 时 Core 会在回调执行前同步吊销 Bridge/模型令牌并封锁新请求。
  - `{ type: 'exit', reason, expected }`

## 受控文件原语（`runtime.files`）

```ts
runtime.files.prepare(agentId: string, options: { requestId: string; files: FileSeed }): Promise<PreparedFiles>
runtime.files.grant(options: { requestId: string; prepared: PreparedFiles }): Promise<GrantReceipt>
runtime.files.snapshot(agentId: string, options: { requestId: string; paths: readonly string[]; includeGit?: boolean; maxBytes?: number }): Promise<FileSnapshot>
runtime.files.install(agentId: string, options: { requestId: string; expected: FileSnapshot; files: FileSeed }): Promise<FileInstall>
runtime.files.installStatus(agentId: string, options: { requestId: string }): Promise<FileInstall | null>
runtime.files.confirm(agentId: string, options: { requestId: string }): Promise<FileInstall>
```

- **`prepare` + `grant`**：向空的只读工作目录写入不可变 `FileSeed` 并返回冻结对象 `PreparedFiles`（`agentId`、`version`、`digest`）；将原内存对象传入 `grant()` 即可在线解锁写权限。
- **`snapshot`**：由 Worker 暂停写入进程（共享挂载暂停全部持有者）后返回一致快照 `{ agentId, requestId, version, digest, files }`（上限 16 MiB，`includeGit` 需显式开启）。
- **`install` + `confirm`**：在写者围栏下核对当前目录与 `expected: FileSnapshot` 一致后替换工作区，保持写者暂停直到宿主提交领域状态并调用 `confirm()` 放行；`installStatus()` 可无副作用查询已缓存回执。
- **`collect`**：可在 `Profile.collect` 或 `spawn({ collect })` 声明 `{ paths, includeGit, allowMissingGit?, maxBytes, required }`。`required: true` 导出失败时会保留容器并返回 `cleanup: 'pending'`。

## 中断、停止与关闭

```ts
runtime.interrupt(agentId: string, options: { requestId: string; timeoutMs?: number }): Promise<InterruptReceipt>
runtime.stop(agentId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>
runtime.close(options?: { timeoutMs?: number }): Promise<CloseReceipt>
```

- **`interrupt`**：推进执行世代号、取消该 Agent 挂起的 Bridge 调用、清空 Pi 队列、中止当前执行并返回 `{ interruptId, status: 'interrupted' | 'unknown', discardedInputHashes? }`，同时完整保留容器、会话、文件与槽位。
- **`stop` / `close`**：严格按 **停止 Pi → 归档原生会话 → 导出 `collect` 产物 → 销毁沙箱并释放槽位** 的顺序执行（`close()` 还会关闭 Bridge/Gateway、调用可选 `exportState()`、刷盘日志并原子写入 `runtime.json`）。默认 `timeoutMs: 60_000`，重试自动跳过已完成阶段。

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

## 宿主辅助工具与前台 CLI

- **`src/harnesses/shared/run-input.ts`**（`runInput`）：单输入源独占轮次辅助函数（确认 `idle`、先订阅再发送、等待 `'started'` 与对应 `settled`）。
- **`src/harnesses/shared/run-report.ts`**（`runWithReport`）：按 `createRuntime` → `run` → 有界 `close` → 可选 `afterClose` 执行，在 `harness-report.json` 中独立保留 `businessFailure`、`cleanupFailure` 与 `reportSaveFailure`。
- **前台宿主 CLI（`scripts/run-harness.ts` 与 `scripts/read-harness-result.ts`）**：通过 `stdin` JSON 行命令（`status`、`kickoff`、`input`、`wait`、`stop`）驱动已配置的 `taskpool` 或 `peermesh` Harness，并离线读取 `runtime.json` 与 `harness-report.json`：

```bash
node dist/scripts/run-harness.js --config <host-config.mjs>
node dist/scripts/read-harness-result.js --run-directory <dir> --runtime-id <id>
```

## Pi/OpenSandbox 后端配置

```ts
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';

const backend = createPiOpenSandboxBackend({
  sandbox: {
    lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
    endpointHost: '127.0.0.1',
    apiKey: process.env.OPEN_SANDBOX_API_KEY,
    resourceLimits: { cpu: '1', memory: '1Gi' },
    commandTimeoutMs: 20_000,
    timeoutSeconds: 3600, // 可选；安全整数 >= 60，默认 3600
  },
  bridge: {
    host: '0.0.0.0',
    publicUrl: 'http://172.17.0.1:{port}', // 容器可达的非回环 IPv4
  },
  modelGateway: {
    host: '0.0.0.0',
    advertiseHost: '172.17.0.1',
    requestTimeoutMs: 120_000,       // 默认 120_000
    maxOutputTokens: null,           // 安全整数 >= 16，默认 32_768；null 表示沿用上游默认
    selectionReasoningEffort: 'low', // 可选；仅对 selection 阶段许可生效
  },
  models: {
    default: {
      provider: 'kimi_proxy',
      model: 'k3',
      upstream: {
        url: 'https://your-model-endpoint/v1/responses',
        headers: { authorization: `Bearer ${process.env.MODEL_TOKEN}` },
      },
    },
  },
  isolation: {
    network: 'local-docker',
    disk: { bytes: 64 * 1024 ** 2, inodes: 4096 },
  },
});
```

## 错误码与恢复策略

| 错误码 / 状态 | 含义 | 处理建议 |
| --- | --- | --- |
| `INVALID_CONTRACT` / `SERVICE_INPUT_INVALID` | 参数、配置或入参 Schema 不合法 | 修正参数后重发；原操作未执行 |
| `SERVICE_OUTPUT_INVALID` | Service 返回值违反 `output_schema` | 若为写操作可能已生效，重试前请先检查 Service 业务状态 |
| `NOT_FOUND` / `NOT_ALLOWED` | 目标不存在、Profile 未授权、已触发 fatal 围栏或 Runtime 正在关闭 | 检查权限与 Agent 状态，不要盲目重试 |
| `CONFLICT` | 同一 `requestId` 传了不同参数、乐观锁版本冲突或并发槽位（`maxAgents`）已满 | 新参数请换新 `requestId`，或等 `stop()` 释放槽位 |
| `OPERATION_UNKNOWN` / `SERVICE_TIMEOUT` / `status: 'unknown'` | 宿主等待超时或传输中断，结果未明 | 使用**完全相同的 `requestId` 与参数**重发以对账原请求 |
| `cleanup: 'pending'` | 停止执行、会话归档、必选 `collect` 或销毁容器尚未完成 | 检查 `pending[].action` 与 `errors`，排障后再次调用 `stop()` / `close()` |
