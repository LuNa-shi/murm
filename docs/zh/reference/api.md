---
title: API 与配置参考
description: "@murm/core Runtime 方法、统一 send 语义、受控文件原语、Service v2 协议、swarm CLI、前台宿主 CLI、后端配置与错误契约的完整参考。"
section: 参考手册
order: 12
---

本页说明当前源码中 **`@murm/core` `0.2.0`** 的公共接口。安装与完整可运行示例见[使用 TypeScript SDK](../sdk.md)，公共声明见[类型定义与源码映射](./types.md)。

## 公共包入口

下面是一个包的四个导出路径。当前清单仍有 `private: true`，安装方式请使用 SDK 指南中的 tarball 配方。

| 入口路径 | 公开导出 | 用途 |
| --- | --- | --- |
| `@murm/core` | `createRuntime`、`finalizeRun`（及全部 Core 类型） | 创建、控制并结束一次 Run |
| `@murm/core/services` | `ServiceRegistry`、`createInProcessAdapter`、`createHttpJsonAdapter`、`builtinAgentRegistration`、`getAdapterMetadata`、`invokeService`、`isJson`、`snapshotServiceRegistry` | 定义、校验并注册 v2 Services |
| `@murm/core/backends/opensandbox` | `createOpenSandboxBackend`、`getOpenSandboxBackendCapabilities`（及 `OpenSandboxBackendConfig`、`BackendCapabilities`、`ExecutorKind`） | 配置 OpenSandbox 内的 Pi 或 Codex 并查询执行器能力 |
| `@murm/core/backends/pi-opensandbox` | `createPiOpenSandboxBackend`（及 `PiOpenSandboxBackendConfig`） | 已弃用的 Pi 专用工厂；改用通用入口并设置 `executor: 'pi'` |

## Run 收尾

应用确定业务结果后，从 `@murm/core` 导入 `finalizeRun`。传入已创建的 Runtime、输出根目录和 `business` 结果。成功用 `status: 'completed'` 和 JSON 值，失败或取消用 `status: 'failed'` 或 `'cancelled'` 和应用错误码及消息。返回值分别包含 `coreClose`、`artifactVerification`、`facilities` 和 `reportSaveFailure`。

可选的 `verifyArtifacts` 读取已经取得的 Core 关闭回执，包括 pending 回执，并检查自己需要的导出文件；Core 关闭状态为 unknown 时，验证保持 pending。只把本次应用拥有的设施登记到 `ownedFacilities`。产物验证尝试之后，仅在 Core 清理已完成时调用设施关闭回调；产物验证失败会独立记录。Core 返回 pending 时，报告保留待处理资源身份和相关设施。收尾有独立的 `cleanupTimeoutMs`，默认 60,000 ms，回调会收到对应 AbortSignal。宿主等待到期时若尚无 Core 回执，关闭状态为 `unknown`。报告保存成功时返回 `outputDir/<runtime.id>/run-finalization.json` 的路径。

如果设施关闭回调在期限到期时已经发出，`lateFacilityCleanup.current()` 可查询其晚到回执，`lateFacilityReportPath` 指向回调结束后保存的独立记录。每个 Runtime 对象只接受一次收尾调用，重复调用报 `CONFLICT`。如需核对待处理工作，应调用同一 Runtime 的 `close` 并核对原来的设施句柄。

## 实时观察

```ts
runtime.observe(options?: RuntimeObservationOptions): RuntimeObservation
```

`runtime.observe()` 一次返回当前 `snapshot` 和紧接同一游标之后的异步迭代器 `events`。用 `runtime.observe({ after: lastCursor })` 续读时返回 `snapshot: null`，应把增量应用到已有状态。遇到 `gap` 时重新调用 `observe()` 取得快照。Runtime 保留 256 条更新，最多允许 64 个活动订阅，每个订阅可有一个等待中的读取。调用 `cancel()`、触发 AbortSignal 或退出 `for await` 可释放订阅；Runtime 关闭本身不会结束订阅。游标只属于同一个存活的 Runtime 实例，不能用来恢复重启后的进程。

更新类型包括 `runtime`、`agent`、`input`、`execution`、`service`、`trace-gap`、`persistence` 与 `gap`。输入回执、实际执行边界、Service attempt 和清理各有对应字段。该流只提供精简的身份与状态；输出文本通过 `onEvent` 读取，详细载荷见保存的 trace。Runtime 游标给实时增量排序，Agent 序号给旧版 Agent 事件排序，`recordSeq` 在可用时引用 Run 持久证据。原生执行事件缺少输入身份时，关联状态为 `unknown`。需要核对输入时使用原请求 ID。快照与持久化事件提供写入进度和丢失记录。

## `createRuntime(options)`

```ts
createRuntime(options: CreateRuntimeOptions): Promise<Runtime>
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `backend` | 是 | 由 `createOpenSandboxBackend()` 创建的一次性后端句柄；认领后仅归属当前 Runtime |
| `profiles` | 是 | 角色名 → `Profile` 映射，装配时深拷贝冻结；未知模型别名、未注册 Service 操作或 `spawnProfiles` 中引用不存在的角色会立即抛 `INVALID_CONTRACT` |
| `services` | 是 | 已注册完成的 `ServiceRegistry`（ID `agent` 为内置 Agent Service 保留） |
| `maxAgents` | 是 | 正安全整数，限定并发 Agent 槽位上限 |
| `outputDir` | 是 | 根输出目录；Core 将本次运行全部记录写入 `outputDir/<runtime.id>/` |
| `modelAccessPolicy` | 否 | 同步 Model Gateway 门控（`authorize(caller): ModelPermit \| null`、`withCommit(commit)`），供 [TaskPool](../harnesses/taskpool.md) 等租约型 Harness 使用 |

装配过程受固定 60 秒宿主等待限制，且此阶段不分配任何 Agent 沙箱。Profile、Service 注册与后端配置在该 Runtime 中固定；当前没有运行时新增 Profile 或 Service、修改操作授权或替换执行器的公共方法。

## Agent 生命周期：`spawn`、`get`、`list`

```ts
runtime.spawn(options: SpawnOptions): Promise<AgentInfo>
runtime.get(agentId: string): Promise<AgentInfo>
runtime.list(filter?: AgentListFilter): Promise<AgentInfo[]>
```

- **`spawn(options)`**：注册 `agentId` 并预占槽位，启动容器与所选执行器会话并确认就绪，以 `status: 'idle'` 返回且不触发初始推理。相同 `requestId` 与参数重放会返回原结果；相同 `requestId` 但参数不同抛 `CONFLICT`。
  - 支持字段：`requestId`、`profile`、`parentId`、`forkFrom`（同一 Runtime 内活跃 Agent）、`writable`（覆盖 `Profile.writable`）、`files`（`FileSeed`，上限 10,000 文件 / 单文件 2 MiB / 总计 16 MiB）、`workspace`（`{ id, mode: 'read-only' | 'read-write' }` 或 `{ mode: 'frozen-copy', files }`）、`bindings`、`secretEnv`、`collect`。
- **`get(agentId)`**：返回独立的 `AgentInfo` 快照（`id`、`profile`、`parentId?`、`status`、`cursor`、`latestOutput?`、`lastError?`、`lastStop?`），关闭后仍可读。
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
| `mode` | `'steer'` | steer 引导当前执行，followUp 排在当前执行之后；Pi 在工具批次后注入 steer，Codex 对当前原生 turn 发送 steer |
| `wakeIfIdle` | `true` | `true` 唤醒 `idle` Agent；`false` 请求只向 Worker 观察到的活动执行投递，空闲时返回 `{ inputId, status: 'not-accepted', reason: 'idle' }` |
| `source` | `'host'` | 可选审计来源标签（1–256 字符），与真实鉴权身份分开记录 |
| `steeringMode` | 由执行器决定 | 仅与 `mode: 'steer'` 配合。Pi 初始采用 `'one-at-a-time'`，可持续切换到 `'all'`；Codex 仅支持显式 `'all'`，选择前查询后端 capabilities |

- **受理回执**：
  - `{ inputId, status: 'accepted', disposition: 'started' | 'queued' | 'handled' }`
  - `{ inputId, status: 'not-accepted', reason: 'idle' }` *(仅当 `wakeIfIdle: false`)*
  - `{ inputId, status: 'unknown' }` —— 用**完全相同的 `requestId` 和参数**重试即可向 Worker 查询原 RPC 账本，不会重复注入。

提交后若应用超时或 AbortSignal 结束宿主等待，请保留原 request ID 和参数。结果未知时，用同样的 `send` 调用核对原回执。需要中断当前轮次时调用 `interrupt`，关闭 Agent 时调用 `stop`。缺少输入关联的 `settled` 只提供 Agent 执行收束信息，应用自行检查业务是否完成。

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

- **`interrupt`**：推进执行世代号、取消该 Agent 挂起的 Bridge 调用、要求执行器 Worker 清空队列并中止当前执行并返回 `{ interruptId, status: 'interrupted' | 'unknown', discardedInputHashes? }`，同时完整保留容器、会话、文件与槽位。
- **`stop` / `close`**：严格按 **停止执行器 → 归档原生会话 → 导出 `collect` 产物 → 销毁沙箱并释放槽位** 的顺序执行（`close()` 还会关闭 Bridge/Gateway、调用可选 `exportState()`、刷盘日志并原子写入 `runtime.json`）。上述顺序适用于每个 Agent 内部；`close()` 并行启动 Agent 清理与入口关闭。默认 `timeoutMs: 60_000`，重试跳过已完成阶段。pending 表示仍有未确认工作，原清理操作可能还在执行。

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

下面的 helper 是内置 Harness 使用的源码，不属于额外的包导出。外部 SDK 用户应使用公开 Runtime 方法与 `finalizeRun`，或参照可运行 SDK 示例编写自己的策略。

- **`src/harnesses/shared/run-input.ts`**（`runInput`）：单输入源独占轮次辅助函数（确认 `idle`、先订阅再发送、等待 `'started'` 与对应 `settled`）。
- **`src/harnesses/shared/run-report.ts`**（`runWithReport`）：按 `createRuntime` → `run` → 有界 `close` → 可选 `afterClose` 执行，在 `harness-report.json` 中独立保留 `businessFailure`、`cleanupFailure` 与 `reportSaveFailure`。
- **前台宿主 CLI（`scripts/run-harness.ts` 与 `scripts/read-harness-result.ts`）**：通过 `stdin` JSON 行命令（`status`、`kickoff`、`input`、`wait`、`stop`）驱动已配置的 `taskpool` 或 `peermesh` Harness，并离线读取 `runtime.json` 与 `harness-report.json`：

```bash
node dist/scripts/run-harness.js --config <host-config.mjs>
node dist/scripts/read-harness-result.js --run-directory <dir> --runtime-id <id>
```

## OpenSandbox 后端配置

```ts
import { createOpenSandboxBackend, getOpenSandboxBackendCapabilities } from '@murm/core/backends/opensandbox';

const backend = createOpenSandboxBackend({
  executor: 'pi',
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
    maxOutputTokens: null,           // 保留执行器参数，不施加宿主 token 上限
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

当前后端使用 OpenSandbox 分配与本地 Docker 隔离。`executor` 默认是 `'pi'`，仓库适配的执行器版本为 Pi `1.3.0` 和 Codex `0.172.0`。模型上游 URL 必须以 `/v1/responses` 结尾。省略输出上限时使用所选执行器的策略：Pi Gateway 默认 32,768，Codex 保留执行器原参数。

```ts
const capabilities = getOpenSandboxBackendCapabilities(backend);
console.log(capabilities.contextFork, capabilities.steeringModes);
```

两种执行器都支持 active steer、follow-up、条件输入、队列取消、模型请求授权与原始请求 trace。Context Fork 目前只有 Pi 支持。公共后端句柄没有暴露 provider 注册或直接分配沙箱的方法。

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
