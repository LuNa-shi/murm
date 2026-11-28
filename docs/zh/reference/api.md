---
title: SDK 与 API 参考
description: "@luna-shi/murm 公开导出、createSandbox、createRuntime、Agent 生命周期、send/onEvent、runtime.files、Runtime 管理、Service 协议与错误码完整查表。"
section: 参考手册
order: 15
---

本页汇总 **`@luna-shi/murm` 当前源码**的公开运行时导出、方法契约与错误恢复规则。包版本仍为 `0.2.0`，但已发布的 v0.2.0 安装包不包含本页列出的部分新接口。概念与实践请先阅读 [Runtime 与 Agent](../runtime.md) 和 [Service 与权限](../services.md)；完整 TypeScript 声明见 [类型定义与源码映射](./types.md)；宿主机与容器命令行参数见 [CLI 参考](./cli.md)。

## 安装 SDK

先按 [当前源码快速上手](../quickstart.md)构建候选包，再把同一份文件安装到 Node.js 22.19+ 项目：

```bash
npm install --ignore-scripts /absolute/path/to/luna-shi-murm-0.2.0.tgz
```

如果使用正式发行版，请遵循 [v0.2.0 安装指南](../latest.md)及其 [固定版本 API 参考](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/zh/reference/api.md)。所使用的安装包、Worker 镜像和文档应对应同一源码候选版本。

## 公开包入口

所有公开值与 TypeScript 类型均从单一根入口 `@luna-shi/murm` 导入：

| 导出符号 | 类型 | 职责 |
| --- | --- | --- |
| `createSandbox(config)` | 函数 | 创建不可变、可复用的 OpenSandbox 连接配置句柄，或接入自定义 `{ provider }` `SandboxProvider`。 |
| `resolveSandboxConnection(overrides?)` | 函数 | 按与 CLI 一致的优先级解析 Lifecycle 地址、本地密钥与默认镜像（仅在可信宿主配置中使用）。 |
| `createRuntime(options)` | 异步函数 | 启动单次 Run 的控制面（`outputDir/<runtimeId>/`、Service Bridge、Model Gateway），支持 `executor` 与 `filePolicy` 预算。 |
| `createPiExecutor({ version })` / `createCodexExecutor({ version })` | 函数 | 显式选择受支持的内置执行器版本（Pi `1.3.0` / `1.4.0`、Codex `0.172.0`）；也可继续用 `'pi'` / `'codex'` 简写。 |
| `createExecutorAdapter(declaration)` / `EXECUTOR_ADAPTER_PROTOCOL` | 函数 / 常量 | 声明并校验镜像内安装的外部执行器适配器（协议 `murm-executor-v1`）。 |
| `DEFAULT_WORKER_IMAGE` / `workerImageFor(selection)` | 常量 / 函数 | 官方双执行器镜像，或与选定执行器匹配的单执行器 Worker 镜像标签。 |
| `getExecutorCapabilities(selection)` | 函数 | 静态查询所选执行器的能力矩阵（无网络副作用）。 |
| `ServiceRegistry` | 类 | 存放传入 `createRuntime()` 的 Service 注册项。 |
| `createInProcessAdapter(impl)` | 函数 | 将宿主进程内的 `invoke` 处理器（及可选 `exportState`）包装为 `ServiceAdapter`。 |
| `createHttpJsonAdapter(options)` | 函数 | 将外部 HTTP JSON Service 包装为 `ServiceAdapter`（携带 `Idempotency-Key` 与可选 Bearer 认证）。 |
| `Harness`、`HarnessContext`、`HarnessInput`、`HarnessJson` | 类型 | 定义项目模块入口、采集的项目、宿主回调和最终结果。 |
| `ProjectPreflightError`、`projectConfiguration`、`observeProjectRuntime`、`projectResult` | 类和函数 | 处理资源分配前的拒绝、配置、Runtime 状态和结果。 |
| `runInput`、`createInputAdmission`、`runWithReport`、`readHarnessResult`、`createOwnedResources` | 函数 | 管理独占回合、停止接收输入、读写报告并清理本次运行拥有的资源。 |
| `checkGitProject`、`seedTeamRepository`、`seededCheckoutInstruction`、`initializeGitRepository`、`importGitTree`、`commitGitTree`、`isGitTreePath` | 函数 | 检查 Git 项目，导入并提交采集的 FileTree，生成初始检出指令。 |
| `decodeFileTree`、`snapshotFileTree`、`completeFileTreeDigest`、`stableStringify`、`MurmError`、`requestHttp`、`httpClient` | 函数和类 | 读取受限文件内容、计算稳定摘要、保留错误码并连接可信服务。 |

五种[参考应用](../../../examples/README.md)都通过此包根入口编译。[Harness 作者契约](../../architecture/23-project-harness.md#authoring-an-example)说明了生命周期和文件处理。内置别名加载 SDK 中打包好的项目入口。

Runtime 创建自己的 Bridge、模型网关与内置 `agent` Service。示例创建的进程内 Service 无须独立容器；外部协作设施和可选 [Mathlib Search](../../../examples/services/mathlib-search/README.md)按示例声明部署与资源归属，向 SDK 注册 Service 本身不会启动或销毁这些设施。详见 [部署说明](../../../deploy/README.md)。

## `createSandbox(config)` 与 `createRuntime(options)`

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
  createSandbox,
} from '@luna-shi/murm';

const sandbox = createSandbox(); // setup connection defaults

const runtime = await createRuntime({
  sandbox,
  executor: 'pi', // 'pi'（默认）| 'codex' | createPiExecutor(...) | createExecutorAdapter(...)
  connection: { advertiseHost: '172.17.0.1' },
  models: {
    default: {
      provider: 'openai',
      model: 'gpt-5.4',
      // protocol 默认 'responses'；Pi 同时支持 'chat-completions' 或自定义 ModelTransport
      upstream: { url: modelUrl, headers: modelHeaders },
    },
  },
  services: new ServiceRegistry(),
  profiles: {
    reader: { model: 'default', image: DEFAULT_WORKER_IMAGE, writable: false, services: {} },
  },
  maxAgents: 2,
  outputDir: './runs',
});
```

- **`createSandbox`** 读取 setup 默认连接，或接受显式 `endpoint`、`apiKey`、资源和初始生命周期。受信 `{ provider }` 保留自定义集成合同。旧精确配额与 endpoint host 重写在分配前拒绝。

- **`connection`** 使用一个支持反向代理前缀的 `publicUrl`，`bindHost` 与 `bindPort` 控制监听。`modelGateway` 保留 `requestTimeoutMs`、`maxOutputTokens` 与 `maxRequests`。

- **`models`**：默认使用流式 Responses 协议；Pi 也支持 `protocol: 'chat-completions'` 与 `capabilities: { contextWindow, maxOutputTokens, tools, reasoning }`；可信宿主还可通过 `ModelTransport` 自定义流式传输。上游凭据始终留在可信宿主机。
- **`filePolicy`**：可选分别调整 `initial`、`snapshot`、`replace`、`export` 与 `session` 阶段的 `maxBytes`、`maxFileBytes`、`maxFiles`、`maxEntries`、`timeoutMs` 以及 `controllerSpoolBytes` / `workerSpoolBytes` 暂存上限。
- **`getExecutorCapabilities(selection)`**：Pi（`1.3.0` / `1.4.0`）支持 `contextFork`、`activeSteer`、`followUp`、`one-at-a-time` 等完整能力；Codex（`0.172.0`）支持 `activeSteer`、`followUp`、`all` 模式且不支持上下文分叉。

## Agent 生命周期

- **`runtime.spawn({ requestId, profile, parentId?, forkFrom?, writable?, files?, bindings?, secretEnv?, workspace?, collect? })`**：预占槽位（受 `maxAgents` 限制）、准备沙箱并返回处于 `idle` 的 `AgentInfo`。通过 `files` 灌入私有初始文件，或向声明共享能力的受信 Provider 请求共享目录。`forkFrom` 在支持的执行器（`pi`）上复制活跃 Agent 的会话上下文。
- **`runtime.get(agentId)`** / **`runtime.list({ parentId?, status? })`**：返回当前 `AgentInfo` 快照。
- **`runtime.state`**：`'open' | 'closing' | 'closed'`。

## 输入投递与实时观察

- **`runtime.send(agentId, text, { requestId, mode?, wakeIfIdle?, source?, steeringMode? })`**：
  - 默认 `mode: 'steer'` 且 `wakeIfIdle: true`；传入 `mode: 'followUp'` 将输入排在当前执行之后。
  - 返回 `InputReceipt`（`{ status: 'accepted', disposition: 'started' | 'queued' | 'handled' }` 或 `{ status: 'unknown' }`），当 `wakeIfIdle: false` 且目标空闲时返回 `{ status: 'not-accepted', reason: 'idle' }`。
  - 遇到 `unknown` 时必须使用完全相同的 `requestId` 和参数重试对账；同一 `requestId` 修改参数会抛出 `CONFLICT`。
- **`runtime.onEvent(listener)`**：返回 `unsubscribe()` 取消订阅函数。先订阅再执行 `spawn`/`send`，随后通过 `get`/`list`/`state` 读取当前视图。
  - 推送 `output`、`settled`、`error`、`exit`、`agentChanged`、`runtimeChanged` 与 `management` 事件。
  - 事件可能在 `send()` 返回之前到达；单个监听者的异常彼此隔离并记录到账本。

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

- `FileTree` 将项目相对路径映射为 UTF-8 或 base64 普通文件，可选权限 `0o644` 或 `0o755`（上限：10,000 个文件、单文件 2 MiB、总计 16 MiB）。
- **`snapshot(agentId, { requestId, paths, maxBytes? })`**：`paths: ['.']` 返回完整摘要 `complete:sha256:...`；指定子路径返回局部摘要 `partial:sha256:...`。
- **`replace(agentId, { requestId, expectedDigest, files, writable? })`**：核对完整摘要、暂停写进程、在私有目录原子安装完整目标树（含删除与权限变更）、可选解锁 `writable: true`，并保留原会话。返回 `completed`、`failed`（已确认回滚）或 `unknown`（沿用原参数对账）。

## 中断、停止与关闭

- **`runtime.interrupt(agentId, { requestId, timeoutMs? })`**：取消挂起 Bridge 调用、清空排队输入（可选返回 `discardedInputHashes`）并中止当前执行，保留容器、会话、文件与槽位。
- **`runtime.stop(agentId, { timeoutMs? })`**：入口立即撤销凭证，确认执行停止后归档会话、收集声明产物、销毁沙箱并释放槽位。返回的 `StopReceipt` 区分 `execution: 'stopped' | 'unknown'` 与 `cleanup: 'complete' | 'pending'`。
- **`runtime.close({ timeoutMs? })`**：默认超时 `60_000` ms。停止所有 Agent、退役动态 Service、调用 `exportState()`、关闭宿主网关、落盘 `runtime.json` 并返回 `CloseReceipt`。必选产物导出失败时保留沙箱；排除障碍后在同一 Runtime 上重试 `stop()` / `close()` 即可恢复。

## Runtime 管理

在 Run 保持打开期间动态演进 Profile、Service 与权限（全部写操作要求稳定 `requestId`）：

- **`runtime.profiles`**：`register({ id, requestId, profile, actorId? })`、`get(id)`、`list()`——运行中新增不可变 Profile。
- **`runtime.services`**：`register({ requestId, registration, deploymentRef, implementationId, ownership, actorId? })`、`get(id)`、`list()`、`retire({ serviceId, requestId, timeoutMs?, actorId? })`——动态注册或平滑排空退役 Service。
- **`runtime.access`**：`get(agentId)`、`grant({ agentId, serviceId, operations, requestId, binding? })`、`revoke({ agentId, serviceId, operations, requestId })`——调整活跃 Agent 的 Service 权限（可选由 `agentAccessPolicy` 守卫）。
- **`runtime.management.get()`**：返回带递增序列号的快照（`{ sequence, profiles, services, access }`）。先通过 `onEvent` 订阅再读取，缓冲并应用编号大于快照 `sequence` 的 `management` 事件；若出现编号跳跃则重新读取。

## Service 协议与内置 `agent` Service

- **注册（`ServiceRegistry.registerService`）**：要求 `contract_version: '2'`、唯一 `id`（不得使用保留名 `'agent'`）、`title`、`purpose`、`provider_version`、`endpoint`（`in-process` 或 `http-json`）及非空 `capabilities`。Schema 使用 Ajv `8.20.0` 严格同步 draft-07 编译（无强制转换与默认值注入）。
- **调用（`ServiceAdapter.invoke`）**：接收 `{ manifest, capability, input, envelope: { operation_id }, caller: { runtimeId, agentId, profile, binding? }, signal, assertAuthorized }`。单次调用默认超时 `30_000` ms（可在能力上通过 `timeout_ms` 设 `1..86_400_000`）。
- **状态导出（`ServiceAdapter.exportState({ signal })`）**：`runtime.close()` 时调用一次（30 秒上限），落盘至 `service-state.<id>.json`。
- **HTTP JSON 传输契约（`createHttpJsonAdapter`）**：向 `endpoint.url + (capability.path ?? '/v2/' + capability.operation)` 发送 POST `{ input, envelope, caller }`，附带 `Content-Type: application/json`、`Idempotency-Key: <operation_id>` 与可选 `Authorization: Bearer <token>`。远端服务必须先认证宿主连接再信任转发的 `caller`，并返回 `{ "ok": true, "result": <json> }`（上限 2 MiB，禁用重定向）。
- **内置 `agent` Service**：通过 `Profile.services.agent` 显式授予——支持子 Agent 生命周期（`['spawn', 'get', 'send', 'stop']`）与可选委托权限管理（`['access_get', 'grant', 'revoke']`，受 `agentAccessPolicy` 守卫）。`spawn` 需目标角色在 `Profile.spawnProfiles` 中（`fork: true` 需 `Profile.allowContextFork: true`）；`get`/`send` 仅限自身或直属子 Agent；`stop` 仅限直属子 Agent。

宿主机 `murm` 命令行、容器内 `swarm` 命令行及统一环境变量清单见 **[CLI 参考](./cli.md)**。

## 错误码与恢复策略

| 错误码 / 状态 | 含义 | 处理建议 |
| --- | --- | --- |
| `INVALID_CONTRACT` / `SERVICE_INPUT_INVALID` | 参数、配置或入参 Schema 不合法 | 修正参数后重发；原操作未执行 |
| `SERVICE_OUTPUT_INVALID` | Adapter 返回值违反 `output_schema` | 写操作可能已生效，重试前请先核查 Service 状态 |
| `NOT_FOUND` / `NOT_ALLOWED` | 目标不存在、Profile 未授权、已触发 fatal 围栏或 Runtime 正在关闭 | 检查权限与 Agent 状态，不要盲目重试 |
| `CONFLICT` | 同一 `requestId` 参数不一致、摘要/版本冲突或并发槽位（`maxAgents`）已满 | 新参数请换新 `requestId`、刷新摘要，或等待 `stop()` 释放槽位 |
| Runtime 输入 `OPERATION_UNKNOWN` / `status: 'unknown'` | 派发后宿主等待超时或传输中断 | 必须使用**完全相同的 `requestId` 与参数**重放对账 |
| `SERVICE_TIMEOUT` / 未知 Service 写入 | Adapter 可能已经产生副作用 | 保留 `operation_id` 并按该 Service 的幂等契约核对状态；Registry 不会自动重试写入 |
| `cleanup: 'pending'` | 停止执行、会话归档、必选 `collect` 或删除沙箱尚未完成 | 检查 `pending[].action` 与 `errors`，排除障碍后在同一 Runtime 上重试 `stop()` / `close()` |

## HarnessSession

从包根调用 `createHarnessSession(projectHarness, options)` 创建一轮协作的句柄。选项包括 `lifetime`、已解析的 `configuration` 或 `configPath`、`outputRoot`、以及可选的 `clientCapabilities.questions`。通过 `describe()` 查询可用输入、生命周期和成员操作。调用 `start({ cwd, prompt }, { requestId })` 接纳一次 Run，再通过 `onEvent(handler, { initialSnapshot: true })` 和 `getState()` 观察。`input` 根据 Harness 规则追加工作，`respond` 按 ID 回答问题。`stop({ requestId, reason })` 接纳结束请求，`completion` 包含实际导出、业务与清理结果。

`HarnessRpcClient` 使用调用方管理的管道子进程，在 `ready` 后提供同一组方法。[包外示例](../../../examples/harness-session/README.md) 包含进程内 SDK、RPC 和文本客户端用法。[运行手册](../../architecture/23-project-harness.md)

### 作者接口与兼容迁移

模块默认导出 `Harness`，其 `run` 接收 `HarnessContext` 并返回业务、产物和清理证据。Session 补足 Run 身份、提问、操作和报告保存记录，形成 `HarnessResult`。外层 `runId` 和 Core 的 `runtime.id` 分别标识其生命周期。

- 新模块使用 `inputDescriptor`、`context.registerAgentControls({ runtime })` 和 `context.runWithRuntime`。需要等待排他 Agent 回合时调用 `runInput`。派发回调收到外部 `requestId` 和有界 `operationId`，后者用于原生派发及原回执查询。
- `ProjectHarness`、`ProjectHarnessContext`、`ProjectHarnessResult` 和 `inputDescription` 是弃用兼容名，指向同一份合同。移除需等后续公布的兼容性修订。
- `projectConfiguration` 验证可信作者配置，`ProjectPreflightError` 表示资源分配前的拒绝。`observeProjectRuntime` 将业务状态和回执查询接入一次 Session 观察。`projectResult` 为旧 `runWithReport` 调用方复用现行清理投影。
- 保存成功后使用 Host 的 `reportPath`，读 `project-run.json` 时核对 `runId`。`readHarnessResult` 继续按 Runtime ID 读取旧的独立运行文件。
