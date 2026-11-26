# Core 设计：Minimal Multi-Agent System Harness

> Phase 0005 · 本阶段目标规范 · 2026-11-23
>
> 来源：[Notion Core 设计](https://app.notion.com/p/4214e07aa023818d80cdd0a88891299c)，源修订时间 `2026-11-23T11:10:12.147Z`。
> 固定实现基线：`fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`。本文完整保留正文与 API 附录；入库不表示代码已实现或真实验证通过。

## 设计概览

murm Core 是面向开发者的 minimal multi-agent harness。它负责运行独立 Agent、提供连续输入和运行事件、落实执行隔离与能力授权。Harness 通过公开模块编写协作逻辑，组合任务池、消息、公共成果库或其他共享服务。

**文档状态：本阶段目标规范；新接口与迁移尚待实现和验收。** 本次修订对应 #255。Q1–Q8 记录首版决策，本次公共 SDK 目标按 #255 更新。精确 API 与类型见附录 A。它们尚未作为新版本实现，示例不构成真实 backend 验收证据。本阶段权威关系与变更规则见[阶段入口](README.md)。

配套阅读：[2026-11-23｜Harness 设计：Build your own swarm](02-harness.md)。本文是公共 API 的定义来源；配套文档展示五种 Harness 的装配、协作流程和验收。



## 1. 目标、范围与职责

### 1.1 已确认的产品约束

- 面向需要设计协作方式的开发者，提供稳定、可导入的模块和代码 API。
- 每个 Agent 默认拥有独立模型会话、sandbox 和私有 `workDir`；共享 Git 与具体协作设施按 Harness 需要配置。
- 模型基础工具保持 `read / write / edit / bash`；扩展能力以 Bash 命令接入。
- Harness 由开发者编写代码与配置，Core 封装资源管理、Worker 控制和内部状态。
- **Q8 已确认：一周版最低交付是 `flat + agensh + 最小开发者接入示例`，三者复用同一 Core。** `subagents / flat / Substrate / agensh / Lead-Worker` 保留为完整示例目标。
- 定向用户输入优先；全群反馈和完整交互产品暂缓。等待、唤醒与长命令托管按实际成本另行评估。**Q4 已确认：`send` 省略 mode 时默认 `steer`；调用方可显式选择 `followUp`。** 示例继续显式填写 mode，方便核对投递时机。

### 1.2 模块职责

| 范围 | Core 的职责 | Harness / Service 的职责 |
| --- | --- | --- |
| Agent 生命周期 | 身份、容量、创建、状态、输入、停止、资源回收 | 启动数量、角色、替换策略、何时结束 |
| 输入与事件 | 向指定 Agent 提交输入；回报接纳状态与执行事件 | 输入来源、收件人、合并、排序、续轮、结果回传 |
| 执行资源 | sandbox、Worker、目录准备、权限、受控导出 | 镜像、初始文件、所需网络目标、保留哪些产物 |
| Service 接入 | 注册表装配、发现、CLI、可信身份、操作权限与 schema 校验 | 数据模型、事务、记录归属、业务幂等与外部账户 |
| 运行结束 | 关闭本次 Runtime 的新工作入口，覆盖在途创建和所有 Agent | 停止 router / timer，判断业务完成，关闭自建共享设施 |

协作政策的变化应集中在 Harness 和相应 Service。新增一个 mode 不应要求 Core 增加按 mode 名称分支的逻辑，也不应要求无 Task 的 Agent 创建虚构的 Mission 或 Execution。

## 2. 系统组成与运行模型

### 2.1 核心对象

| 名称 | 定义 |
| --- | --- |
| Core | 可导入的库模块、公共类型和接口 |
| Runtime | `createRuntime` 返回的宿主对象，管理一次运行中的多只 Agent、记录与关闭状态 |
| Harness | 使用 Core 编写的宿主模块，组合 Profiles、Services、controller / router、输入和结束政策 |
| Agent | 独立身份、模型会话和私有工作目录；存活期间可连续处理输入 |
| Profile | 角色 prompt、模型、镜像、资源默认值及可调用能力的配置 |
| Service | 提供业务操作、维护业务数据的组件；可在宿主内执行，也可通过 adapter 连接外部设施 |
| Worker | sandbox 内的受信控制进程，管理 Pi 子进程、转发 RPC / 事件、执行受控文件操作 |
| Slot | 本 Runtime 的 Agent 容量单位；本稿建议 idle、exited 和清理 pending 的 Agent 继续占用 |

一个 Core 包可被多个程序使用；一个程序也可创建多个 Runtime。**本稿建议一个 Harness 运行使用一个 Runtime，里面管理多只 Agent。** 容量 `maxAgents` 属于该 Runtime；跨 Runtime 的全局调度不在首版范围内。

`Session` 指 Agent 的底层模型会话；`settled` 指一次执行收束；`Task / Execution / Mission / Material / Workspace` 保留 TaskPool 的领域含义。Workspace 专指 TaskPool 的公共 Git 项目；Agent 私有目录统一称为 `workDir`。旧容量字段 `coreId` 在迁移时改用 Slot 含义，不能与新 `Runtime.id` 混用。[现有术语](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/GLOSSARY.md)

### 2.2 执行与调用链

```mermaid
flowchart TB
  E["Harness 宿主代码"] --> R["Runtime"]
  E --> S["ServiceRegistry / Profiles"]
  S --> R
  R --> A["Pi / OpenSandbox backend"]
  A --> W["Sandbox 内 Worker"]
  W --> P["Pi 会话与基础工具"]
  P -->|"Bash CLI"| B["Bridge"]
  B --> V["Service adapter / 外部服务"]
  W -->|"事件"| R
```

Runtime、Bridge 和 Harness 在同一宿主进程内运行；业务 Service 可以在进程内或外部部署。Worker 与 Pi 位于每个 Agent 的 sandbox。当前 Worker 启动低权限 Pi 子进程，提供 `/start`、`/rpc`、`/events`、`/stop` 和受控文件入口；管理凭据不传给 Pi。协作决策与事件路由由 Harness 实现。[Worker 启动](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/services/opensandbox-agent/Dockerfile) · [Worker 实现](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/scripts/opensandbox-agent-worker.mjs)

## 3. 公开模块与装配

### 3.1 模块入口

[#255](https://github.com/LuNa-shi/murm/issues/255) 更新本阶段的 SDK 合同。npm 包 `@murm/core` 只公开根入口，JS 与 TS 的运行时导出为 `createSandbox`、`createRuntime`、`getExecutorCapabilities`、`ServiceRegistry`、`createInProcessAdapter`、`createHttpJsonAdapter`。附录 A 枚举全部基础公共类型。子路径、旧工厂/能力查询、Service 内部装配函数和应用收尾函数从包入口移除。CLI 继续通过包的 bin 安装。

### 3.2 创建 Runtime

```ts
import { createRuntime, createSandbox, ServiceRegistry } from "@murm/core";

const runtime = await createRuntime({
  sandbox: createSandbox(config.sandbox),
  executor: "pi",
  models: config.models,
  connection: config.connection,
  profiles: {
    worker: {
      prompt: "完成明确的工作，保留可检查的结果。",
      model: "default", image: config.image,
      writable: true, services: {},
    },
  },
  services: new ServiceRegistry(),
  maxAgents: 2,
  outputDir: config.outputDir,
});
```

先复制并校验 Sandbox、模型与 Profile，取得 Service Registry 的初始快照，登记内置 `agent` Service，核对模型别名、执行器能力、服务权限和可创建角色。可提前判断的错误在分配 Agent 资源前拒绝。Runtime 创建记录目录和可信连接入口，spawn 选择资源归属并分配 Sandbox。静态装配保持冻结的注册快照。[#235](../dynamic-lead-worker.md) 定义运行中对目录的受控变更。

### 3.3 配置与资源归属

| 所属 | 参数及默认值 |
| --- | --- |
| Sandbox | `kind` 默认 `opensandbox`；服务 URL 和磁盘字节/inode 上限必填；管理凭据与 endpointHost 可选；同机 `local-docker` 为唯一隔离模式且是默认值。资源默认 2 CPU、2 GiB，命令期限 120 秒，Sandbox 生命周期 3600 秒且至少 60 秒。 |
| Runtime | `executor` 默认 Pi，可显式选 Codex。非空模型表、Profiles、Services、maxAgents 和专用 outputDir 由宿主提供。模型上游为无内嵌凭据的 HTTP(S) `/v1/responses`，用 headers 携带凭据。 |
| Runtime 连接 | `connection.advertiseHost` 接收 setup/项目配置确定的同机可达 IPv4。Bridge 和网关监听地址默认 `0.0.0.0`；Bridge 默认 `http://<advertiseHost>:{port}`，网关默认用同一可达地址。可分别显式覆盖；两个目的地址均须可解析为当前支持的非 loopback IPv4 字面量。若两个可达地址都已有显式配置，可省略共同地址；无法确定时在装配阶段指出缺失字段。 |
| 模型请求 | 网关默认 120 秒；Pi 默认最多 32768 输出 token，Codex 默认保留执行器参数。显式 `null` 保留参数，数值须为不小于 16 的安全整数。 |
| Profile / spawn | Profile 选择模型别名、镜像、提示、服务权限、初始 writable、网络附加目标与产物政策；spawn 可提供父子关系、fork、文件、bindings、secretEnv 或共享挂载，以及允许的 writable/collect 覆盖。 |

`createSandbox` 校验并复制本地配置，返回不透明的接入对象。Runtime 为自己的 Agent 持有实际 Sandbox 和清理记录；在创建派发前记录原请求和服务身份，获得 ID 后按服务身份与 Sandbox ID 的组合寻址。响应丢失、查询、文件操作与删除均回原服务核对。继续遵守 [#236](https://github.com/LuNa-shi/murm/issues/236) 的资源路由与同机边界。OpenSandbox 管理凭据和模型上游 headers 留在可信宿主，Agent 仅使用自身的 Bridge/网关凭据；日志和返回对象脱敏。现有 setup/doctor/模板迁移配置来源，SDK 没有第二套 executor 或 models 值。

`getExecutorCapabilities(executor)` 同步读取静态能力，无网络、监听器和资源分配。Pi 支持上下文分支及 `all`、`one-at-a-time`；Codex 不支持分支且仅支持 `all`。两者报告 active steer、follow-up、条件输入、已排队输入清除能力。Profile 或 spawn 请求不支持的能力时前置拒绝。两个执行器继续使用各自原生 Session 归档格式。

### 3.4 模型访问与停止

Core 核验 Runtime、Agent 身份、活跃状态和模型绑定，执行通用单请求时限和配置的输出限制。开始 stop 时同步撤销该 Agent 的新请求准入，取消已准入的本地连接，再等待执行器终止、归档和删除。Runtime close 发起各 Agent 的停止，不以首个资源清理完成作为其他 Agent 撤销的前置条件。连接中止证明本地控制已生效；上游实际计算与计费由其自身执行。

Harness 为 selection、Agent、Execution、Mission 期限和主动关闭建立停止触发，周期 reconcile 补偿遗漏。TaskPool 只有看到 `execution: "stopped"` 才可结束或重新开放任务，只有 `cleanup: "complete"` 才释放原 Slot。Service caller、任务所有权、租约、fence 和提交校验继续独立执行。模型 phase、permit、`withCommit` 和 selection 专用推理配置从 SDK 移除。

## 4. Runtime API 与状态

### 4.1 公共接口索引

| API | 作用及结果 |
| --- | --- |
| `runtime.id / runtime.state` | 标识与实时只读状态 `open / closing / closed`；开始关闭即 closing，确认完整关闭后才 closed。 |
| `spawn(options)` | 分配资源，安装初始文件，启动执行器并确认就绪，返回 AgentInfo。 |
| `get(agentId) / list(filter?)` | 读取当前 Agent 信息；支持按父 ID 与状态过滤；清理中和终态均可从 `lastStop` 读取当前回执。 |
| `send(agentId, input, options)` | 唯一输入入口，返回接纳回执。 |
| `interrupt(agentId, options)` | 中断当前执行，并报告已知丢弃的排队项；保留 Agent、Session、目录与 Slot。 |
| `onEvent(handler)` | 订阅实时事件，返回取消订阅函数。 |
| `files.snapshot(agentId, options)` | 返回一致的完整或部分文件快照。 |
| `files.replace(agentId, options)` | 在完整摘要基线上安装目标树，可同时开放写入。 |
| `stop(agentId, options?)` | 停止一个 Agent，处理归档、产物与资源删除，返回 StopReceipt。 |
| `close(options?)` | 停止新工作并收尾 Runtime 登记的资源，返回 CloseReceipt。 |

先订阅再 spawn。spawn 就绪后建立 Harness 路由，再 send。接纳、执行收束、业务结果和清理各有独立判定。

### 4.2 Agent 状态

| 状态 | 含义 | 是否可 send |
| --- | --- | --- |
| starting | 已登记、预留容量，资源正在建立 | 否 |
| idle | 会话就绪且当前空闲 | 是 |
| running | 会话正在处理工作 | 是，省略 mode 默认 steer，也可显式选择 followUp |
| exited | 执行进程已退出，资源尚可能存在 | 否 |
| closing | 输入已关闭，正在收尾或等待重试 | 否 |
| closed | 所需采集和资源销毁已确认，容量已释放 | 否 |

**Q5 已确认：** `settled` 通常使 running 回到 idle，保留 Session、workDir 和 Slot；既不关闭会话，也不代表业务任务完成。意外进程退出使 Agent 进入 exited；Harness 根据事件调用 stop，或由整体 close 收尾。已处于 closing 的 Agent 发出 exit 后继续完成清理，不退回可执行状态。

Core 在调用 provider 创建资源之前分配 agentId、预留容量并登记请求。部分启动失败仍属于本次 Runtime 的资源；即使 spawn 未返回 AgentInfo，错误回执和 close 也能覆盖它。父子关系在执行任何 child 输入前登记；宿主指定 parentId 时同样校验它属于本 Runtime，且处于 idle/running。父 Agent 停止不隐含级联停止所有 child；Subagents Harness 决定树级结束，Runtime.close 覆盖整个运行。

### 4.3 错误与幂等

公共错误使用稳定 `code`、操作名与对象身份，详情包含可检查的原因。参数、权限、状态或摘要冲突在已知未执行时直接报错；外部调用已经发出而结果无法确定时报告 unknown / pending，不把连接失败等同于远端未执行。

createRuntime、spawn、files.snapshot/replace 与 send 的单次宿主等待也必须有上限；本稿统一建议默认 60 秒，底层较短的超时仍适用。到期时，replace 与 send 返回各自的 unknown 回执，其余无法确认的资源操作通过 ResourceError 报告 pending/OPERATION_UNKNOWN；这是观察上限，不是远端取消或整个 Harness 的总预算。底层重试不能无限延长这个上限。

已有 Runtime 继续接管迟到的资源结果，后续 close 覆盖它们。createRuntime 失败时尚无可用 Runtime，由工厂内部保留初始化与清理记录、接收迟到结果并收尾，通过 ResourceError 提供 pending 状态和可用的报告位置。首版资源 API 不接 AbortSignal；Harness 的取消在该有界操作返回后进入收尾。

| 错误类别 | 典型情况 |
| --- | --- |
| INVALID\_CONTRACT | 参数、Profile、manifest 或部署配置无效 |
| NOT\_FOUND / NOT\_ALLOWED | 对象不存在、跨 Runtime 或调用者无权访问 |
| CONFLICT | 容量不足、状态冲突、requestId 参数冲突或资源版本冲突；details 说明类别 |
| SERVICE\_TIMEOUT / SERVICE\_UNAVAILABLE | backend 或 Service 调用失败；是否可重试仍要结合提交状态 |
| OPERATION\_UNKNOWN | 资源变更可能已发生，需保留请求身份核对 |

请求去重键为 `runtime + caller + operation + target + requestId`。相同键与相同参数复用同一次提交，参数不同报冲突。files.replace 以 Runtime 内的 requestId 标识该次替换，目标 Agent 是绑定参数之一。send 的重试用于读取同一提交记录；unknown 在取得新证据后可以更新，但不能因此再次写入 Pi。并发 stop / close 复用同一收尾流程，后续调用可重试 pending 项。

去重必须贯穿 Core、adapter 和 Worker。现有 adapter 会在部分超时后重试，而 Worker 只缓存完成结果，存在进行中请求被再次提交的窗口；迁移时需加入进行中请求复用，或禁用未知结果的透明重投。[adapter RPC](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/agent/opensandbox-agent-adapter.js) · [Worker RPC](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/scripts/opensandbox-agent-worker.mjs)

## 5. 输入、事件与完成语义

### 5.1 输入时机

**Q4 已确认：`steer` 为 `runtime.send` 及 Agent Service `send` 的默认输入模式。** 省略 mode 与 `mode: "steer"` 等价；`followUp` 需显式指定。这里的 steer 是在 backend 可处理输入的执行边界加入，并非立即打断正在执行的 Bash，也不等于 abort/interrupt。PeerMesh 的串行 router 必须明确传 `followUp`，以保持每批输入的整轮完成边界。

| Agent 状态 | followUp | steer |
| --- | --- | --- |
| idle | 在原 Session 开始工作 | 在原 Session 开始工作 |
| running | 排队，待当前工作本来准备结束时处理 | 排队，在 backend 支持的执行边界加入当前工作 |
| starting / exited / closing / closed | 拒绝 | 拒绝 |

当前 Pi 的 steer 在工具执行边界交付，不能立即打断正在运行的长 Bash。followUp 可在同一次底层 run 中继续被消费，因此不能假定每条输入之间都有一个 settled。interrupt 单独取消当前执行和支持取消的已排队输入，保留原 Session。[Pi RPC 输入](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/rpc-commands.md) · [Pi 会话执行](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/agent-session.ts)

### 5.2 接纳与完成

- `accepted`：取得 backend 的接纳回执。`started` 表示开始执行，`queued` 表示进入队列，`handled` 表示已由扩展处理，未必产生模型执行。
- `not-accepted`：`wakeIfIdle: false` 且派发时空闲，未接纳；省略该选项则允许从 idle 唤醒。
- `unknown`：请求可能已交付，当前没有确定回执；保留 inputId，不能换 ID 自动重发。
- `settled`：当前会话执行收束。事件携带这一执行的 outcome、output 与 error 快照；`completed` 只表示执行收束成功，业务是否完成由 Harness 验收。

**本稿的最低合同不承诺每条 inputId 对应独立完成事件。** inputId 用于提交身份、去重和排查；多条输入可能被合并处理。inputId 或 requestId 均不附加到缺少归因证据的 settled。source 用于可信审计；steeringMode 只能用执行器支持的值。

需要“提交一项工作并等待”的 Harness，可在唯一输入源、初始 idle、无待消费输入和自动续轮的条件下，将一次新 send 与后续 settled 关联。这个有期限 helper 放在 Harness；PeerMesh 的串行 router 可使用该条件。多来源子结果和实时纠正不能直接套用它。实现与限制见配套 Harness 文档。

### 5.3 事件合同

| RuntimeEvent.type | 字段与来源 |
| --- | --- |
| `output` | `agentId, text`，执行器的完整助手消息。 |
| `settled` | `agentId, outcome, output?, error?`，Worker 报告本轮执行 completed / failed / aborted。 |
| `error` | `agentId, error, fatal`，执行器或运行路径的错误。 |
| `exit` | `agentId, reason, expected`，执行器退出。 |
| `agentChanged` | `agentId`，创建、就绪、忙闲、退出、关闭或可查询清理阶段改变后发出。 |
| `runtimeChanged` | Runtime 状态改变后发出。 |

Worker 收集原生事件，Core 先写入公开状态，再按处理顺序分发。重复读取同一 Worker 前缀不重复发事件，缺口仍走内部检测和诊断。每个订阅拿到独立副本，隔离同步异常及 Promise 拒绝；Core 不等待业务处理，异步刷新由应用合并或串行。订阅后读 `runtime.state` 和 `runtime.list()`，随后在变更通知时重读；先订阅再 spawn/send 可捕获快速错误或早于回执返回的输出。取消只移除该监听。若已打印 output，则按需从 settled 读取最终结果，避免重复打印。公开事件没有序号、游标、Service attempt 或回放；持久 Trace 和离线 Viewer 继续读取 Run 文件。

## 6. Profile、Service 与权限

### 6.1 Profile 的配置边界

Profile 由宿主建立并冻结。`model` 选择 Runtime 模型表中的别名；`image` 包含角色所需私有命令；`writable` 和 collect 是资源默认值；`services` 列出可调用的 Service operations。宿主 spawn 可覆盖本稿明确开放的资源参数；Agent 不能通过工作输入修改这些政策。

`Profile.env` 是宿主显式给该角色的非秘密环境变量；不会任意继承宿主环境。`SpawnOptions.secretEnv` 是宿主发给特定 Agent 使用的受限凭据。目标 Agent 能读取这些凭据；其值不进入 AgentInfo、事件和普通日志。真正的模型 upstream 凭据、Worker 管理 token 和 Core 保留字段由受信侧管理，禁止覆盖。

`Profile.network.allow` 指定额外目标；Bridge 与模型 gateway 自动加入。当前 backend 首版只接受非 loopback IPv4 字面量的 HTTP(S) origin，按目标 IP/port 放行。Gitea 同一端点的 REST 操作仍受该账户的 upstream ACL 约束，不提供 Git-only 路径限制。此能力需要修改当前只允许 Bridge 与 gateway 的网络规则。[当前网络隔离](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/runtime/docker-bot-network.js)

#### Core 启动提示与 Service 发现

Core 统一装配普通 Agent 的初始 system prompt。开头介绍隔离 Sandbox 和 `swarm` CLI，随后在 `<tools>` 中列出四项原生工具，并在 `<services>` 中列出已注册且当前 Profile 获准调用的操作。目录使用与 `swarm service list` 相同的权限过滤，显示 Service 用途、操作命令和简短说明。详细参数通过操作命令的 `--help` 或 `swarm service view <id>` 查阅。Bridge 调用仍按可信身份与当前权限校验。普通启动不注入 Pi 开发文档目录。

`Profile.prompt` 可选，默认留空。Harness 需要角色或协作说明时，Core 将其追加为 `<added_system_prompt>`。项目、Mission 或子任务通过后续 user message 发送。[已确认规范](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7163618408)

### 6.2 Service 注册与可信调用

采用 `ServiceRegistry.registerService({manifest, adapter})` 和 `adapter.invoke(request)`。注册表装配、操作发现与 Bash 入口沿用现有结构。HTTP 接入遵循同一个 ServiceAdapter 合同，由 Harness 选择和配置具体实现。新通用 manifest 的合同版本在附录 A 标为 `2`：保留操作名、schema、help、side\_effect、idempotent 与错误定义，将旧 `bound / recovery` audience 和 Task/Execution 上下文校验交还 TaskPool 兼容适配。旧 v1 manifest 必须显式转换，不能静默忽略领域授权。[Registry](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/sdk/service-registry.js) · [manifest](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/sdk/service-manifest.js)

标准调用顺序：

1. Agent 通过 `swarm <service> <operation>` 提交参数和 request-id。
2. Bridge 从当前连接恢复可信 Agent 身份，检查 Runtime / Agent 状态与 Profile 操作权限。
3. Registry 执行实际 `input_schema` 校验；仅有 schema 声明不算验证。
4. Bridge 生成 caller；Registry 完整转发到 adapter。HTTP adapter 通过受信连接传递等价上下文。
5. Service 检查记录归属、业务状态、事务与重试，返回结果；Registry 校验输出合同并将违规报告为 Service 错误。

`caller` 包含 runtimeId、agentId、profile，以及当前 Service 的 binding。bindings 是宿主预置的身份引用；Bridge 只传当前 Service 对应的一个引用，不能把其他 Service 的凭据一起暴露。输入 JSON 和 envelope 中的同名字段都不能覆盖 caller。旧 Registry 和 HTTP adapter 会重新组装请求，所以 caller 的迁移必须覆盖整条链路。[当前 adapter](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/sdk/service-adapter.js)

读操作可在其合同允许时重试；写操作的业务幂等由 Service 自己实现。schema 校验失败发生在调用前；输出校验失败可能发生在业务写入后，必须保留 operation\_id，不能因返回格式不符自动重做写操作。

### 6.3 Agent-facing 控制能力

| 操作 | Agent 可提交字段 | Core 的可信处理 |
| --- | --- | --- |
| agent spawn | profile、request-id；可选 input 与 mode，省略 mode 默认 steer | 检查 `services.agent` 和 spawnProfiles；parentId 取真实 caller；使用目标 Profile 的资源默认值 |
| agent get | agent-id | 检查同一 Runtime，目标为自己或直接 child |
| agent send | agent-id、input、request-id、可选 mode（默认 steer） | 检查同一 Runtime，目标为自己或直接 child，按 send 合同提交 |
| agent stop | agent-id、request-id | 检查目标为直接 child；返回子 Agent 的停止回执 |
| files.snapshot/replace、bindings、secretEnv、collect 覆盖 | 不通过 Agent Service 暴露 | 仅宿主 API 使用 |

Agent Service 的 spawn 是便利组合：先创建 Agent，再按指定 mode 提交初始输入；未提供 mode 时按 Q4 使用 steer，返回 `AgentSpawnReceipt`。其中 initialInput 在未提供 input 时为 null，提交后为 InputReceipt，明确拒绝时为 `{status: "rejected", error}`。输入未知或被拒绝仍保留 `agent.id`，不能把它误报成资源未创建。相同 spawn requestId 复用同一个 child 与初始输入提交，不重新创建或换 ID 重发。全局 child 事件处理器必须先安装。

动态 child 使用目标 Profile 的资源默认值，不继承 parent 的 bindings 或 secretEnv。本稿 Agent Service 不包含动态外部账户分配；需要独立外部身份的 Agent 由宿主完成账户准备并通过 spawn 注入。

首例不提供通过 agent stop 同步关闭调用者自身的语义，避免在 Bash 回执发出前杀死调用进程；既有 `agent exit` 的兼容行为留在 TaskPool adapter。宿主始终可 stop 任意本 Runtime Agent。父 Agent 权限、递归深度与资源默认值由 Profile/Harness 决定。

## 7. 文件、权限与产物

### 7.1 受管文件树

三条入口使用同一文件规范，根均为 Agent 的 workDir。初始安装在 executor 启动前完成；普通私有目录的初始 writable 由 spawn 覆盖或 Profile 给出。

| 项目 | FileTree V1 规则 |
| --- | --- |
| 普通文件与目录 | 文件由规范相对路径映射到 UTF-8 或带标准 padding 的规范 base64 字节；模式仅 0644 / 0755，省略为 0644。目录由路径派生，不表示空目录；替换删除缺失的受管文件，可清理由此变空的派生目录，含排除项的父目录保留。捕获普通文件按执行位归为 0644 / 0755，安装目标文件设置对应模式，并按实际 writable 设置属主。 |
| 路径校验 | 路径区分大小写，拒绝绝对路径、盘符绝对路径、反斜杠、NUL、空段、点段、父段、非法 Unicode、父文件冲突；路径最多 4095 UTF-8 字节且每段最多 255 字节。 |
| Core 专用位置 | Session、凭据、Worker 控制与内部安装日志位于 workDir 之外，无法通过文件路径引用。 |
| 普通隐藏文件 | `.gitignore`、`.config/app` 等普通隐藏文件按相同规则处理。TaskPool 的项目发布过滤由 Workspace Service 执行。 |
| Git 管理数据 | 任一层的 `.git` 路径保留在受管范围外。初始文件、替换输入及显式快照选择拒绝该路径；遍历时跳过；现有 Git 数据不受替换影响。独立的停止导出继续支持显式收集 Git。 |
| 链接或特殊对象 | 受管范围内拒绝软链接、硬链接、设备、FIFO 和 socket，遍历与写入均检查祖先；遇到可能越界或非受管内容阻挡的路径时在修改前拒绝。 |
| 限制 | 单文件 2 MiB、总字节 16 MiB、最多 10,000 文件。部分和完整快照均遵守这些上限，可指定更小的快照 maxBytes。超限报错，禁止截断或将漏项作为删除依据。 |

摘要为 SHA-256，输入是按路径以 JS 字符串默认比较排序的 JSON 数组，每项是 `[path, numericMode, sha256(bytes)]`，内部哈希用小写十六进制，外部哈希计算 UTF-8 JSON，无空白。完整摘要格式为 `complete:sha256:<hex>`，部分为 `partial:sha256:<hex>`。编码不同但路径、字节、模式相同的目标等价。只在 paths 的规范选择为整根（含 `.`）时给完整摘要，部分就算恰巧读取了全部文件也只能得到部分摘要。快照保留单调捕获序号 `version` 用于诊断，替换只比较摘要。

M0 验收 fixture 使用如下初始树和在线目标。其余对象由测试从实际工作目录种入。

| 工作目录内容 | 初始树 / 完整快照 | 在线替换目标及预期 |
| --- | --- | --- |
| `README.md`，字节 `old\n`，0644 | 包含 | 更新为 `new\n` |
| `bin/run`，字节 `run\n`，0755 | 包含 | 相同字节改为 0644，摘要改变 |
| `.config/local`，字节 `x` | 包含 | 省略即删除 |
| `.gitignore`，字节 `out\n` | 包含 | 保留；用 base64 提供时等价 |
| `data.bin` | 初始缺失 | 新增字节 `00 ff`（base64 `AP8=`） |
| `.git/config` 与 `nested/.git` | 不进入树；直接请求拒绝 | 安装前后 Git 对象保持 |
| `empty/` | 不表示 | 摘要不含该目录 |
| `outside` 软链、硬链、FIFO；独立负例 | 完整捕获拒绝 | 无静默遗漏或跟随；部分选择隔离于该对象仍可成功 |
| `../escape`、`/rooted`、`a` 与 `a/b`；独立负例 | 输入拒绝 | 初始与在线使用同一校验 |

另核对恰好达到每个限制的 fixture 与超限一个字节/文件的负例，以及只选 `README.md` 后以部分摘要尝试替换无副作用。上述 fixture 的好路径同时覆盖只读保持、开放写入与同 Session 在线更新。

### 7.2 一次文件替换与 Workspace 协议

`snapshot` 在 Worker 控制的安全边界采集一致树；同 ID 和相同选择返回原捕获。无安全窗口时返回 busy，读操作结果未知时用原身份核对。共享项目可按已有模式挂载；必须证明采集窗口覆盖全部写者，否则返回 busy。`replace` 对任意共享项目拒绝，私有只读和私有可写项目均可替换。

`replace` 在当前 Runtime 内先按该操作的 requestId 查找既有请求，再核对 Agent、完整 expectedDigest、规范目标树和 `writable`；同 ID 改参报 CONFLICT。新操作在 Worker 控制下确认没有不安全的活跃写者、打开文件或阻塞目录，捕获完整摘要并和 expectedDigest 比较，再按完整目标执行新增、删除、字节与模式更新。省略 `writable` 保持现状，`true` 在安装验证后开放写入，不接受 `false`。Core 验证字节、文件模式和真实权限后记录结果，恢复自身持有的执行控制，才确认 completed。Agent 和 Session 保持原身份。版本不匹配报 CONFLICT，安全窗口不可取得报 WORKSPACE_BUSY，均发生于修改前。

修改中失败且旧文件、权限和执行控制已确认恢复后，返回 `failed`，保存失败回执。已经派发、超时或无法确认安装、回滚、权限或释放状态时返回 `unknown`，保留原 Worker 记录和未解除的控制，拒绝冲突操作；同 ID 先核对或继续原操作。安全条件不能恢复时由宿主 stop/close 收尾。确认结果后重复原请求只返回该次回执，即使 Agent 已继续写入也不覆盖。停止/替换竞争时缺少确定证据即保持 unknown。Worker 在就绪检查中声明新文件控制协议；缺少支持时在文件修改前以 INVALID_CONTRACT 拒绝并指明所需协议和检测到的版本，Core 不尝试旧阶段操作。幂等范围是活 Runtime，宿主崩溃后不承诺自动恢复。

Workspace Service 先固定版本、合并并记下 pending 意图，保存原 Core 请求与可重建的目标。Core 返回 completed 后，Service 再持久化版本、parents、冲突和来源。文件完成而业务记录失败时，用原回执向前完成记录；期间互锁冲突 save/apply 和依赖状态的 finish，保留同一业务请求身份。TaskPool 的初次只读交接在开放写入前确立可信 Execution 归属与 fence，失败或未知保留归属直到确认停止。TaskPool 具体流程见 [Harness 设计](02-harness.md#63-运行流程与关键接线)。

### 7.3 收尾采集

Agent 默认使用私有 workDir。跨 Agent 成果可经 Git、Service 或显式 artifact 交接；现有共享只读/可写挂载仍可显式配置，不能用于在线 replace。

collect 在分配资源前登记并在 Agent 生命周期内固定，所有 stop/close 路径使用同一政策。paths 相对于 workDir；includeGit 明确是否包含 Git 历史；maxBytes 是硬上限；required 指定失败是否阻止资源删除。省略 collect 时仅保留 Core 运行记录，不承诺私有目录中的文件会自动保存。

includeGit 与 paths 的组合应得到可解释的归档清单；超限或文件缺失明确报告，不截断后宣称成功。导出在 Agent 进程停止后由仍存活的 Worker 执行，结果写到本次 outputDir 的 Agent 子目录。启动凭据置于进程环境或受信位置，不作为普通 FileTree 内容 混入 workDir；Agent 自行写入工作目录的内容仍属于其文件，不能声称归档会自动识别并删除所有秘密。

现有 Workspace snapshot 排除 `.git`，要求 ACTIVE Execution，并有限额；新的 Agent 收尾导出必须有独立的 Agent 资源授权，支持 closing 状态。[当前 snapshot](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/scripts/sandbox-project.mjs)

## 8. 停止、关闭与记录

应用自行组织业务结论、产物校验和设施回收；仓内宿主可以复用内部 finalizer。公共 SDK 以 stop/close 回执交付 Core 的结果。外部服务及其已有数据由外部 owner 持有，Runtime 自有资源按原归属收尾。

### 8.1 停止执行、保存成果、删除运行环境

**Q6 已确认：如果事先标记为 required 的成果导出失败，停止 Agent 执行后保留对应 sandbox 与 Slot，报告 cleanup=pending，允许后续排查和重试。** 可选采集失败仍按相应政策清理，不代表所有错误都无限保留容器。

以 PeerMesh 为例：Agent 的私有目录里可能有尚未提交的代码，也可能有已经 commit、尚未 push 到 Gitea 的提交。结束本次运行时，需要把事先指定要保留的这些成果保存到 sandbox 外，再删除运行环境。

正常收尾按以下顺序执行：

1. 目标 Agent 进入 closing，同步关闭新工作与模型请求入口，取消本地在途模型连接，再停止执行和相关命令。
2. 确认执行终止后保留受控 Worker 连接，归档原生 Session，按 collect 保存指定文件与 Git 历史，记录产物位置和错误。
3. 必需归档和产物保存完成后删除 Sandbox。确认删除及该 Agent 所需资源清理后释放 Slot。

collect.required 表示 Harness 在启动前声明“这些成果必须保存”。**已确认：如果 Agent 已停止，但原生 Session 或 required 成果没有保存成功，就暂时保留该 sandbox 和 Slot，报告失败原因，排查后可重试 stop/close。** 好处是避免直接删除尚未保存的成果；代价是该资源和容量暂时不能释放，可能影响后续 Agent 启动。保留现场的范围与期限由宿主后续处置，首版不增加自动恢复系统。

已推送到共享 Git、已写入公共 Service 的数据按 Harness 的保留政策处理。本节主要解决仍在 Agent 私有目录中的成果。可选采集失败会保留错误记录，并允许继续销毁；若连 Agent 是否已停止都无法确认，则记录 execution=unknown，不能按“已停止”释放领域工作。

当前 kill、session.stop 和 manager.stopAgent 会分别触发删除或释放 Worker 连接。迁移时将这些动作拆开，由 Runtime 唯一组织停执行、导出、销毁，防止外层采集之前底层已删除资源。[adapter 停止](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/agent/opensandbox-agent-adapter.js) · [manager 停止](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/runtime/opensandbox-manager.js)

### 8.2 有期限的 close

关闭操作的等待时间有上限，避免一次保存或删除故障让宿主程序一直卡住。stop/close 的 timeoutMs 必须为正且有限；省略时以 60 秒为单次宿主等待上限。时间到了就返回当前进度与未完成项，后续可以检查原因并重试；超时本身不表示操作已经成功，也不表示远端请求已取消。

回执中的状态分别回答两个问题：

| 字段与值 | 含义 |
| --- | --- |
| execution=stopped | 已确认 Agent 和相关执行停止；成果保存或资源删除仍可能未完成 |
| execution=unknown | 暂时无法确认是否已经停下，例如没有取得远端回执 |
| cleanup=complete | 必须保存的成果与资源清理已按约定完成 |
| cleanup=pending | 收尾尚未完成；可能卡在保存成果，也可能卡在删除资源，报告须写出具体原因 |

Core 继续保存已发出的请求及待处理资源身份，迟到的创建结果仍纳入收尾。进程崩溃后的自动恢复不属于本稿最低保证，记录需支持人工核对。

close 先关闭本 Runtime 的新 spawn/send/resource 请求，再收尾登记 Agent 与在途创建；即使部分失败也汇总其他对象的结果。CloseReceipt 的 cleanup 同时覆盖 Agent、Bridge、内部模型入口和 backend 资源。普通清理失败以回执报告；意外异常也不能使 Harness 丢失原始业务错误。

Harness 先停新事件与续轮，取消未提交工作；所有异步等待都有期限或 AbortSignal。Runtime.close 返回后，Harness 根据回执结束剩余等待并保存业务结果、cleanup 与清理异常，再关闭自己拥有的 Service。未知执行状态所需的依赖保留并记录；不靠一次 exit 事件推断全部资源已释放。

### 8.3 可检查记录

outputDir 为本 Runtime 的独立记录位置，保存配置摘要、Agent/父子身份、输入来源与 requestId、事件、Service 调用结果索引、产物清单和清理回执。环境变量和凭据按用途脱敏，不记录 secretEnv 值。

ResourceError 在已创建身份时提供 runtimeId/agentId/requestId，并尽量提供 reportPath；若 outputDir 本身无法建立，错误必须直接携带 details，不能声称日志已落盘。清理 pending 的原因和下一步所需对象可以从报告定位。永久超限等错误不应靠无限自动重试解决；调整导出或放弃产物属于显式宿主处置。

## 9. 实现迁移与证据

固定核查基线：murm `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`；Pi 1.3.0 / `71023aec1546d6d677a65669c5665c0927ce0dd0`。这里说明可复用部分和必须迁移的行为，不表示新 API 已存在。

| 当前模块 | 迁移目标 | 重点约束 |
| --- | --- | --- |
| Runtime / TaskService Agent 登记 | 通用身份和资源进入 Runtime；领域关联留 TaskPool | 不重复维护两套资源生命周期；保留在途启动与 shutdown 追踪 |
| Pi / OpenSandbox adapter | backend 内部 | 暴露统一接纳回执、事件、退出；保留同一 Session |
| AgentModelAccess / ResponsesBudgetGateway | Core 负责模型身份与停止撤销，TaskPool 负责期限触发 | 通用请求限制与业务提交的 lease/fence 独立核验 |
| Bridge / Registry / adapters | 通用 Service 接入 | caller 贯穿整条链；执行 schema 校验；v1 TaskPool 授权显式兼容 |
| agent contract / Worker 资源校验 | Profile 装配 | 受信资源与镜像验证保留；角色 prompt 可配置 |
| sandbox-project / manager | 完整树替换与独立收尾导出 | Core 持有文件回执，Service 持有领域版本与授权 |
| public/secret env 过滤 | 显式宿主配置 | 保留键不能覆盖；合入 Git token 的位置不能再被旧 allowlist 删除 |
| DockerAgentNetwork / 磁盘隔离 | 当前 backend | 保留本地身份校验，增加 Profile 端点；拒绝未支持部署 |
| Task loop / controller / notification / watchdog | TaskPool Harness | 选工、续轮、stall 判断与 Task 完成规则不进入 Core |
| kill / session.stop / stopAgent | 统一 stop/close | 停执行、导出、销毁拆开；删除只有一个组织入口 |

源码入口：[Runtime](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/runtime/runtime.js)、[模型访问](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/agent/bot-model-access.js)、[Service Bridge](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/agent/services-bridge.js)、[Profile](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/agent/capability-profile.js)。

## 10. 验收与待确认项

### 10.1 Core 完成标准

| 验收 | 必须观察到的结果 |
| --- | --- |
| 无 Task 启动 | 不建立 Mission/Execution 即可创建 Agent、调用模型并使用自定义 Service |
| 连续输入 | 同一 Agent 两次工作共享 Session/workDir；默认 steer 与显式 followUp 的接纳、执行边界正确 |
| 权限 | Profile 不允许的操作被拒，caller 不可伪造；子 Agent 不能覆盖宿主资源政策 |
| 文件交接 | TaskPool 先确立任务归属，再替换文件并开放写入；在线更新与 pending 恢复保留同一 Agent |
| 请求重试 | 回执延迟或丢失不会导致同一 input 重复提交 |
| 事件与结束 | 快速完成、fatal、意外 exit、宿主取消均有确定报告；不无限等待 |
| 资源收尾 | 部分创建失败、创建与关闭并发、必需导出失败均无未登记资源或提前删除 |
| 仓库外使用 | 独立目录导入 Core，注册自定义 Service 与 Harness，不修改 Core 内部代码 |

**Q8 首版验收以 `flat + agensh + 最小开发者示例` 为准。** 其中 PeerMesh 必须有两个 peer 的实际协作闭环，最小示例必须从仓库外导入 Core 并能调用自定义 Service。上述验收门槛仍须在实施后真实运行；文档审阅、类型核对与局部检查不能替代真实 backend 验收。

### 10.2 已确认的产品决策与待实施合同

2026-11-23 用户已确认 Q1–Q8，首版范围和外部可见行为以此为准。下面的精确新类型、manifest v2、故障注入及 backend 迁移仍是需要实现和测试的工程合同，并非已经有真实代码支持。

| 决策 | 已确认的选择 |
| --- | --- |
| Q1 底层 Agent | A：首版仅 Pi + OpenSandbox；内部保留 backend 边界，不公开多执行器插件 |
| Q2 运行中配置 | A：Profile 与 Service 启动前注册并冻结；允许按已有 Profile 动态创建 Agent |
| Q3 文件共享 | 首版默认独立 Sandbox/workDir，通过 Git/Service/显式 artifact 协作；现有显式共享挂载按 §7 保留 |
| Q4 输入默认值 | B：默认 steer；显式 followUp 可用，PeerMesh 串行 router 选择 followUp |
| Q5 idle 状态 | A：Session/workDir/Slot 持续保留，直到明确 stop |
| Q6 导出失败 | A：预先标为 required 的成果导出失败时保留 sandbox/Slot 并报告 pending |
| Q7 PeerMesh 范围 | A：验证 Git/PR、peer message、共享上下文与事件续轮核心闭环；不要求首版完整复现原版细节 |
| Q8 首版完成标准 | A：TaskPool + PeerMesh + 最小开发者接入示例，实际运行通过验收；其他三个 mode 后续交付 |

### 10.3 尚待实现的接口细节与后续扩展

| 项目 | 当前状态与本稿推荐 |
| --- | --- |
| 产品方向、四个基础工具、稳定模块、Harness 编写代码 | 已确认；保留 |
| 一周最低 TaskPool + PeerMesh，五种累计目标 | 已确认 PeerMesh 为第二个验收案例；其余三种模式按各自验收累计交付 |
| 同进程库 + 一个 Runtime 管理一次运行的多只 Agent；公共 API、Service v2 与当前 backend 合同 | 首版按本文接口方案实施；具体签名、compat 与异常路径须在类型测试及真实联调中核验，不把提案当作现有实现 |
| 输入时机 | Q4 已确认省略 mode 默认 steer；允许显式 followUp。每个 inputId 的独立完成关联仍未纳入首版最低合同 |
| 结束运行与成果保存 | Q6 已确认：先停执行，再导出 required 成果，成功后删除 sandbox；required 导出失败保留资源。有限等待、实际报告 unknown/pending 作为正确性合同；超时具体数值由实现配置 |
| 扩展范围 | interrupt、通用 wait/wake、长命令托管、运行时 Profile/Service 变更另行评估 |

### 10.4 尚未解决的实质性工程问题

以下不是新增产品 A/B 决策，而是已经确定首版方向后必须实现、验证的技术闭环。若其中一项无法达到合同，实施时须报告影响并回到设计评审，不得默认为已解决。

| 尚未完成的交接 | 风险与完成条件 |
| --- | --- |
| 无 Task 的模型访问与 TaskPool 兼容 | Harness 期限触发停止；无 Task Agent 可调用模型；Core 停止撤销与 TaskPool 的 lease/fence/业务提交分别通过回归 |
| Service 身份及 v1/v2 兼容 | caller 在 Bridge→Registry→in-process/HTTP adapter 中不丢失；schema 校验实际执行；TaskPool 原领域授权不能因升级 manifest 被绕过 |
| send 幂等和事件边界 | Pi/Worker/adapter 对同一在途 requestId 不重复投递；accepted 不能被误认为执行完成；PeerMesh 串行批次的 followUp 与 settled 在真实运行中正确关联 |
| TaskPool 的文件交接与关闭竞争 | Task 认领、在线 replace、租约失效和 runtime.close 并发不出现越权写入或双 owner；替换与 Service 提交分别恢复 |
| 受限导出与 pending 处置 | 拆开 stop、导出和 sandbox 删除；能保存未 push Git 历史及未提交文件；required 导出失败保留现场；关闭后能根据报告发现与人工处置残留资源 |
| 仓库外开发者入口 | 新包 API 与类型实际可用，独立目录中的最小示例可以注册自己的 Service、驱动 Agent 两轮并取得产物和清理回执 |

### 10.5 本轮交付边界

2026-11-24 owner 确认的[本轮范围调整](README.md#2026-11-24-owner-确认的本轮范围调整)将 #197 的生产 live capture 接线及五种 Example 的统一符合性核对延后。该限定不新增 `Runtime.files.snapshot` 等公共接口，不把 #196 草稿视为已批准合同；本章其余 Core 权限、文件准备、停止后导出和实际验收合同继续适用。

Q1–Q8 已批准为首版产品决策；上述工程合同仍需实现与验收。本次将两篇设计及推进计划纳入仓库，作为本阶段权威规范；合入 main 后据固定文档版本建立总 issue 与分阶段执行 issues。需求变更先更新本目录，再同步受影响任务。

## 附录 A：公共类型清单

下列声明是 #255 的基础 SDK 目标清单。代码只从根入口显式导出这些名称。#235 生效时另按其固定合同加入动态管理成员及必要类型，仍经同一根入口与事件入口。

```ts
declare const sandboxBrand: unique symbol;
export interface Sandbox {
  readonly [sandboxBrand]: true;
}

export interface SandboxConfig {
  kind?: "opensandbox";
  lifecycleBaseUrl: string;
  apiKey?: string;
  execdToken?: string;
  endpointHost?: string;
  resourceLimits?: { cpu: string; memory: string };
  commandTimeoutMs?: number;
  timeoutSeconds?: number;
  isolation: {
    network?: "local-docker";
    disk: { bytes: number; inodes: number };
  };
}

export type ExecutorKind = "pi" | "codex";
export type SteeringMode = "all" | "one-at-a-time";
export interface ExecutorCapabilities {
  readonly activeSteer: boolean;
  readonly followUp: boolean;
  readonly conditionalInput: boolean;
  readonly queuedInputCancellation: boolean;
  readonly contextFork: boolean;
  readonly steeringModes: readonly SteeringMode[];
}

export interface ModelConfig {
  provider: string;
  model: string;
  upstream: { url: string; headers: Readonly<Record<string, string>> };
}

export interface RuntimeConnectionOptions {
  advertiseHost?: string;
  bridge?: { host?: string; publicUrl?: string };
  modelGateway?: {
    host?: string;
    advertiseHost?: string;
    requestTimeoutMs?: number;
    maxOutputTokens?: number | null;
  };
}

export interface CreateRuntimeOptions {
  sandbox: Sandbox;
  executor?: ExecutorKind;
  models: Readonly<Record<string, ModelConfig>>;
  connection?: RuntimeConnectionOptions;
  profiles: Readonly<Record<string, Profile>>;
  services: ServiceRegistry;
  maxAgents: number;
  outputDir: string;
}

export declare function createSandbox(config: SandboxConfig): Sandbox;
export declare function createRuntime(options: CreateRuntimeOptions): Promise<Runtime>;
export declare function getExecutorCapabilities(executor: ExecutorKind): ExecutorCapabilities;

export interface Profile {
  /** Optional Harness instructions added to the standard startup prompt. */
  prompt?: string;
  model: string;
  image: string;
  writable: boolean;
  services: Readonly<Record<string, readonly string[]>>;
  spawnProfiles?: readonly string[];
  allowContextFork?: boolean;
  env?: Readonly<Record<string, string>>;
  network?: { allow: readonly string[] };
  collect?: CollectionSpec;
}

export interface FileEntry {
  readonly encoding: "utf8" | "base64";
  readonly data: string;
  readonly mode?: 0o644 | 0o755;
}
export type FileTree = Readonly<Record<string, FileEntry>>;
export type CompleteFileDigest = `complete:sha256:${string}`;
export type PartialFileDigest = `partial:sha256:${string}`;

export interface FileSnapshotOptions {
  requestId: string;
  paths: readonly string[];
  maxBytes?: number;
}
export interface CompleteFileSnapshotOptions extends FileSnapshotOptions {
  paths: readonly ["."];
}
export interface CompleteFileSnapshot {
  readonly agentId: string;
  readonly requestId: string;
  readonly version: number;
  readonly files: FileTree;
  readonly scope: "complete";
  readonly digest: CompleteFileDigest;
}
export interface PartialFileSnapshot {
  readonly agentId: string;
  readonly requestId: string;
  readonly version: number;
  readonly files: FileTree;
  readonly scope: "partial";
  readonly digest: PartialFileDigest;
}
export type FileSnapshot = CompleteFileSnapshot | PartialFileSnapshot;

export interface FileReplaceOptions {
  requestId: string;
  expectedDigest: CompleteFileDigest;
  files: FileTree;
  writable?: true;
}
export type FileReplaceReceipt = {
  readonly agentId: string;
  readonly requestId: string;
} & (
  | { readonly status: "completed"; readonly digest: CompleteFileDigest; readonly writable: boolean }
  | { readonly status: "failed"; readonly error: ErrorInfo }
  | { readonly status: "unknown" }
);

export interface CollectionSpec {
  paths: readonly string[];
  includeGit: boolean;
  allowMissingGit?: boolean;
  maxBytes: number;
  required: boolean;
}

export interface WorkspaceOptions {
  id: string;
  mode: "read-only" | "read-write";
}

export interface SpawnOptions {
  requestId: string;
  profile: string;
  forkFrom?: string;
  parentId?: string;
  writable?: boolean;
  files?: FileTree;
  bindings?: Readonly<Record<string, string>>;
  secretEnv?: Readonly<Record<string, string>>;
  workspace?: WorkspaceOptions;
  collect?: CollectionSpec;
}

export interface ErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ResourceError extends Error {
  code: string;
  operation: string;
  runtimeId?: string;
  agentId?: string;
  requestId?: string;
  cleanup: "complete" | "pending";
  reportPath?: string;
  details: readonly ErrorInfo[];
}

export type AgentStatus = "starting" | "idle" | "running" | "exited" | "closing" | "closed";

export interface AgentListFilter {
  parentId?: string | null;
  status?: AgentStatus | readonly AgentStatus[];
}

export interface AgentInfo {
  id: string;
  profile: string;
  parentId?: string;
  status: AgentStatus;
  latestOutput?: string;
  lastError?: ErrorInfo;
  lastStop?: StopReceipt;
}

export type RuntimeState = "open" | "closing" | "closed";
export type InputMode = "steer" | "followUp";
export interface SendOptions {
  requestId: string;
  mode?: InputMode;
  source?: string;
  steeringMode?: SteeringMode;
  wakeIfIdle?: boolean;
}
export type InputReceipt =
  | { inputId: string; status: "accepted"; disposition: "started" | "queued" | "handled" }
  | { inputId: string; status: "unknown" };
export type ConditionalInputReceipt =
  | InputReceipt
  | { inputId: string; status: "not-accepted"; reason: "idle" };

export type AgentInitialInputResult =
  | InputReceipt
  | { status: "rejected"; error: ErrorInfo }
  | null;
export interface AgentSpawnReceipt {
  agent: AgentInfo;
  initialInput: AgentInitialInputResult;
}

export interface InterruptOptions {
  requestId: string;
  timeoutMs?: number;
}
export interface InterruptReceipt {
  interruptId: string;
  status: "interrupted" | "unknown";
  discardedInputHashes?: readonly string[];
}
export interface StopOptions { timeoutMs?: number }
export interface CloseOptions { timeoutMs?: number }

export type RuntimeEvent =
  | { type: "output"; agentId: string; text: string }
  | { type: "settled"; agentId: string; outcome: "completed" | "failed" | "aborted"; output?: string; error?: ErrorInfo }
  | { type: "error"; agentId: string; error: ErrorInfo; fatal: boolean }
  | { type: "exit"; agentId: string; reason: string; expected: boolean }
  | { type: "agentChanged"; agentId: string }
  | { type: "runtimeChanged" };

export interface PendingCleanup {
  kind: "agent" | "bridge" | "model" | "backend" | "report";
  id: string;
  action: "await-startup" | "stop-execution" | "archive-session" | "collect-artifacts" | "delete-sandbox" | "close" | "save";
  error?: ErrorInfo;
  resourceKey?: string;
  providerId?: string;
  sandboxId?: string;
  creation?: "created" | "pending" | "absent";
  executionStopped?: boolean;
}

export interface StopReceipt {
  agentId: string;
  execution: "stopped" | "unknown";
  cleanup: "complete" | "pending";
  artifacts: readonly string[];
  sessionArchive?: string;
  errors: readonly ErrorInfo[];
  pending?: PendingCleanup;
}

export interface CloseReceipt {
  agents: readonly StopReceipt[];
  cleanup: "complete" | "pending";
  errors: readonly ErrorInfo[];
  pending: readonly PendingCleanup[];
  outputDir: string;
  reportPath?: string;
  evidence: { path?: string; recorded: number; lost: number; pending: number };
}

export interface RuntimeFiles {
  snapshot(agentId: string, options: CompleteFileSnapshotOptions): Promise<CompleteFileSnapshot>;
  snapshot(agentId: string, options: FileSnapshotOptions): Promise<FileSnapshot>;
  replace(agentId: string, options: FileReplaceOptions): Promise<FileReplaceReceipt>;
}
export interface Runtime {
  readonly id: string;
  readonly state: RuntimeState;
  spawn(options: SpawnOptions): Promise<AgentInfo>;
  get(agentId: string): Promise<AgentInfo>;
  list(filter?: AgentListFilter): Promise<AgentInfo[]>;
  send(agentId: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>;
  send(agentId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>;
  interrupt(agentId: string, options: InterruptOptions): Promise<InterruptReceipt>;
  onEvent(handler: (event: RuntimeEvent) => void | Promise<void>): () => void;
  stop(agentId: string, options?: StopOptions): Promise<StopReceipt>;
  close(options?: CloseOptions): Promise<CloseReceipt>;
  readonly files: RuntimeFiles;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ServiceManifest {
  id: string;
  title: string;
  purpose: string;
  provider_version: string;
  contract_version: "2";
  endpoint: { transport: "in-process" } | { transport: "http-json"; url: string };
  capabilities: readonly ServiceCapability[];
}

export interface ServiceCapability {
  name: string;
  operation: string;
  description: string;
  side_effect: "read" | "write";
  idempotent: boolean;
  help: { when: string; ref?: string };
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  errors: readonly { code: string; retryable: boolean }[];
  path?: string;
  /** Host-registered invocation deadline, 1..86400000 ms. Defaults to 30000. */
  timeout_ms?: number;
}

export interface ServiceCaller {
  runtimeId: string;
  agentId: string;
  profile: string;
  binding?: string;
}

export interface ServiceRequest {
  manifest: ServiceManifest;
  capability: ServiceCapability;
  input: JsonValue;
  envelope: { operation_id: string; [key: string]: unknown };
  caller: ServiceCaller;
  signal: AbortSignal;
  /** Recheck caller authority immediately before a Service commits its side effect. */
  assertAuthorized(): void;
}

export interface ServiceAdapter {
  invoke(request: ServiceRequest): JsonValue | Promise<JsonValue>;
  /** Optional bounded host-only snapshot called during Runtime close. */
  exportState?(options: { signal: AbortSignal }): JsonValue | Promise<JsonValue>;
}

export interface ServiceRegistration {
  manifest: ServiceManifest;
  adapter: ServiceAdapter;
}
export interface HttpJsonAdapterOptions {
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
export declare class ServiceRegistry {
  registerService(registration: ServiceRegistration): void;
}
export declare function createInProcessAdapter(implementation: ServiceAdapter): ServiceAdapter;
export declare function createHttpJsonAdapter(options?: HttpJsonAdapterOptions): ServiceAdapter;
```

## 附录 B：输入参考与设计依据

| 参考接口 | 可核实的输入行为 | 本稿的使用方式 |
| --- | --- | --- |
| Pi 1.3.0 prompt | followUp 排队继续；steer 在执行边界加入；RPC preflight 早于整轮完成 | 复用底层能力，区分接纳与执行收束 |
| Codex v1 send\_input | 默认 interrupt=false，但仍走 start-or-steer；true 先中断 | 不按名称推断它等于 Pi followUp |
| Codex app-server | turn/steer 带 expectedTurnId；turn/start 与 interrupt 分离 | 为未来更强的目标轮次校验提供参考 |
| Codex v2 | send\_message 不唤醒 idle；followup\_task 可开启新 turn；busy 时均可及时交付 | 保持消息存储与执行触发的区别 |
| Claude Agent SDK | next 在工具边界，later 等当前 turn；now 有条件地中断或转后台 | 仅作官方 SDK 语义参照，不声称核验了 Claude Code 内部调度 |

Claude 的后台转移还依赖 human origin、版本与工具支持。其输入 uuid / result.user\_message\_uuids 可关联合并输入；Pi 适配若要提供同类保证，需要额外实现，不能直接从 settled 推导。

来源：[Pi RPC](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/modes/rpc/rpc-mode.ts)、[Codex send\_input](https://github.com/openai/codex/blob/a1604a8c0554c09c1be45e5a121bb1889b4d9a50/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs)、[Codex 控制](https://github.com/openai/codex/blob/a1604a8c0554c09c1be45e5a121bb1889b4d9a50/codex-rs/core/src/agent/control.rs)、[Codex v2](https://github.com/openai/codex/blob/a1604a8c0554c09c1be45e5a121bb1889b4d9a50/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)、[Claude 输入指南](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[Claude SDK 类型](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage)。

库与运行对象的装配参考：[Pi SDK](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/sdk.ts)、[Codex TypeScript SDK](https://github.com/openai/codex/blob/a1604a8c0554c09c1be45e5a121bb1889b4d9a50/sdk/typescript/src/codex.ts)。Managed Agents 保留为后续托管能力的接口参照，当前验收以本文的独立运行和可替换协作为准。[Managed Agents](https://www.anthropic.com/research/managed-agents)

## 附录 C：已确认约束与修订记录

下表保留原决策 ID，方便核对已确认约束。它记录产品与评审要求，不将本稿新增的具体签名标为已批准。

| ID | 已确认内容 |
| --- | --- |
| D1 | 面向开发者的 minimal multi-agent harness，支持 build your own swarm |
| D2 | 一周内至少形成一版，优先整理现有实现 |
| D3 | 示例名称固定为 Subagents / TaskPool / Substrate / PeerMesh / Lead-Worker |
| D4 | 四个基础工具 read/write/edit/bash，扩展经 Bash 接入 |
| D5 | Core 承载 Agent 运行和执行控制，按 Profile 配置能力与权限 |
| D6 | 每种 Harness 写清配置、Service、启动、workflow、输入、结束与清理 |
| D7 | 优先明确接收者的用户输入；全群反馈、Mission 热更新与完整交互产品暂缓 |
| D8 | 等待/唤醒与长命令按实现成本评估，具体支持范围另定 |
| D9 | 用户决策与作者提案分开记录，术语统一，表达简洁 |
| D10 | 首版最低 TaskPool + PeerMesh 共用 Core；用户已选定 PeerMesh 为第二个案例，五种完整目标保留 |
| D11 | Core 优先，接口明确后各 Harness 可并行开发；“前三天形成 Core”为期望节点，非已完成承诺 |
| D12 | 关键设计经用户确认并核对后进入执行；此前采用每轮 3–4 项的讨论方式 |
| D13 | Core 以多个组件/模块及稳定代码 API 对外 |
| D14 | Core 封装可由自己管理的运行内部细节 |
| D15 | 前一阶段默认值待定；本轮 Q4 已决定默认 steer，仍允许显式 followUp（后续决策覆盖前一未定项） |
| D16 | 提供具体接口、模块关系和 Harness 使用示例，再批准实施细节 |

修订记录：2026-11-23 Q1–Q8 全部确认；明确首版 Pi/OpenSandbox、配置冻结、私有 workDir、默认 steer、idle 持有资源、required 导出失败保留现场、PeerMesh 核心闭环与 TaskPool+PeerMesh+最小示例交付。此前将对话式章节重排为架构、API、生命周期、迁移与验收；统一 spawn/send、事件结果、Service 身份与文件合同；补齐模型访问的 Task 依赖、原生 Git 凭据接入和有期限收尾。Worker 命名沿用当前执行组件，旧 Sidecar 命名背景移出正文。2026-11-23 用户进一步要求先通过文档 PR 入库 main，再按本阶段权威设计建立总 issue 与执行 issues；此前“暂不创建 issue”的操作状态由本次要求替代。
