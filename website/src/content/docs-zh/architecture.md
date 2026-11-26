---
title: 系统架构与边界
description: 宿主机与沙箱的信任边界、Worker 与 Pi 的职责分离、Service Bridge 五步校验流水线、Model Gateway 与 Run 落盘目录结构。
section: 系统架构
order: 3
---

每一次 `murm` 运行都严格遵循一条信任边界：**可信宿主机（Trusted Host）** 负责运行你的 Harness、保管全部上游密钥并写入权威日志；**隔离沙箱（Isolated Sandboxes）** 负责承载非特权 Pi Agent 进程，受限于独立文件系统与默认拒绝的网络策略。

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 可信宿主机 TRUSTED HOST (Node.js 进程)                                       │
│                                                                            │
│  [ 你的 Harness ] ──> [ Core Runtime ] ──> outputDir/<runtimeId>/          │
│     • 控制循环与规则      • Agent 注册表与槽位     (runtime.json,           │
│     • 角色 Profiles       • 输入与文件账本          evidence.jsonl,         │
│     • 自定义 Services     • 事件流                 service-calls.jsonl,    │
│          ▲                                         model-trace/)           │
│          │                                                                 │
│  ┌───────┴───────────────────┐      ┌───────────────────────────────────┐  │
│  │ Service Bridge (HTTP)     │      │ Model Gateway (HTTP /v1/responses)│  │
│  │ • Bearer 鉴权 -> agentId  │      │ • 每 Agent 独立可撤销令牌          │  │
│  │ • Profile.services 权限   │      │ • 在宿主机注入上游 API 密钥        │  │
│  │ • Ajv draft-07 校验       │      │ • 可选 modelAccessPolicy 租约门控  │  │
│  └───────────▲───────────────┘      └────────────────▲──────────────────┘  │
└──────────────┼───────────────────────────────────────┼─────────────────────┘
               │ MURM_BRIDGE_URL                       │ Gateway origin
               │ (防火墙放行 IPv4)                     │ (防火墙放行 IPv4)
┌──────────────┼───────────────────────────────────────┼─────────────────────┐
│ 隔离沙箱 ISOLATED SANDBOX (每个 Agent 一个 OpenSandbox Docker 容器)          │
│              │                                       │                     │
│  [ Root Worker 守护进程 ] ── 监管 ──> [ 非特权 Pi 1.3.0 进程 ]              │
│   • 写入冻结的 Profile 提示词          • 工具：read / write / edit / bash   │
│   • 快照/安装时短暂暂停写进程          • 通过 Bash 调用 `swarm <svc> <op>`  │
│   • 停止 Pi 后流式回传归档             • 受配额约束的 /workspace/project    │
└────────────────────────────────────────────────────────────────────────────┘
```

## 1. 宿主机与沙箱的职责划分

### 可信宿主机
调用 `createRuntime()` 会在分配任何容器前，为当前 Run 启动三个专属子系统：
1. **Model Gateway**：为每个配置的模型别名开启本地 HTTP 监听与 SQLite 账本，代理 `/v1/responses` 请求到真实上游模型，并完整落盘请求与流式响应。
2. **Service Bridge**：开启本地 HTTP 服务，校验容器身份与 `Profile.services` 权限，用严格 JSON Schema 验证入参/出参，再分发到已注册的 Service。
3. **Backend 句柄**：独占认领一次性的 `PiOpenSandboxBackend` 配置（本地 Docker 隔离模式、磁盘配额、OpenSandbox 生命周期地址）。

### 隔离沙箱
每次 `runtime.spawn()` 通过 OpenSandbox 创建一个独立 Docker 容器，具备：
- 明确的 CPU/内存上限（`resourceLimits`）与项目目录配额（`isolation.disk.bytes` 与 `inodes`）；
- 容器命名空间内的每 Agent 网络防火墙规则：仅允许访问宿主 Service Bridge、Model Gateway 及 `Profile.network.allow` 显式声明的非回环 IPv4 来源（IPv6 及其他所有目标一律拒绝）；
- 纯净的显式环境变量：仅包含 `Profile.env`、`spawn.secretEnv` 以及该 Agent 自身的 Bridge/Gateway 令牌，绝不会把宿主 `process.env` 透传进容器。

## 2. 容器内部：为什么将 Worker 与 Pi 分离

容器内并不是裸跑一个 Pi 进程，而是由 root 权限的 **Worker** 守护进程通过 JSON-RPC 启动并监管一个非特权 **Pi `1.3.0`** 子进程（禁用扩展、skills、prompt templates 与上下文文件，仅保留四个本地基础工具：`read`、`write`、`edit`、`bash`）。

将守护进程与 Agent 分离解决了多智能体工程中的三个核心难题：

1. **受控文件操作**：`runtime.files.prepare`、`grant`、`snapshot` 与 `install` 经由受鉴权的 Worker 管理路由（`/core/files/*`）执行。Worker 可短暂暂停 Agent-UID 进程以保证快照一致性或原子替换目录，无需给 Pi 提权。
2. **无扰上下文分叉（Context Fork）**：`runtime.spawn({ forkFrom })` 向源容器的 Worker 请求 `/core/session/snapshot`，回溯活跃会话链路至最近一个工具调用与结果完整配对的安全边界，剔除父级凭证后在子容器加载 `fork.jsonl`，父容器全程无感继续运行。
3. **先归档再销毁**：调用 `runtime.stop()` 时，Worker 先终止 Pi 进程组冻结磁盘状态，自身继续存活并通过 `/core/session/archive` 和 `/core/files/collect` 将会话与产物安全流式回传宿主机，确认完成后才销毁容器。

## 3. 一次 Service 调用如何穿越 Bridge

当 Agent 在 Bash 中执行：

```bash
swarm notes put --input note-request.json --request-id notes-put
```

`swarm` CLI 会读取容器内受保护的三个环境变量（`MURM_BRIDGE_URL`、`MURM_BRIDGE_TOKEN`、`MURM_BRIDGE_CONTRACT_VERSION=2`），向宿主 Bridge 发出如下 JSON 请求：

```json
POST <MURM_BRIDGE_URL>/call
Authorization: Bearer <per-agent-random-token>
Content-Type: application/json

{
  "service_id": "notes",
  "operation": "put",
  "operation_id": "notes-put",
  "payload": {
    "key": "core-service-boundary",
    "text": "{\"baseline\":\"...\",\"source\":\"...\",\"finding\":\"...\"}"
  }
}
```

Bridge 依次执行五步校验流水线：

1. **身份鉴权与存活检查**：在读取请求体（上限 2 MiB）前校验 bearer 令牌，从私有 Runtime 状态还原 `{ runtimeId, agentId, profile, binding? }`，并确认该 Agent 处于 `idle` 或 `running` 且未触发 fatal 权限围栏。
2. **Profile 权限白名单检查**：校验 `Profile.services[service_id]` 是否包含目标 `operation`，未授权或已撤销的调用立即返回 `NOT_ALLOWED`。
3. **严格输入 Schema 校验**：使用固定版本 Ajv `8.20.0`（同步严格 draft-07，不做类型强制转换或默认值填充）校验 `payload`。不合法输入在业务代码运行前直接返回 `SERVICE_INPUT_INVALID`。
4. **单次分发与实时权限钩子**：精确调用一次 `adapter.invoke({ manifest, capability, input, envelope, caller, signal, assertAuthorized })`。Bridge 不做自动写重试——业务幂等由 Service 通过 `envelope.operation_id` 自行保障；在提交写操作前调用 `assertAuthorized()` 可同步复核调用者权限是否已被撤销。
5. **输出 Schema 校验与追踪落盘**：校验返回值是否符合 `capability.output_schema`（违约返回 `SERVICE_OUTPUT_INVALID`），向 `swarm` 返回结果，并将完整调用记录写入 `service-calls.jsonl` 与 `evidence.jsonl`。

### Agent 如何发现自己可用的 Services

Agent 启动前，Core 会将冻结的系统提示词写入 `/workspace/runtime/profile-prompt.txt`，依次包含：
1. 运行时导语与 `<tools>` 说明；
2. 根据该角色 `Profile.services` 与已注册 Manifest 自动生成的 `<services>` 清单（展示每条授权操作的 `swarm <service> <operation>` 命令；如与内置命令组重名，则展示 `swarm service invoke <service> <operation>`）；
3. 你在 `Profile.prompt` 中编写的角色协作说明。

运行期间，Agent 随时可以查看过滤后的真实 Schema：

```bash
swarm service list
swarm service view notes --json
swarm notes put --help
```

## 4. Model Gateway 链路

Pi 发出的所有 `/v1/responses` 请求都必须经过宿主 **Model Gateway**：

- **密钥永不出宿主机**：上游 URL 与 `Authorization` 请求头只存在于 `PiOpenSandboxBackendConfig.models`，容器内只有可随时撤销的网关令牌。
- **统一限流与全量录制**：网关统一执行 `requestTimeoutMs`（默认 `120_000` ms）与 `maxOutputTokens`（默认 `32_768`，设为 `null` 可透传模型默认上限），并支持在 `selection` 阶段设置 `selectionReasoningEffort: 'low'`。每次新的上游请求都会写入 `model-trace/<attemptId>/`。
- **可选 `modelAccessPolicy` 门控**：[TaskPool](../harnesses/taskpool/) 等基于租约的 Harness 可挂载同步 `authorize(caller)` 钩子返回 `ModelPermit`。一旦任务租约到期或 `fencing_version` 变更，网关会在流式响应中途立刻中止推理。无需租约的 Harness 留空即可。

## 5. 持久化 Run 目录结构

Core 以 `0700` 权限创建 `outputDir/<runtimeId>/`，以 `0600` 权限写入追踪文件，并对已注册凭证（沙箱密钥、execd 令牌、上游请求头、`secretEnv` 与 HTTP 适配器令牌）执行跨流式分块与 JSON 转义的自动脱敏：

```text
outputDir/<runtimeId>/
├── runtime.json                      # 原子写入的运行摘要：配置、提示词哈希、停止/关闭回执
├── evidence.jsonl                    # 有序观测账本：spawn、输入、事件、服务、停止与错误
├── service-calls.jsonl               # 已鉴权 Service 调用的完整入参、出参与错误
├── service-state.<serviceId>.json    # 关闭时由 ServiceAdapter.exportState() 导出的可选快照
├── model-access/                     # 按模型别名拆分的 SQLite 请求账本 (runtime_model_attempts)
├── model-trace/
│   └── <attemptId>/
│       ├── request.json              # 收到与转发的 Responses 请求体及时间戳
│       ├── response.txt              # 原始上游流式响应正文
│       └── result.json               # HTTP/终态状态、失败原因与用量统计
├── <agentId>/
│   ├── session/
│   │   ├── manifest.json             # 原生 Pi 日志的原始与脱敏后 SHA-256 摘要
│   │   └── files/                    # 原生 Pi JSONL 会话文件（含压缩前历史）
│   └── artifacts/
│       ├── manifest.json             # 实际 collect 策略、文件大小、权限模式与 SHA-256
│       └── files/                    # 导出的工作区文件（includeGit: true 时含完整 .git）
└── harness-report.json               # 由 runWithReport() 写入的独立业务/清理/保存报告
```

下一篇阅读 [一次运行的完整脉络](../run-lifecycle/)，在一个具体多轮协作场景中把所有原语串起来。
