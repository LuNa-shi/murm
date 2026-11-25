---
title: API 与配置参考
description: Runtime 全部方法、统一 send 投递语义、文件控制、Service 协议、swarm CLI、后端配置与错误处理的权威查表手册。
section: 参考与部署
order: 12
---

本页对应最新主干提交 [`ac72c76`](https://github.com/LuNa-shi/SwarmEnv/commit/ac72c76) 与 `@swarmenv/core` `0.2.0`。完整 TypeScript 声明见 [TypeScript 类型与映射](../types/)。

## 包导入入口

| 包入口 | 导出符号 | 用途 |
| --- | --- | --- |
| `@swarmenv/core` | `createRuntime` | 创建一次 Run 对应的 Runtime |
| `@swarmenv/core/services` | `ServiceRegistry`、`createInProcessAdapter`、`createHttpJsonAdapter`、`builtinBotRegistration`、`getAdapterMetadata`、`invokeService`、`isJson`、`snapshotServiceRegistry` | 注册与调用 Service |
| `@swarmenv/core/backends/pi-opensandbox` | `createPiOpenSandboxBackend` | 配置 Pi/OpenSandbox 执行后端 |

## `createRuntime(options)`

```ts
createRuntime(options: CreateRuntimeOptions): Promise<Runtime>
```

- `backend`：由 `createPiOpenSandboxBackend()` 返回的一次性后端句柄（不可被多个 Runtime 复用）。
- `profiles`：角色名到 `Profile` 的映射，创建时冻结快照；未知模型别名或未知 Service 操作会立即报错。
- `services`：已注册好服务的 `ServiceRegistry`（保留 ID `bot` 由 Core 内置管理）。
- `maxBots`：同时占用资源的 Agent 容量上限（正整数）。
- `outputDir`：输出根目录，实际写入 `outputDir/<runtime.id>/`。
- `modelAccessPolicy`（可选）：挂在 Model Gateway 前的同步准入策略，包含 `authorize(caller): ModelPermit | null` 与 `withCommit(commit)`，用于在每次模型请求前核验业务阶段、截止时间与任务租约（示例见 [Flat · 公共任务池](../../programs/flat/)）。

## Agent 生命周期：`spawn`、`get`、`list`

```ts
runtime.spawn(options: SpawnOptions): Promise<BotInfo>
runtime.get(botId: string): Promise<BotInfo>
runtime.list(filter?: BotListFilter): Promise<BotInfo[]>
```

- `spawn` 先登记身份、占用容量名额，再启动容器与 Pi，就绪后返回 `status: 'idle'`（不自动提交工作输入）。
- 常用参数：`requestId`（幂等键）、`profile`、`parentId`、`forkFrom`（复制同一 Runtime 内活跃 Agent 的原生对话历史前缀）、`writable`、`files`、`workspace`（`frozen-copy` 或同 Runtime 共享目录 `{ id, mode: 'read-only' | 'read-write' }`）、`bindings`、`secretEnv`、`collect`。
- `list` 支持按 `parentId`（省略 / `null` 仅根 Agent / 指定 ID）和 `status` 筛选。
- **状态取值**：`starting` → `idle` ⇄ `running` → `closing` → `closed`（异常进程退出为 `exited`）。`idle`、`exited`、`closing` 均继续占用 Slot，确认资源删除进入 `closed` 后释放。

## 输入与事件：`send`（推荐）、`start`、`steer`、`onEvent`

```ts
runtime.send(botId: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>
runtime.send(botId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>

// 等价便捷别名（新代码推荐统一使用 send）
runtime.start(botId: string, input: string, options: { requestId: string }): Promise<InputReceipt>
runtime.steer(botId: string, input: string, options: SteerOptions): Promise<InputReceipt>

runtime.onEvent(handler: (event: BotEvent) => void): () => void
```

| 参数 | 默认值 | 行为说明 |
| --- | --- | --- |
| `mode` | `'steer'` | `'steer'` 在当前工具批次完成后、下一次模型请求前插入；`'followUp'` 排在当前整轮工作之后 |
| `wakeIfIdle` | `true` | `true` 会唤醒空闲 Agent；`false` 仅在目标处于 `running` 时投递，空闲时返回 `{ inputId, status: 'not-accepted', reason: 'idle' }` |
| `source` | 调用方 | 非空、最多 256 字符的宿主记录标签 |
| `steeringMode` | Pi 默认 `'one-at-a-time'` | 设为 `'all'` 会一次取出全部待处理 steer 输入；该设置在 Pi 会话中持久生效 |

- **回执取值**：`accepted`（`disposition`: `'started' | 'queued' | 'handled'`）、`not-accepted`（`reason: 'idle'`）或 `unknown`（核对时必须保留原 `requestId` 和参数，切勿换新 ID 重发）。
- **事件类型**（均含 `botId` 与单调递增 `seq`）：`output`、`settled`（`outcome`: `'completed' | 'failed' | 'aborted'`）、`error`（含 `fatal`）、`exit`（含 `expected`）。
- 一次执行可能吸收多条输入，`settled` 标志一轮执行结束，逐项业务任务完成由 Program 或 Service 记录。

## 文件控制与采集

```ts
runtime.files.prepare(botId: string, options: { requestId: string; files: FileSeed }): Promise<PreparedFiles>
runtime.files.grant(options: { requestId: string; prepared: PreparedFiles }): Promise<GrantReceipt>
runtime.files.snapshot(botId: string, options: { requestId: string; paths: readonly string[]; includeGit?: boolean; maxBytes?: number }): Promise<FileSnapshot>
```

- **`prepare` + `grant`**：向尚为空的只读目录铺入文件并签发 `PreparedFiles`；必须将当前 Runtime 返回的原始对象传给 `grant` 才能开放写权限（不可经 JSON 序列化重建）。
- **`snapshot`**：在 Agent 运行期间由 Worker 暂停相关写入者（共享目录覆盖全部挂载者），返回一致的 `{ version, digest, files }`（`maxBytes` 默认且最高 16 MiB）。
- **`collect`**（在 Profile 或 `spawn` 中声明）：`{ paths, includeGit, maxBytes, required }`。`required: true` 且导出失败时，保留容器并返回 `cleanup: 'pending'`；原生 Session 归档始终按必需项处理。

## 中断、停止与关闭

```ts
runtime.interrupt(botId: string, options: { requestId: string; timeoutMs?: number }): Promise<InterruptReceipt>
runtime.stop(botId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>
runtime.close(options?: { timeoutMs?: number }): Promise<CloseReceipt>
```

- **`interrupt`**：取消该 Agent 在途 Bridge 调用、清空待处理队列并中止当前执行，保留 Session、工作目录与 Slot。若丢弃了未消费的排队输入，回执中的 **`discardedInputHashes`** 会返回它们的 SHA-256 哈希数组供邮箱恢复。
- **`stop` / `close`**：严格按“停执行 → 归档 Session → 采集 `collect` 文件 → 删除容器释放 Slot”执行。`StopReceipt` 分别报告 `execution: 'stopped' | 'unknown'` 与 `cleanup: 'complete' | 'pending'`；再次调用会继续推进尚未完成的步骤。

## Service 协议与内置 `swarm` CLI

- **Manifest v2**（`contract_version: '2'`）：声明 `id`、`title`、`purpose`、`endpoint`（`in-process` 或 `http-json`）与 `capabilities`（含 `side_effect`、`idempotent`、draft-07 `input_schema` / `output_schema`、`errors`、`timeout_ms` 默认 30 秒）。
- **调用请求 `ServiceRequest`**：向实现传入已校验的 `input`、`envelope.operation_id`、不可伪造的 `caller`（`{ runtimeId, botId, profile, binding? }`）、取消信号 `signal` 与提交前鉴权函数 `assertAuthorized()`。
- **可选 `exportState({ signal })`**：`runtime.close()` 时触发（单服务限时 30 秒），结果写入 `service-state.<id>.json`。
- **HTTP Service 约定**：POST 至 `endpoint.url + (capability.path ?? '/v2/' + operation)`，携带 `idempotency-key` 与可选 `Authorization: Bearer`，响应体须为 `{ ok: true, result }`（上限 2 MiB，不跟随重定向）。
- **内置 `bot` Service**（当 `Profile.services.bot` 授权时可用）：`spawn`（返回 `{ bot, initialInput }`）、`get`、`send`（支持 `mode` 与 `wake_if_idle`）、`stop`（仅限直接子 Agent）。

```bash
swarm service list
swarm service view <service-id>
swarm <service> <operation> --input payload.json --request-id <unique-id>
```

## Pi/OpenSandbox 后端配置

| 配置组 | 必填字段 | 关键说明 |
| --- | --- | --- |
| `sandbox` | `lifecycleBaseUrl` | 可选 `apiKey`、`execdToken`、`endpointHost`、`resourceLimits`、`commandTimeoutMs`、`timeoutSeconds`（默认 3600，最小 60） |
| `bridge` | `host`、`publicUrl` | `publicUrl` 须含 `{port}` 且 hostname 为容器可达的非 loopback IPv4 |
| `modelGateway` | `host`、`advertiseHost` | 可选 `requestTimeoutMs`（默认 120s）、`maxOutputTokens`（默认 32,768；`null` 表示不限制） |
| `models` | 别名映射 | 每项含 `provider`、`model`、`upstream: { url, headers }`（URL 须以 `/v1/responses` 结尾） |
| `isolation` | `network: 'local-docker'`、`disk: { bytes, inodes }` | 强制声明本地 Docker 网络与磁盘配额 |

## 常见错误码速查

| 错误码 / 状态 | 含义与处理方式 |
| --- | --- |
| `INVALID_CONTRACT` / `SERVICE_INPUT_INVALID` | 参数、Schema 或配置引用不合法，修正后重新提交 |
| `NOT_FOUND` / `NOT_ALLOWED` | 目标不属于本 Run、无 Profile 权限或已进入关闭态 |
| `CONFLICT` | 同一 `requestId` 传了不同参数，或资源版本/容量名额冲突 |
| `OPERATION_UNKNOWN` / `SERVICE_TIMEOUT` / `status: 'unknown'` | 远端操作可能已生效，保留原 `requestId` 与参数核对，不换新 ID 重试写操作 |
| `cleanup: 'pending'` | 查看 `pending[].action` 与 `error`，处理后再调 `stop()` 或 `close()` 继续 |
