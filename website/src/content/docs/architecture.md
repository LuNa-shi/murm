---
title: 系统架构
description: 沿着真实的数据与控制流，看懂宿主进程、OpenSandbox 容器、Worker、Service Bridge、Model Gateway 与 Run 留痕目录如何配合。
section: 理解系统
order: 3
---

一次 `murm` 运行由两条清晰的信任边界组成：**宿主进程**运行你的 Program、掌握所有上游密钥并记录权威轨迹；**Sandbox 容器**隔离每个 Agent 的代码目录、命令执行与网络访问。

![murm 系统架构总览：宿主进程与隔离沙箱容器](../../assets/images/architecture-overview.jpg)

## 1. 宿主进程与沙箱容器的职责划分

- **宿主侧（受信）**：运行你编写的 **Program** 与 **Runtime**。创建 Runtime 时，它会自动拉起两个仅供本次 Run 使用的内部 HTTP 服务：
  - **Service Bridge**：接收容器内 `swarm` CLI 发来的协作调用，验证身份与参数后交给对应的 Service。
  - **Model Gateway**：代理容器内 Pi 发出的模型请求，在宿主侧注入上游 API Key 并记录完整请求与流式响应。
- **沙箱侧（隔离）**：每调用一次 `runtime.spawn()`，后端通过 OpenSandbox 启动一个独立的 Docker 容器，在隔离的磁盘配额和网络白名单内运行 **Worker** 与 **Agent（Pi）**。

## 2. 容器内部：为什么 Worker 与 Agent 分离

容器内并不是直接只跑一个 Pi 进程，而是由轻量监管进程 **Worker** 拉起低权限的 Pi 子进程（仅开启四个本地工具：`read`、`write`、`edit`、`bash`）。

把 Worker 与 Pi 拆开解决了两个在多智能体协作中非常实际的问题：

1. **受控文件交接**：当宿主调用 `files.prepare`、`files.grant` 或 `files.snapshot` 时，操作由受信的 Worker 完成——Worker 可以先暂停可能正在改写目录的进程，安全读取一致快照或切换目录写权限，而无需给 Pi 额外系统权限。
2. **安全导出再销毁**：当宿主停止一个 Agent 时，Core 先让 Worker 终止 Pi 进程（确保磁盘不再变化），同时保持 Worker 存活，由 Worker 把 Pi 的完整原生 Session 和 `collect` 声明的文件稳定传回宿主，确认归档落盘后才销毁容器。

## 3. 一条 Service 调用如何穿过 Bridge

当 Agent 在 Bash 中执行一条共享操作（例如 `swarm notes put` 或 `swarm collaboration spawn_agent`）时，请求沿下面五步流转：

![Agent 调用 Service 的五步可信链路](../../assets/images/service-bridge-flow.jpg)

1. **容器发起命令**：Agent 在 Bash 中运行 `swarm <service> <operation>`，CLI 自动携带该容器专属的 `SWARMENV_BRIDGE_TOKEN` 向宿主 Bridge 发 HTTP POST。
2. **身份与权限校验**：Bridge 根据 Token 查出真实 `agentId` 和 `profile`，核对该 Profile 是否获准调用这个操作。未授权操作直接返回 `403 NOT_ALLOWED`。
3. **严格 Schema 校验**：Registry 按 `manifest.input_schema`（JSON Schema draft-07）校验入参，非法输入不会进入业务代码。
4. **可信身份注入与业务提交**：Bridge 构造不可伪造的 `caller`（含 `runtimeId`、`botId`、`profile` 以及该 Service 专属的 `binding`），交给本地函数或远端 HTTP 服务执行业务规则（如排他认领、版本乐观锁与幂等去重）。
5. **输出校验与全量留痕**：返回值通过 `output_schema` 校验后返回给 Agent，同时这次调用的完整入参、出参与耗时自动写入 `service-calls.jsonl`。

### 如何让 Agent 知道自己有哪些 Service

在当前实现中，Agent 随时可以通过 `swarm service list` 和 `swarm service view <id>` 动态发现自己获准使用的操作和参数说明；同时 Program 会在 `Profile.prompt` 中告知协作约定。

在 `murm` 的架构演进中，这一步将进一步统一为 **`system prompt + tools + services`** 的自动注入模型：Runtime 在启动 Agent 时，直接根据 `Profile.services` 与已注册的 `ServiceManifest` 生成一段精简的能力目录拼入系统提示词（列出服务用途与操作摘要，详细 Schema 按需通过 `view` 查看），让新增一个 Service 可以零样板代码地自动接入所有获授权 Agent。

## 4. 模型请求路径：Model Gateway

Agent 发出的 `/v1/responses` 请求全部先经过宿主的 **Model Gateway**，而不是直接访问公网模型 API：

- **密钥不出宿主**：上游模型服务的 `Authorization` Header 仅保存在宿主配置中，容器内拿不到真实 API Key。
- **统一限额与全量留痕**：Gateway 负责单次请求超时（默认 120 秒）和输出上限控制，并把每次真实请求与流式响应脱敏保存到 `model-trace/<id>/`。
- **可选的业务级闸门（`modelAccessPolicy`）**：对于像 Flat 这样基于“任务租约”运行的系统，Program 可以向 Gateway 注册一个同步检查回调——在每次模型请求发出前核对租约是否仍然有效，失效则立刻截断模型流。绝大多数 Program（如 Subagents、Agensh、ScaleMAS）无需配置此项；具体机制与示例见 [Flat · 公共任务池](../programs/flat/) 与 [API 参考](../reference/api/)。

## 5. 一次 Run 的标准留痕目录

所有观测数据由 Runtime 统一落盘到 `outputDir/<runId>/`，所有配置密钥与 `secretEnv` 均自动脱敏为 `[redacted]`：

```text
outputDir/<runId>/
├── runtime.json                 # 生效配置、各 Agent 停止回执、cleanup 结论
├── evidence.jsonl               # 按时间序记录的生命周期、输入接纳与事件流水
├── service-calls.jsonl          # 每次 Service 调用的完整 caller、输入、输出与错误
├── service-state.<id>.json      # 各 Service 在关闭时导出的业务状态快照（可选）
├── model-trace/<attemptId>/     # 每次真实模型调用的 request.json / response.txt / result.json
├── bots/<agentId>/
│   ├── session/                 # 完整的原生 Pi Session JSONL 历史
│   └── artifacts/files/         # 按 collect 规则导出的项目交付文件
└── environment-report.json      # Program 业务交付结果与三类独立失败结论
```

正因为这些文件采用固定结构，[Multi-Agent Trace Viewer](../../trace-viewer/) 可以无需任何额外埋点，直接读取任意一次 Run 的目录并还原完整的多智能体泳道时间轴。

继续阅读 [一次运行的完整脉络](../run-lifecycle/)，通过一个真实的双 Agent 协作场景串起所有运行原语。
