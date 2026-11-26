# Harness 设计：Build your own swarm

> Phase 0005 · 本阶段目标规范 · 2026-11-23
>
> 来源：[Notion Harness 设计](https://app.notion.com/p/4214e07aa023813e9e5bdeb3dc7b3e32)，源修订时间 `2026-11-23T11:10:13.849Z`。
> 固定实现基线：`fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`。本文完整保留五种模式、Notes 示例和输入等待 helper；代码示例是目标接口用法，不是已发布实现。

## 设计概览

Harness 是开发者使用 murm Core 编写的协作程序。它决定哪些 Agent 参与、共享什么、何时继续工作、怎样处理反馈，以及什么结果算完成。Core 提供稳定的执行与接入能力；Harness 将这些能力组织成自己的多智能体系统。

**文档状态：本阶段目标规范；新接口与各模式尚待实施和验收。** 更新：2026-11-23。Q1–Q8 已确认；新的包入口、Runtime API 和示例代码属于目标合同，尚未在真实 backend 完成迁移验收。本阶段权威关系与变更规则见[阶段入口](README.md)。公共类型与底层保证统一定义在 [2026-11-23｜Core 设计：Minimal Multi-Agent System Harness](01-core.md)；本文说明它们的用法与各模式的运行规则。

首次阅读可先看第 1–4 节，再选择第 5–9 节中的一种模式。完整宿主示例与有期限的输入等待放在附录，便于需要接入时逐项核对。



## 1. 目标与交付范围

本方案面向需要定义或修改协作机制的开发者。Harness 使用普通 JS/TS 代码组合 Profiles、Services、controller / router 和结束政策，不要求把协作方式限制成固定配置模板。

**Q8 已确认：首版最低交付为 TaskPool + PeerMesh + 最小开发者接入示例，三者共用同一套 Core。** PeerMesh 是第二个正式 mode；其余 Subagents、Substrate、Lead-Worker 保留完整目标，后续累计交付。Core 优先完成公共接口和执行底座，各 Harness 可按接口并行开发；其他模式完成后可一并交付。五种名称及其完整目标保留：

| mode | 主要协作机制 | 需要验证的 Core 能力 |
| --- | --- | --- |
| Subagents | parent 动态委派 child、回收结果并整合 | 动态创建、父子权限、结果事件、持续输入 |
| TaskPool | 公共 Task 池、排他认领、Workspace 与成果发布 | 领域服务、运行中资源准备、只读到可写的交接 |
| Substrate | 内容 publish/search/visit 与引用 | 无 Task 的共享状态与成果持续保留 |
| PeerMesh | Git/PR、peer messages、shared context、事件驱动续轮 | 外部身份、网络、原生 Git、串行输入与导出 |
| Lead-Worker | lead 通过 Board 引导 helpers | 角色权限、共享方向与进展、定向反馈 |

规模和性能实验另行设计。这里的完成条件是各模式的实际协作闭环，以及它们确实使用相同 Core；不以跑通小例子推断大规模效果或大部分用户需求已经得到验证。

## 2. 代码组织与资源归属

### 2.1 普通宿主模块

| 文件或组件 | 作者 | 责任 |
| --- | --- | --- |
| main.ts | 使用者 | 读取本次配置、调用 Harness、保存结果和退出状态 |
| environment.ts | Harness 作者 | 注册能力、创建 Runtime、启动 Agents、协作与结束 |
| profiles.ts | Harness 作者 | 角色 prompt、镜像、模型、Service 权限与资源默认值 |
| controller / router | Harness 作者 | 事件排序、结果回传、下一轮、预算与失败政策 |
| services/\* | Service 作者 | manifest、adapter、数据与业务规则 |
| run-input.ts | Harness 作者 | 独占输入场景的有期限等待；不是 Core API |
| Core | Core 维护者 | Agent 运行、身份、隔离、输入、事件、Service 接入与收尾 |

这些文件名是组织示例，不是必须遵守的目录框架。首版使用普通 import 和函数入口，不增加插件发现系统。**Q1 已确认：首版只对接 Pi 1.3.0 + OpenSandbox，不开发通用多 backend 插件接口。Q2 首版：Profile / Service 在创建 Runtime 前注册并冻结，运行中可以按已注册 Profile spawn。受控登记和授权见 [Q2 后续扩展](06-lead-worker-dynamic.md)。** 通常一次 Harness 运行创建一个 Runtime，Runtime 管理多只 Agent；不同环境共享同一个 Core 包。

### 2.2 装配和启动顺序

1. 为本次运行选择独立 outputDir，读取 backend、模型、镜像、预算与 Service 数据配置。
2. 准备所需外部设施，完成 readiness；登记自己创建的连接、账户和进程。
3. 注册 manifest + adapter，配置 Profiles；固定本次身份引用与权限。
4. 调用 createRuntime。Core 合入内置 Agent Service、校验注册表和 Profile、装配 Bridge 与模型入口。
5. 在提交模型工作前安装事件处理器；spawn 只创建资源，不提交 input。
6. 建立 Harness 的 Agent 路由、领域关联或外部订阅，再显式 send。
7. 运行 controller / router，按业务结果和预算决定结束，保存结果与清理回执。

初始化失败同样要关闭已经创建的外部资源。Runtime 工厂只收尾它自身拥有的对象；不会替 Harness 删除其数据库或关闭外部共享服务。

Core 的创建、文件准备和 send 具有有限的单次宿主等待上限。资源 API 首版不接 AbortSignal；若取消发生在 createRuntime/spawn 期间，示例会在该有界操作返回后检查取消并进入收尾，不声称即时中止远端创建。

### 2.3 公共状态与私有工作目录

**Q3 已确认：** 每个 Agent 使用独立 sandbox、workDir 和 Session，首版不提供 Agent 间共享文件目录。Agent 之间的可见性由 Service、Git 或明确的 artifact 交付决定；另一个 Agent 的本地路径本身不构成可访问的结果。

共享数据的生命周期由 Service/Harness 决定，Agent 退出后可以继续保留。公共 Workspace 属于 TaskPool；其他模式可以使用 Git、内容库或 Board，不必建立 Task/Execution。

## 3. Service 与 Profile 接入

### 3.1 调用合同

Service 作者提供 manifest 和 adapter；Harness 将它们注册进 ServiceRegistry，并在 `Profile.services` 中授予操作。Agent 使用 `swarm <service> <operation>` 调用；这些命令是 Agent-facing CLI，宿主入口是调用 Harness 的程序。

Bridge 注入真实 caller，Registry 执行参数 schema 校验后再调用 adapter。Service 负责记录归属、事务、业务幂等和外部账户。HTTP adapter 保留相同身份边界；Agent 输入中的 caller/author/binding 字段没有覆盖可信身份的权限。

新通用 manifest 采用 Core 文档定义的 v2 合同。旧 v1 的 Task audience/context 通过 TaskPool 兼容适配保留；不将旧领域检查静默删除。`registerService`、`createInProcessAdapter` 和 `invoke` 的装配形态沿用现有实现。[Registry](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/sdk/service-registry.js) · [adapter](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/sdk/service-adapter.js)

[#236](https://github.com/LuNa-shi/murm/issues/236) 验证同一个 Harness 使用相同消息操作，分别接入进程内实现和已经运行的外部消息 Service。adapter 在应用侧映射服务的原生接口，Bridge 继续校验真实 caller、Profile 权限和 schema。外部写请求超时或响应丢失时保留原 operation ID 和未知结果。两种运行分别通过真实 Agent CLI 交接并验证最终文件，关闭后验证外部服务及数据继续可用。Harness 自建资源先核对归属，再按必需导出与实际依赖完成有界收尾。按 Run 启动 HTTP 服务、通用 v2 服务端和三种设施同场留待具体使用场景。

另一接入示例使用真实 GitHub CLI `gh`。Agent 请求获准的只读操作，应用侧 adapter 按固定子命令和仓库范围执行 `gh`，校验参数并返回结构化结果。凭据留在应用侧，Agent 环境和可见记录只保留调用所需的业务字段。需要让 Agent 直接执行 `gh` 的 Harness 可以显式配置镜像、网络和单独的 Agent 凭据。#237 验证相同 Service 合同的仓库外消费。

### 3.2 接线示例：共享一条带固定源码位置的审查记录

附录 A 给出一个完整、范围有限的接线示例：writer 读取已提供的固定 commit 审查事实，通过 Notes Service 发布；reader 读取后核对来源，写入自己的报告。它用于检查 Service 身份、权限、数据交接、输入等待和关闭流程，不用于评估模型代码审查能力。

| 操作 | 参数 | 返回 | 规则 |
| --- | --- | --- | --- |
| notes.put | key、text | key、text、author | 同 key/author/content 重复返回原记录；不同内容冲突 |
| notes.get | key | 记录或 null | 读取原记录；示例记录读取者作为交接证据 |

writer 仅获得 put，reader 仅获得 get。调用者身份来自 caller.agentId；同一示例的内存状态在宿主报告中保存。实际服务可替换为持久数据库而不改变 Core。

```bash
swarm notes put --input note.json --request-id review-note-1
swarm notes get --input key.json
```

附录包含完整 v2 manifest、Harness 函数和 main 的结果保存。config.backend 使用 Core 文档中的具体 backend 配置；model 是模型别名，image 是准备好所需工具的 Worker 镜像。outputDir 必须属于本次运行，避免不同实验覆盖报告。

## 4. 输入、异步任务与结束规则

### 4.1 输入与执行收束

**Q4 已确认：`runtime.send` 与 Agent Service `send` 省略 mode 时默认 `steer`，也可显式指定 `followUp`。** 这里的 steer 在 Pi 支持的执行边界加入输入，不是强制中断。本文的串行等待 helper 和 PeerMesh router 为维持整轮边界，**始终显式选择 followUp**，不依赖默认值。accepted 表示 backend 接纳；unknown 保留请求身份并进入核对，不能换 ID 自动重发。settled 携带本次 outcome/output/error；`completed` 不代替业务验收。

Core 最低合同不提供逐 inputId 的完成关联。Harness 的多来源结果回传要管理自己的顺序与业务状态。PeerMesh 等串行执行场景可限定一个 Agent 只有一个输入源，再使用附录 B 的 runInput。

**Q5 已确认：idle Agent 的 Session、私有目录和 Slot 继续保留，直至显式 stop。** runInput 的完整前提是：Agent 初始 idle、没有待消费输入或自动续轮、同一 Agent 同时只有一个调用、使用从未提交过的新 requestId。它拒绝 helper 内的并发与 ID 复用，并同时等待接纳和新的 settled。timeout/取消只结束宿主等待，不声称取消 Agent；结果不确定后该 helper 不再继续使用这个 Agent，示例进入 close。

此 helper 不用于 busy Agent 的 steer、多来源 Subagents 输入，也不用于对旧 requestId 恢复等待。它内部显式使用 followUp，不替 Core 决定默认输入时机。

### 4.2 事件处理与去重

onEvent 的同步 handler 只做接收、筛选与入队。Harness 跟踪异步 jobs 的结果、拒绝和取消，不把 async handler 的 Promise 隐含交给 Core。每条事件先按 agentId + seq 去重；需要合并 fatal/exit 等故障通知时，再按本模式的故障状态处理。

转交执行结果时读取事件快照。get 适合查询当前生命周期和 parentId 等关系；累计 latestOutput/lastError 不能代替某个历史 settled 的结果。关闭期间拒绝生成新的工作，保留已接纳输入与未送达结果的记录。

### 4.3 关闭顺序

| 阶段 | Harness 的动作 | Core 的动作 |
| --- | --- | --- |
| 停止生产 | 停 router/timer 的新派发，取消未提交工作，保留已提交记录 | Runtime.close 关闭新 spawn/send/resource 入口 |
| 停止执行 | 等待均有期限或取消信号；不依赖一定收到 exit | 覆盖所有登记 Agent 和在途创建，报告 execution=stopped/unknown |
| 采集和清理 | 保留导出依赖，记录业务结果与 cleanupFailure | 按 collect 导出、销毁和释放容量；失败返回 pending |
| 关闭外部设施 | 根据回执保存数据并关闭自己拥有的进程/连接 | 保存 Core 报告与产物清单 |

**Q6 已确认：** 对预先标记为 required 的成果，导出失败时停止 Agent 后保留 sandbox 与 Slot，回报 cleanup=pending；可选成果的失败不必阻止清理。runtime.close 使用独立的有限等待上限，不复用已经取消的工作信号。它返回后，用回执或 AbortSignal 结束剩余等待，再有界地收集 jobs。execution=unknown 不等于已退出；必需导出 pending 不等于可删除 sandbox。

业务失败和清理失败分别记录。工厂失败时保留 ResourceError 的 details/reportPath；close 意外抛错也不能覆盖原始业务错误。外部共享设施只释放本 Harness 持有的连接和临时资源；公共数据按其保留政策处理。

### 4.4 必需的运行报告

宿主报告至少包含业务结果、失败原因、各 Agent 的执行/清理状态、未送达或未知输入、共享结果位置和私有产物位置。附录示例将 `businessFailure`、`cleanup`、`cleanupFailure` 分开，并保存 Service 状态与读取证据。若连报告目录都无法写入，宿主明确返回保存错误，不宣称已留下完整记录。

## 5. Subagents

本章至第 9 章是五种 Harness 的待实施方案。它们复用同一套 Core；精确接口、资源政策和示例细节属于设计建议。runInput 在内部显式使用 followUp，不提供 mode 参数。代码只展示关键接线；`routes`、`runInput`、各 controller 和领域 helper 都由 Harness 编写，不是额外的 Core API。宿主先 `spawn`，再显式 `send`；所有直接 send 示例均填写 mode。

Subagents 用父 Agent 委派工作、子 Agent 返回结果的流程，检验动态创建、父子权限、结果回传及同一会话续轮。

### 5.1 配置与权限

| 项目 | 首例配置 |
| --- | --- |
| 团队 | 1 parent，动态创建最多 2 child，共 3 Slot |
| parent | 委派与整合 prompt；agent.spawn/get/send/stop；spawnProfiles=\["child"\] |
| child | 独立上下文、明确文本交付；私有命令；不开放递归 spawn |
| 资源 | 独立 workDir；settled 保留；parent 关闭不再需要的 child |
| 输入/结束 | 用户固定发给 parent；整体交付通过或预算/故障结束 |

Core 从可信 caller 生成 parentId。get/send 的目标限于自己与直接 children；stop 仅允许直接 child。每项操作都需 Profile 授权，spawn 另需 spawnProfiles 允许目标角色。child 的镜像、网络、Service 操作权限和 collect 使用目标 Profile，Agent 输入无权覆盖。首例的动态 child 不需要外部 bindings/secretEnv，也不继承 parent 的凭据；需要独立外部账户时先采用宿主创建流程。上下文 fork 另作策略。

### 5.2 Service 与命令

Core 内置 Agent Service，Harness 配置权限。拟新增命令如下；child.json 只含 profile、可选 input 与显式 mode：

```json
{"profile":"child","input":"完成子问题，返回结论、依据及不确定部分。","mode":"followUp"}
```

```bash
swarm agent spawn --input child.json --request-id child-1
swarm agent get --agent-id "$CHILD_ID"
swarm agent send --input followup.json --request-id child-followup-1
swarm agent stop --agent-id "$CHILD_ID" --request-id child-stop-1
```

便利 spawn 返回 \{agent, initialInput\}；initialInput 为 InputReceipt、明确拒绝的错误结果或 null，不表示执行完成。省略 input 不执行模型；输入未知或被拒绝时仍保留已创建的 `agent.id`。宿主 spawn 不带 input，另行 send。

首例交付文本。child 私有路径不等于 parent 可读地址；编程子任务需另选 patch/artifact 的发布、读取与应用格式，不作为本例已完成能力。

### 5.3 运行流程与关键接线

Harness 注册 Profiles、Services 与事件处理器，spawn parent，再 send 初始目标。parent 经 Agent Service 创建 child；Core 在 child 执行前登记 parentId、资源和事件。child 收束后，Harness 回传结果；parent 可追问存活 child，或整合后 stop。整体完成与预算由 Harness 判断。

事件 handler 同步接收，Harness 的队列处理异步路由、顺序、去重和错误。以下是队列中的轮次结果转发；recordDelivery 是 Harness 函数：

```ts
async function forwardChildResult(event) {
  if (event.type !== "settled") return;
  const child = await runtime.get(event.agentId);
  if (!child.parentId) return;
  const receipt = await runtime.send(
    child.parentId,
    JSON.stringify({
      childId: child.id, eventSeq: event.seq,
      outcome: event.outcome, output: event.output, error: event.error,
    }),
    { requestId: "child-result:" + child.id + ":" + event.seq,
      mode: "followUp" },
  );
  recordDelivery({ childId: child.id, eventSeq: event.seq, receipt });
}
```

get 只读取父子关系；结果取自 settled 的本次快照，不能用 latestOutput/lastError 拼接某轮结果。队列按 agentId + seq 去重，并保持每个 child 的事件顺序。

| 事件 | 处理 |
| --- | --- |
| settled/completed | 转交结果，由 parent 判断是否满足要求 |
| settled/failed 或 aborted | 转交本次失败/中断，不能记作成功 |
| fatal error 或意外 exit | 即使没有 settled 也报告失败；合并同一次异常终结，避免 fatal+exit 重复通知 |
| 显式 stop 后的预期 exit | 更新清理记录，不生成新的失败任务 |

Harness 根据 exit.expected 区分预期停止；若同次失败已由 settled 报告，随后 exit 只更新终结状态。

### 5.4 输入与失败收尾

用户补充与 child 结果都进入 parent 的输入入口。示例显式使用 followUp；若启用 steer，需要定义追加输入与当前工作的关系。多个输入来源的 parent 不能用“下一个 settled”判定某条输入完成。

runInput 只用于 idle、独占输入、无队列/自动续轮、全新 requestId 的一次性等待，不用于 parent 的多来源路由。unknown/timeout 保存原请求身份，不能换 ID 自动重投。parent 已 closing/closed 时记录未送达结果，不自动重建 parent。

child 失败后的业务选择由 parent 决定。结束时先停用户输入、结果路由的新派发与动态创建，再有界 close；保留完成监听并收集路由任务。execution unknown 或 cleanup pending 必须进入报告，不能把整棵树记为已清理。

### 5.5 验收

- parent 经 Bash 真实创建 child，且非法 Profile、伪造 parentId 和越界目标被拒绝。
- child 的文本结论被 parent 的最终交付引用或实际使用。
- idle child 再次收到输入后，沿用原 Session 和 workDir。
- child 的失败能抵达 parent；正常停止不会重复触发失败通知。
- 用户补充进入 parent；停止后所有 Agent 都有明确的执行与清理回执。
- 若测试编程产物，单独验证“发布 patch/artifact → parent 获取 → 应用/验证”，不以一段文件路径描述替代实际交付。

### 5.6 来源与适配差异

固定 Codex `a1604a8c` 的 [spawn](https://github.com/openai/codex/blob/a1604a8c0554c09c1be45e5a121bb1889b4d9a50/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs) 与 [completion](https://github.com/openai/codex/blob/a1604a8c0554c09c1be45e5a121bb1889b4d9a50/codex-rs/core/src/agent/control/completion.rs) 提供创建、父子完成通知的参考。本项目采用 Bash Agent Service、独立 sandbox 与 Harness 路由；首例不包含上下文 fork、关闭后恢复或释放 Slot 的等待。不同上游同名输入操作的时机以 Core 对照说明为准。

<a id="6-flat"></a>

## 6. TaskPool

TaskPool 保留当前 Task-oriented 工作流：Agent 先在只读条件下发现工作，原子认领 Task，再取得对应 Execution 和文件写权限。一个 Agent 最多执行一个 Execution；结束后由新的 Agent 从公共状态继续工作。

### 6.1 配置与权限

| 项目 | 首例配置 |
| --- | --- |
| 团队 | 2 researcher，固定容量，前一 Agent 收尾后按现有策略补位 |
| Profile | Mission/选工/完成 prompt，Task/Context/Workspace；科研例子可加 Judge |
| 目录 | spawn 时 writable=false；take 后 grant 对应准备版本 |
| 公共状态 | Mission、Task、Execution、Material、Workspace revision 均由 TaskPool 管理 |
| 运行策略 | continuation、discovery、deadline、stall 与整体完成判断属于 TaskPool |

Core 与 TaskPool 使用同一 agentId。TaskPool 兼容层维护旧容量字段 legacySlotId，不能填 `runtime.id`；释放与实际收尾对齐。旧 markAgentReady 检查 sandbox\_id，迁移后改由受信宿主根据 spawn 就绪建立 UNBOUND；provider/sandbox 状态迁入 Core，不伪造旧字段绕过检查。

### 6.2 Services 与命令

本节的在线保存目标受 [2026-11-24 本轮范围调整](README.md#2026-11-24-owner-确认的本轮范围调整)限定：标准 Core 的生产 live capture 接线由 #197 留待后续，#196 仍为延后草稿。本轮对已有可信宿主注入和公共产物路径按实际能力验收；下列命令和流程不构成标准安装包已经具备生产 live capture 的声明，原有领域校验和失败关闭合同保持。

```bash
swarm task list --state ready
swarm task view "$TASK_ID"
swarm task take "$TASK_ID" --request-id take-1
swarm material publish --input material.json --request-id material-1
swarm workspace save --request-id save-1
swarm task finish --input finish.json --request-id finish-1
```

上述 `workspace save` 仅在配置可信捕获绑定时装配；无绑定的受限 TaskPool 从 Registry/Profile 和提示省略该操作及私有 status/current-diff，仍可使用公共 Workspace 读取、Material 发布和原合同允许的 finish。显式无效绑定拒绝，不将不可用命令冒充已接通能力。

命令已有，沿用成果引用、revision 与 finish 合同。Bridge 注入可信 caller，TaskPool adapter 查询领域关联，检查 Task provenance、归属、事务和排他 take；不接受 JSON 伪造身份。take adapter 原子认领后调用宿主 Runtime.files，模型不直接拥有 prepare/grant。

### 6.3 运行流程与关键接线

流程为：只读 Agent 发现 Task → 原子 take → 准备固定输入 → 激活 Execution → grant → 执行和发布 → finish → 停止与收尾 → 按策略补位。

TaskPool 负责 Workspace revision、Materials、Execution provenance、reservation 与 deadline；Core 只接收 Agent 和确定的文件内容，返回准备回执并实际授权。take adapter 从可信 caller 取 agentId、从 envelope 取 requestId，不接受模型伪造。

以下保留真实 TaskService 入口。prepareTaskPoolInputs、executionEnvelope、startPreparationHeartbeat、timing 及补偿函数都是 TaskPool 的迁移代码，不属于 Core。

```ts
const task = taskService.getTask(taskId);
const taken = taskService.takeTask(taskId, {
  take_key: requestId, owner_ref: agent.id, core_id: legacySlotId,
  agent_prompt: researcherPrompt, input_material_refs: task.input_material_refs,
}, makeEnvelope({
  operationId: requestId + ":take", actorRef: agent.id, taskId,
  specVersion: task.spec_version, stateVersion: task.state_version,
}));

const executionId = taken.execution.execution_id;
const originalFence = taken.execution.fencing_version;
let lease;
try {
  lease = startPreparationHeartbeat({
    agentId: agent.id, executionId, expectedFence: originalFence,
  });
  const files = await prepareTaskPoolInputs(executionId);
  lease.check();
  const prepared = await runtime.files.prepare(agent.id, {
    requestId: requestId + ":prepare", files,
  });
  lease.check();

  taskService.assertMissionResearchOpen(missionId);
  taskService.assertAgentDeadline(agent.id);
  const owner = taskService.getAgent(agent.id);
  let execution = taskService.getExecution(executionId);
  if (owner?.state !== "PREPARING" || owner.execution_id !== executionId ||
      execution?.state !== "CREATED" ||
      execution.fencing_version !== originalFence) {
    throw new Error("Task reservation is no longer current");
  }

  lease.stop(); // 准备期检查只接受 PREPARING/CREATED，激活前必须停。
  execution = taskService.getExecution(executionId);
  taskService.dispatch("start_execution",
    { core_id: legacySlotId, ...timing },
    executionEnvelope(execution, requestId + ":start"));
  await runtime.files.grant({ requestId: requestId + ":grant", prepared });

  taskService.assertMissionResearchOpen(missionId);
  taskService.assertAgentDeadline(agent.id);
  const activeOwner = taskService.getAgent(agent.id);
  const active = taskService.getExecution(executionId);
  if (activeOwner?.state !== "ACTIVE" || activeOwner.execution_id !== executionId ||
      active?.state !== "RUNNING" || active.fencing_version !== originalFence) {
    throw new Error("Task ownership changed during project grant");
  }
  saveFlatHandoff({ agentId: agent.id, executionId,
    executionFence: originalFence, prepared });
  // 返回 take 成功，原 Bash 调用与 Session 继续。
} catch (error) {
  let stopped;
  try {
    stopped = await runtime.stop(agent.id, { timeoutMs: config.stopTimeoutMs });
  } catch (cleanupError) {
    recordFlatFailure({ executionId, error, cleanupError });
    throw error;
  }
  recordFlatFailure({ executionId, error, stopped });
  if (stopped.execution === "stopped") finalizeFailedExecution(executionId, error);
  // unknown 保留待核对归属，不能把同一 Task 交给另一 Agent。
  throw error;
} finally {
  lease?.stop();
}
```

这是 take 成功后的补偿；普通认领冲突不进入该 stop 路径。实现时还要捕获 stop 的意外异常，保留原错误与清理错误两条记录。

| 迁移 helper | 必须保留的行为 |
| --- | --- |
| prepareTaskPoolInputs | 提取 #prepareWorkspace / #saveWorkspaceReference，保留 exportRevision、Materials、createWorkspace 与固定输入来源，转换为 FileSeed |
| startPreparationHeartbeat | 立即与定期校验 reservation 并续租；留存 timer 错误；check 核验错误与归属；stop 幂等 |
| executionEnvelope | 使用当前 task\_id、execution\_id、spec\_version、state\_version、fencing\_version |
| timing | 保留 Task timebox、handoff/Execution deadline 与 Agent hard deadline |
| saveFlatHandoff / finalizeFailedExecution | 保存领域 fence、Workspace revision 与 prepared 的对应；仅在执行已停后终结领域归属 |

Task fencing\_version 与 PreparedFiles.version 分别证明领域认领和资源内容，不能互相替代。Core 不承担跨 Task 数据库与 sandbox 的原子事务；TaskPool 必须在 grant 前后检查，在未知或失效时先停执行再补偿。

prepare 首例只用于尚未开放写入的空目录；grant 只接受 Agent 当前有效的 prepared。运行中任意替换、通用 revoke、同一 Agent 承接第二个 Execution 不在此合同中。

**模型访问也需迁移。** [AgentModelAccess](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/agent/bot-model-access.js) 仍依赖 TaskService、Mission、UNBOUND/ACTIVE 和 Execution lease/deadline；只拆 Runtime/Bridge 会使无 Task mode 被 gateway 拒绝。TaskPool 在 createRuntime 配置策略端口：

```ts
modelAccessPolicy: {
  authorize: caller => authorizeFlatModelCall(caller, taskService),
  withCommit: commit => taskService.withServiceLifecycleWrite(commit),
}
```

authorizeFlatModelCall 从旧 validateAgent 提取，返回 ModelPermit：phase/deadlineAt 与可选 lease；旧 executionId/fencingVersion/leaseDeadline 映射为 key/version/expiresAt。Core 先检查自身存活，再领域授权；同步提交窗口与持续 lease 复核遵循 Core 模型访问合同。无 Task mode 不配置该策略，默认 work；TaskService 不再进入通用 gateway。

### 6.4 输入与失败收尾

定向反馈先指定仍在执行的 Task，TaskPool 在 send 前重新核验 Executor 绑定；已结束就返回当前状态，不改投其他 Agent。用户输入与自动 continuation 经过同一 controller；settled 只表示收束，是否续轮由 Task 状态与预算决定。群体 Mission 热更新不包含在首例。

| 情况 | 行为 |
| --- | --- |
| take 冲突 | 返回领域冲突，Agent 可重新选工 |
| take 成功后准备失败、租约失效 | 先 stop，执行已停后处理 Execution/Task 归属 |
| grant 未知或后置检查失败 | 不返回 take 成功；走相同停止与补偿 |
| execution stopped、导出 pending | 领域终结与资源清理分别记录 |
| execution unknown | 保留待核对归属，不把相同工作释放给另一 Agent |
| 全局结束 | 停 controller 派发与补位，有界 close；保留公共 Workspace、Materials 与 Service 数据 |

### 6.5 验收

- 排他 take、finish、引用、revision 和一 Agent 一 Execution 保持。
- take 前只读；准备与 grant 版本一致；成功后可写。
- 准备/grant/关闭失败时，旧执行未停不会把同一 Task 发给新 owner。
- 补位、定向反馈正常；pending/unknown 清楚；其他 mode 不继承 TaskPool 的 stall/continuation。
- TaskPool 仅用 Core 公开接口，模型 gateway 仍执行领域授权。

### 6.6 来源与适配差异

固定 murm `fcbe0107` 的 putnam-runner、task-controller、identity-task-loop 与 workspace-publication 提供现有业务链路。重点核对 [Runtime 的准备、heartbeat、激活与 grant](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/runtime/runtime.js#L758-L876)，同文件的 #prepareWorkspace、#saveWorkspaceReference、#executionEnvelope 与 deadline 计算随 TaskPool 迁出。[TaskService 的登记与 ready 检查](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/task/task-service.js#L626-L713) 也需与新资源归属对齐。

新 files API、领域 ready 入口、模型授权策略与 legacySlotId 兼容层尚需实现，不能只替换 import 就视为迁移完成。

## 7. Substrate

[ScaleMAS 论文机制与 FATE](05-substrate-fate.md) 规定 #202 的对齐配置与验收；本节描述通用兼容路径。

Substrate 用持久共享内容、搜索、引用与组合来组织工作，检验不依赖 Task 的共享成果协作。

### 7.1 配置与权限

| 项目 | 首例配置 |
| --- | --- |
| 团队 | 3 同权限 peer，宿主固定池，不开放相互 spawn |
| Profile | 搜索、读取、工作、引用并发布；私有目录可写 |
| Service | substrate；append-only 内容、稳定地址、引用、作者/版本，按运行隔离 |
| 结束 | 初始问题＋有界 work-cycle，按成果或预算结束 |

可复用 Context 存储/查询，但要拆开 Task/Execution provenance；无 Task 内容按真实可见范围、地址与版本校验。

### 7.2 Service 与命令

| 操作 | 输入 | 返回与业务约束 |
| --- | --- | --- |
| publish | content、可选 references | 新内容的稳定地址；事务写入正文与引用；作者由 caller.agentId 确定 |
| search | query、limit | 有界结果，含地址、摘要与排序依据；Service 执行数量上限 |
| visit | address | 正文、作者、版本与引用；检查调用者的可见范围 |

```bash
swarm substrate search --query "当前缺口" --limit 8
swarm substrate visit --address "$ADDRESS"
swarm substrate publish --input contribution.json --request-id publish-1
```

命令为拟新增。8 是示例配置值。首例采用文本相关性排序，同等相关性参考引用次数，再以稳定地址打破平局；这是本项目的检索实现选择，不声明与上游排序完全一致。发布重试沿用 Service 请求身份；同请求 ID 不同内容应拒绝。

### 7.3 运行流程与关键接线

Harness 初始化内容库与 Profiles，spawn peers 并显式 send 初始问题。peer search/visit 后在私有目录工作，publish 新内容及引用。每轮收束后，Harness 在预算内安排同一 Agent 继续；搜索方向与内容组合由 Agent 决定。

固定池可用每 Agent 串行 driver。runInput 是 Harness 的一次性等待 helper，要求 idle、独占输入、无队列/自动续轮，每次 requestId 是新值：

```ts
for (let round = 0; round < config.maxRounds; round += 1) {
  if (budgetExpired() || resultAccepted()) break;
  await runInput(runtime, peer.id,
    "搜索相关成果，完成有用工作，发布内容及引用。",
    { requestId: peer.id + ":cycle:" + round,
      timeoutMs: config.turnTimeoutMs });
}
```

budgetExpired、resultAccepted 与 driver 均由 Harness 实现。多个 peers 并发，各自的输入串行；unknown/timeout 不自动换 ID 重投。

### 7.4 输入与失败收尾

首例支持初始输入。运行中定向反馈若启用，先进入 peer controller 排序，不能绕过独占 helper 直接 send。全群反馈和可信 User Service 发布追加资料可另配。

失败 peer 停止、不自动替补，其余 peers 在原预算内继续；已发布内容不随 producer 删除。结束时先停 driver 新输入，再有界 close 并保存 Service 数据。内容持久性与 execution/cleanup 回执分别验收。

### 7.5 验收

- 完全不建立 Task，A 能 publish，B 能 search/visit 并发布引用 A 的后继内容。
- A 停止后，其内容及引用仍可由 B 读取。
- search 的 limit 在 Service 侧执行；跨运行的不可见内容不能被访问或引用。
- 每个 peer 可在原 Session 中完成至少两轮；结束时输出与 Service 状态可检查。
- 该验收证明共享成果机制能够运行，不用于证明大规模性能或等价复现某篇论文。

### 7.6 来源与适配差异

[作者介绍](https://scottyih.org/publication/2026-10-11-scaling-multi-agent-intelligence-with-substrate-centric-coordination) 提供 publish/search/visit、引用、有界检索和内容保留的机制说明；尚未定位官方实现仓库。固定池、driver、CLI、结束条件和具体排序是本项目适配。复用 [ContextService](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/context/context-service.js) 时，需拆开其中的 Task/Execution 授权及引用校验。

<a id="8-agensh"></a>

## 8. PeerMesh

**Q7 已确认：PeerMesh 首版只要求核心协作闭环，不以完整复现原始运维和通知细节为门槛。** 闭环包括 Git/PR、peer messages、shared context 与事件驱动续轮；共享设施与主要协作语义保留，由 Core 接管 Agent 的创建、输入和销毁。mid-turn notices、完整 ACP/MCP 细节作为适配差异记录，而非首版阻塞项。

### 8.1 配置与权限

| 项目 | 首例配置 |
| --- | --- |
| 团队 | 2–3 同级 peer，固定池，连续使用同一 Session |
| Profile | 适配 coder/work-cycle prompt，四基础工具＋Bash Services |
| 设施 | Gitea、Mattermost、PeerMesh shared board |
| controller | 每 Agent 串行 router/dispatcher |
| 文件/结束 | 私有 checkout/分支，经 PR 汇入 main；测试/交付通过或预算结束 |

Profile.env 放非秘密变量，network.allow 首版只接受 IPv4 字面量 HTTP(S) origins。宿主 secretEnv 提供 Agent 本人的受限 Git token，镜像 credential helper 负责认证；管理凭据留在 adapter。系统不主动把 token 写入普通配置、日志或 workDir；Agent 自行写入文件的内容仍按 Core 的归档规则处理，不能承诺自动识别所有秘密。allow 限制目标，目标上的 Git/REST 权限仍由 upstream 凭据与 ACL 决定。

### 8.2 Services、身份与命令

共享 API 经 Bash CLI → Bridge → adapter → 原服务。操作名/schema 按原合同适配：

| Service | 拟新增操作 | 可信身份 |
| --- | --- | --- |
| gitea | issue\_read、issue\_write、pull\_request\_write | gitea binding 选择 peer 账户 |
| message | post\_message | message binding 选择 Mattermost 账户 |
| agensh-context | board\_read、board\_write、board\_grep、board\_unfold | board binding 选择 worker；adapter 填 thread\_id/viewer |

三个 bindings 必须可解析且属于本次运行。Bridge 只注入当前 Service 的引用，JSON 无权覆盖 caller；不能默认 agentId 等于上游 worker ID。

原生 Git 使用独立通道；WORK\_BRANCH 为该 peer 唯一分支，受限 token 由镜像 credential helper 读取，不能拼入 URL、日志或提交文件。

```bash
git clone "$RUN_REPOSITORY" work
git -C work checkout -b "$WORK_BRANCH"
# 修改并运行测试
git -C work add .
git -C work commit -m "Implement assigned change"
git -C work push origin "$WORK_BRANCH"
swarm gitea pull_request_write --input pr.json
swarm agensh-context board_write --input summary.json
```

CLAIM 是带 TTL、允许重叠的工作意向，靠 peer message 协商；保留其与 TaskPool 排他 take、Board 单 owner 的差异。

### 8.3 运行流程与关键接线

1. Harness 准备 repo/main、channel、board、验收与 worker accounts；adapters 保存凭据并返回三个引用。
2. 注册 adapters，配置 Profile、网络与 Git helper，创建 Runtime；spawn 无 input 的 peers，附 bindings、secretEnv、collect。
3. 建立 agentId→worker 路由映射与订阅，检查 readiness 后 kickoff。
4. peer 读 issue/Git/board，发布 CLAIM，私有分支开发、测试、push/PR 和 PATCH\_SUMMARY；重叠工作经 DM 协商。
5. Gitea/Mattermost 事件进入各 Agent 串行 router，补共享上下文后续轮；空队列采用有界 idle nudge。
6. 验收或预算结束，收尾并保留数据。

以下是单 peer 配置；preparedProject/preparedAccounts 来自 Harness 初始化。peerProfile 在 createRuntime 前注册：

```ts
const peerProfile = {
  prompt: adaptedAgenshPrompt, model: config.model, image: config.gitImage,
  writable: true,
  env: { RUN_REPOSITORY: preparedProject.repositoryUrl },
  network: { allow: [new URL(config.giteaEndpoint).origin] },
  services: {
    gitea: ["issue_read", "issue_write", "pull_request_write"],
    message: ["post_message"],
    "agensh-context": ["board_read", "board_write", "board_grep", "board_unfold"],
  },
};
const peer = await runtime.spawn({
  requestId: "peer-1", profile: "peer",
  bindings: {
    gitea: preparedAccounts.giteaRef,
    message: preparedAccounts.mattermostRef,
    "agensh-context": preparedAccounts.boardRef,
  },
  secretEnv: { GITEA_TOKEN: preparedAccounts.gitToken },
  collect: { paths: ["."], includeGit: true,
    maxBytes: config.exportLimit, required: true },
});
```

GITEA\_TOKEN 是示例镜像/helper 的约定，需改旧 adapter allowlist 并由 backend 受信安装。Core 就绪后，Harness 完成 router/订阅再 send。初始化失败各方收尾自己创建的资源，保留 pending 清单。

**CoreChannel 保留整轮完成边界。** 上游 dispatcher 等 channel.prompt 完成后才继续 batch；accepted 不能当作完成。首例把 kickoff、peer event、用户输入和 nudge 全部串到同一 router，满足独占条件后使用 Harness helper。**尽管 Core 默认是 steer，这一 router 明确使用 followUp**，由单输入源保证每个 batch 的整轮完成判断：

```ts
const completed = await runInput(runtime, peer.id, batch.input,
  { requestId: "agensh-batch:" + batch.id, timeoutMs: config.turnTimeoutMs });
return { output: completed.settled.output };
```

router 先对事件去重。新 batch 使用唯一 ID；重复已完成 batch 读处理记录，不再次调用 runInput。timeout/unknown 保留原 inputId/batch，停止该通道收尾或核对，不换 ID 自动重发。另开 busy steer 通道会破坏独占前提，需另定输入关联。

### 8.4 输入与失败收尾

用户经 Mattermost DM/mention 或 Gitea issue/PR comment 进入指定 worker 的 router，保留来源与事件 ID。原版工具返回时附带 pending DM/gist 并维护 pending/shown；首例仅验证轮次边界投递；**Q7 已确认 mid-turn notices 不属于首版验收阻塞项**，CLI notices 后续适配并记录语义差异。Profile/router 提示同步改为 Bash 命令，不保留未实现的 mid-turn 通知承诺。

结束先停止新工作，按预算给有界收尾机会，再停 router 派发与 idle nudge、取消未提交队列项。保留完成监听并有界 close；Core 停执行后导出未 push Git 历史、未提交/未跟踪文件及约定记录。Harness 根据 CloseReceipt 结束剩余等待、保存 batch 状态，再关闭自己拥有的连接、Services 与临时账户；外部运营设施按其归属处理。

execution unknown 不能伪装成 exit，需保留必要依赖与待核对记录。execution stopped、仅导出 pending 时，是否关闭 Service 取决于导出依赖。共享 Git、消息与 board 数据继续保留；业务失败与清理失败分别记录。

### 8.5 验收

**Q7 的验收边界是核心协作闭环**，不是原始 PeerMesh 整套系统的逐行复现；只需要证明消息、Git/PR、共享上下文和事件续轮能正确连接到 Core。先验证单 peer 的“Git clone → Service 调用 → settled → 同 Agent 第二轮 → 保存 → stop”，再增加第二个 peer：

- 两个 peers 在独立目录工作，并把实际成果合入同一 main。
- 一条 peer message 或 PR event 在第一轮后触发同一 Agent 的第二轮。
- 共享 FACT/FAIL/PATCH\_SUMMARY 被另一 Agent 读取并用于工作。
- 重叠 CLAIM 经协商处理，保留软声明语义。
- 三个 adapter 均按可信身份访问正确账户；Git 使用该 Agent 自己的受限账户。
- 定向用户消息进入正确 router，重复事件不会重复派发。
- 停止后共享数据及约定私有产物可读取；每个 Agent 的 execution/cleanup 状态明确。

PeerMesh 已选为一周版的第二个验收案例，与 TaskPool 共用同一套 Core。先完成单 peer 的身份、Git、连续输入与收尾链路，再按上述标准验收两个 peers 的实际协作。

### 8.6 来源与适配差异

固定版本为 `microsoft/PeerMesh@2dae4e14`。原 run profile/task pack 映射到 Harness，worker prompt/能力映射到 Profile。

| 来源 | 保留或适配的内容 |
| --- | --- |
| [dispatcher.ts](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/mini-router/src/dispatcher.ts#L125-L201) | 每 worker 队列、共享上下文、整轮完成边界 |
| [shared\_lessons.py](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/board-service/shared_lessons.py#L58-L90) | FACT/FAIL/CLAIM 与 TTL |
| [agents.txt](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/prompts/agents.txt#L7-L67) | 同级工作循环、共享与协商；工具名/通知时机需适配 |
| [MCP allowlist](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/agent/config/mcp_allowed_tools.json) / [board adapter](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/board-service/mcp.cjs) | 操作参数与 board 身份合同 |
| [team\_run 收尾](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/agensh/team_run.py#L1049-L1155) | 停新工作、归档与共享设施收尾 |

共享设施和 router 规则可复用；ACP→CoreChannel、MCP→Bash、身份安装、Git 凭据与 Core 导出属于适配。现有 murm [网络配置](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/runtime/docker-bot-network.js#L24-L59) 只放行 Bridge/gateway；network.allow、secretEnv 与旧 adapter 的环境变量 allowlist 都需改造。当前 backend 仅以 IPv4 字面量的 HTTP(S) origin 为接入目标，不承诺域名解析或远端 Docker 的完整兼容。

## 9. Lead-Worker

Lead-Worker 通过公共 Board 与 Git 组织一名 lead 和多名 helpers。lead 读取进展、调整方向；helpers 认领、实现、提交并汇报，工作成果在公共数据中连接。

本节描述首版固定团队。#235 在同一 Harness 上增加[可选动态模式](06-lead-worker-dynamic.md)，由实际 Board 任务、反馈和成员就绪触发工作，并以完整真实模型任务验收。

### 9.1 配置与权限

| 项目 | 首例配置 |
| --- | --- |
| 团队 | 宿主预置 1 lead＋2 helpers；不开动态扩充 |
| lead | 拆分调整、读公共进展、发布公告 |
| helper | 读方向、创建/认领 subtasks、实现验证、提交汇报 |
| Services | Board；Git/PR 复用 PeerMesh 接入 |
| 输入/结束 | 用户固定发 lead；有界续轮；交付验收或预算/故障结束 |

各 Agent 独立目录和受限 Git 身份，按第8章配置 env/network、secretEnv 与 bindings。lead 的完成声明须核对实际交付。

### 9.2 Board Service 与命令

| 数据 | lead | helper |
| --- | --- | --- |
| announce / assign | 发布方向、调整分工、读取整体进度 | 读方向与自己的分工 |
| subtasks | 创建、读取、调整待认领工作 | 创建、读取、原子 claim、更新自己持有的工作 |
| notes | 读写计划与建议 | 读写进展 |
| landed / complete | 读取成果 | 发布自己的提交/PR 与完成记录 |

```bash
swarm board announce --input direction.json --request-id direction-1
swarm board list_subtasks --state ready
swarm board claim --subtask-id "$SUBTASK_ID" --request-id claim-1
swarm board note --input progress.json --request-id progress-1
swarm board complete --input completed.json --request-id complete-1
```

Board/CLI 为拟新增，可复用 SQLite/Service 方式。Profile 检查操作，Board 根据可信 caller.agentId 检查 owner，以事务保证单 owner；输入不能伪造归属。helpers 可拆出 subtasks，captain 等分工记录在公共数据中，不增加 Core 角色类型。

### 9.3 运行流程与关键接线

1. Harness 初始化 Board、repo、账户与 Profiles，注册 adapters。
2. 宿主 spawn lead/helpers，不带 input；配置 Git bindings/secretEnv，建立各 Agent 的输入 controller。
3. lead 收到目标，写公告、分工与第一批 subtasks；Harness 检查初始化产物。
4. helpers 查询公告和待办，认领后实现、验证、push/PR，发布 notes/landed。
5. lead 根据公共反馈调整方向；helpers 下一轮读取更新继续工作。
6. 交付通过，或预算/故障结束，保存公共记录并收尾。

首例可以先完成 lead 的初始化轮，再启动 helper 工作轮：

```ts
const lead = await runtime.spawn({ requestId: "lead", profile: "lead" });
await runInput(runtime, lead.id,
  "根据目标建立公告、分工和可认领的 subtasks。",
  { requestId: "lead-initialize", timeoutMs: config.turnTimeoutMs });
// Board 初始化验收后，Harness 的串行 controller 启动 helpers。
// 实际 Git spawn 同时提供各自 bindings/secretEnv，参见第8章。
```

runInput、Board 验收与 controller 是 Harness 代码。controller 决定触发时机与预算；Agent 决定业务拆分和执行。使用独占 helper 时不能有另一条直接输入或自动续轮来源。

### 9.4 输入与失败收尾

用户补充进入 lead controller，示例显式 followUp；lead 将其转换为公告、分工或 subtask 更新。若增加 busy steer，需明确输入关联，不能继续用独占 helper 判完成，也不能把 steer 写成“停止当前工具”。

首例建议：任一关键 Agent 失败，记录失败并有界结束。Board 保留已认领工作的 owner 与失败原因；停止未知时不向另一 helper 释放相同工作。自动替补、claim 回收与重试另作恢复策略。

关闭时先停 controller、用户输入与新工作，有界 close 后按实际回执处理 Board/Git 连接。公共数据、PR 和已有成果保留；报告区分部分成果、未完成工作与待清理资源。

### 9.5 验收

- 两个 helpers 形成至少两份可检查的成果，并关联提交/PR 或其他明确产物。
- Board 原子认领与 owner 检查生效；越权更新被拒绝。
- lead 根据公共反馈更新一次方向，helpers 在后续工作中采用该更新。
- 用户对 lead 的补充最终变成可追踪的公共调整。
- 模拟 helper 失败后，本次运行能有界结束；不会悄悄把仍可能执行的旧 owner 的工作发给另一 helper。
- Agent 停止后，Board、Git、成果与退出/清理证据仍可读取。

### 9.6 来源与适配差异

参考 [Fable 5.2 官方文章](https://claude.dev/blog/safely-scaling-multi-agent-teams-with-fable-5-2/) 描述的独立 sandbox、共享 SQL/Git、lead 基于公共表引导 helpers、helpers 认领提交与汇报。该文章未提供可核查的实验 harness 代码入口。

本项目选择预置 Board Service、固定初始团队和明确角色权限；SQL schema、宿主 controller、故障结束与收尾均为本地适配设计。允许 agents 自行建立任意 SQL schema 的方式可另配，不是当前 Board 的隐含能力。这个示例验证公共引导与角色权限的闭环，不宣称复现上游的规模、训练模型或性能结果。

## 10. 实现顺序与验收

### 10.1 实施门槛

| 门槛 | 完成标准 |
| --- | --- |
| Core 接口 | 类型和行为一致；无 Task Agent 能调用模型与自定义 Service；输入、授权、关闭及错误路径通过 Core 验收 |
| TaskPool 回归 | 原有 take、准备期 lease、Execution、Workspace/Material、续轮与清理行为保持；旧领域检查有明确归属 |
| PeerMesh 验收 | Q7 核心闭环：使用与 TaskPool 相同的 Core，单 peer 接线成功、两个 peers 真实共享 Git/消息/上下文并完成协作；不要求完整 mid-turn notices；标准见第 8.5 节 |
| 最小开发者示例（Q8） | 仓库外能安装、配置、启动、注册并调用自定义 Service、取得结果并停止；新增 Harness 无需修改 Core 内部 |
| 其他模式 | 按各自验收完成后累计交付，源码参考与适配差异明确 |

**Q8 已确认：一周版最低交付为 TaskPool + PeerMesh + 最小开发者示例。** Core 接口明确后，先验证 PeerMesh 单 peer 的网络、身份、Git、连续输入和导出，再接入第二个 peer 完成协作验收；同时保持 TaskPool 回归，并确保仓库外示例能够独立导入 Core、注册自定义 Service、完成输入和收尾。Subagents、Substrate、Lead-Worker 保留为后续目标。“前三天形成 Core”是期望节点，实际进度按验收结果判断。

### 10.2 每种模式的验收记录

五种 Example 的统一符合性核对按 [owner 确认的范围调整](README.md#2026-11-24-owner-确认的本轮范围调整)延后。以下记录规则继续适用于本轮实际验收与已有模式证据，不将后续统一核对记为已完成，也不免除 Q8 三项最低组合的实际验收。

每次验收固定输入、小任务、参与角色、必须发生的协作交接、可检查结果、最大轮数/预算和失败判定。接口的确定性检查与真实模型协作分开记录：前者定位接线和状态错误，后者确认模型是否按该模式完成了交付。

保留实际 prompt、Profile/manifest 版本、模型配置、输入来源、关键 Service 操作、结果与清理证据。对适配时改变的通知时机、权限或检索规则明确标注，不将小型机制示例写成上游论文实验的完整复现。

### 10.3 PeerMesh 首版仍需打通的关键环节

| 环节 | 待实现与验收的事实 |
| --- | --- |
| 账户与网络 | Gitea、Mattermost、board 的真实 worker 身份绑定；Git credential helper 在私有 sandbox 可用，网络只放行授权目标，禁止把管理 token 暴露给 Agent |
| 整轮输入 | 一条消息/PR 事件进入对应 peer 的单一 router；显式 followUp 后等待真正 settled，不因默认 steer 或早期 accepted 提前派发下一批 |
| 共享协作 | 两个 peer 确实通过 Git/PR、消息和共享 board 协作，第二个 peer 读取并使用第一个 peer 的成果，而非两个独立 Agent 恰好完成同一项目 |
| 产物收尾 | 已 push 的内容存入外部 Git；未 push 历史与未提交文件通过 Core 受限采集；导出失败遵守 Q6，残留 sandbox 有可定位的报告 |

这些是首版 PeerMesh 必须通过的集成验收，不包括原版 mid-turn notices、完整 MCP/ACP 协议适配、千级规模及高级故障恢复。设计合入 main 后，据此建立有验收条件的执行 issues。

## 附录 A：完整的宿主接线示例

这些文件属于 Harness 示例，调用本稿的拟议 Core API。它们不是当前仓库中已经可以安装的包。共享记录用于接口交接检查；模型输出的独立业务质量需另验收。

### A.1 Notes manifest

```ts
// Proposed generic Service contract v2; not accepted by the legacy v1 parser.
import type { ServiceManifest } from "@murm/core/services";

const noteProperties = {
  key: { type: "string", minLength: 1, maxLength: 128 },
  text: { type: "string", minLength: 1, maxLength: 8192 },
  author: { type: "string", minLength: 1 },
};
const errors = [
  { code: "INVALID_CONTRACT", retryable: false },
  { code: "NOT_ALLOWED", retryable: false },
  { code: "CONFLICT", retryable: false },
];
const notesManifest: ServiceManifest = {
  id: "notes", title: "Shared review notes",
  purpose: "Publish and retrieve fixed-source review observations.",
  provider_version: "0.1.0", contract_version: "2",
  endpoint: { transport: "in-process" },
  capabilities: [
    {
      name: "put", operation: "put",
      description: "Publish one immutable review note.",
      side_effect: "write", idempotent: true,
      help: { when: "Publish an observation with its fixed source revision." },
      input_schema: {
        type: "object",
        properties: { key: noteProperties.key, text: noteProperties.text },
        required: ["key", "text"], additionalProperties: false,
      },
      output_schema: {
        type: "object", properties: noteProperties,
        required: ["key", "text", "author"], additionalProperties: false,
      },
      errors,
    },
    {
      name: "get", operation: "get",
      description: "Read one review note by key.",
      side_effect: "read", idempotent: true,
      help: { when: "Read the original observation before using it." },
      input_schema: {
        type: "object", properties: { key: noteProperties.key },
        required: ["key"], additionalProperties: false,
      },
      output_schema: {
        type: ["object", "null"], properties: noteProperties,
        required: ["key", "text", "author"], additionalProperties: false,
      },
      errors,
    },
  ],
};

export default notesManifest;
```

### A.2 Harness 与结果保存

config 包含 model、image、backend、独立 outputDir、turnTimeoutMs、closeTimeoutMs 和上述 notesManifest。main 的调用形态是 `await main(config, optionalAbortSignal)`；停止信号由宿主接入，例如用户取消或预算到期。示例返回并保存两类失败，调用者据报告决定退出码。

```ts
// Proposal example: these package exports have not been implemented yet.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime, type Runtime, type AgentInfo, type CloseReceipt,
  type Profile, type ErrorInfo, type AgentEvent, type InputReceipt } from "@murm/core";
import { ServiceRegistry, createInProcessAdapter }
  from "@murm/core/services";
import { createPiOpenSandboxBackend }
  from "@murm/core/backends/pi-opensandbox";
import { runInput } from "./run-input.js";

type Note = { key: string; text: string; author: string };
type Read = { agentId: string; key: string };
type ErrorRecord = { message: string; code?: string; cleanup?: unknown;
  reportPath?: string; agentId?: string; requestId?: string; inputId?: string;
  details?: readonly ErrorInfo[]; event?: AgentEvent; receipt?: InputReceipt };
type Config = {
  model: string; image: string; outputDir: string;
  turnTimeoutMs: number; closeTimeoutMs: number;
  backend: Parameters<typeof createPiOpenSandboxBackend>[0];
  notesManifest: Parameters<ServiceRegistry["registerService"]>[0]["manifest"];
};

function describe(error: unknown): ErrorRecord {
  const value = error instanceof Error ? error : new Error(String(error));
  const data = value as Error & Partial<ErrorRecord>;
  return { message: value.message, code: data.code, cleanup: data.cleanup,
    reportPath: data.reportPath, agentId: data.agentId, requestId: data.requestId,
    inputId: data.inputId ?? data.receipt?.inputId,
    details: data.details, event: data.event, receipt: data.receipt };
}

export async function run(config: Config, signal?: AbortSignal) {
  const notes = new Map<string, Note>();
  const reads: Read[] = [];
  let runtime: Runtime | undefined;
  let result: AgentInfo | null = null;
  let businessFailure: ErrorRecord | null = null;
  let cleanup: CloseReceipt | null = null;
  let cleanupFailure: ErrorRecord | null = null;

  // A supplied, already-checked source observation; this example checks its
  // handoff through a custom Service, not the quality of a new code review.
  const evidence = {
    baseline: "fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e",
    source: "src/agent/services-bridge.js",
    finding: "Bridge 的通用调用身份应与 flat 的 Task/Execution 领域校验分离。",
  };
  const files = { "review-input.json": {
    encoding: "utf8" as const, data: JSON.stringify(evidence), mode: 0o644 as const,
  } };

  try {
    signal?.throwIfAborted();
    const services = new ServiceRegistry();
    services.registerService({
      // The manifest declares bounded put/get schemas and no Task context.
      manifest: config.notesManifest,
      adapter: createInProcessAdapter({
        async invoke({ capability, input, caller }) {
          const value = input as { key: string; text?: string };
          if (capability.operation === "put") {
            if (typeof value.text !== "string") throw new Error("Invalid note");
            const old = notes.get(value.key);
            if (old && (old.author !== caller.agentId || old.text !== value.text)) {
              throw Object.assign(new Error("Note content conflicts"), { code: "CONFLICT" });
            }
            const note = old ?? { key: value.key, text: value.text, author: caller.agentId };
            notes.set(value.key, note);
            return note;
          }
          if (capability.operation === "get") {
            reads.push({ agentId: caller.agentId, key: value.key });
            return notes.get(value.key) ?? null;
          }
          throw new Error("Unknown notes operation");
        },
      }),
    });

    const common = {
      model: config.model, image: config.image, writable: true,
      collect: { paths: ["."], includeGit: false,
        maxBytes: 2 * 1024 * 1024, required: true },
    };
    const profiles: Record<string, Profile> = {
      writer: { ...common, prompt: "准确转交给定的源码审查结论。",
        services: { notes: ["put"] } },
      reader: { ...common, prompt: "从共享记录核对结论及其固定源码基线。",
        services: { notes: ["get"] } },
    };
    // The factory is inside try; its ResourceError.reportPath is preserved.
    runtime = await createRuntime({
      backend: createPiOpenSandboxBackend(config.backend), profiles, services,
      maxAgents: 2, outputDir: config.outputDir,
    });
    signal?.throwIfAborted();
    const writer = await runtime.spawn({ requestId: "writer", profile: "writer", files });
    await runInput(runtime, writer.id,
      "读取 review-input.json。通过 swarm notes put 发布 key=core-service-boundary；" +
      "text 是包含原样 baseline/source/finding 的 JSON 字符串。",
      { requestId: "writer-input", timeoutMs: config.turnTimeoutMs, signal });

    signal?.throwIfAborted();
    const reader = await runtime.spawn({ requestId: "reader", profile: "reader", files });
    await runInput(runtime, reader.id,
      "通过 swarm notes get 读取 core-service-boundary，对照 review-input.json，" +
      "把结论与固定源码位置写入 review.md，并报告是否一致。",
      { requestId: "reader-input", timeoutMs: config.turnTimeoutMs, signal });

    const note = notes.get("core-service-boundary");
    const copied = JSON.parse(note?.text ?? "null");
    if (note?.author !== writer.id || !copied ||
        Object.entries(evidence).some(([key, value]) => copied[key] !== value) ||
        !reads.some(read => read.agentId === reader.id && read.key === note.key)) {
      throw new Error("Required source-review handoff did not occur");
    }
    result = await runtime.get(reader.id);
  } catch (error) {
    businessFailure = describe(error);
    if (!runtime && businessFailure.cleanup === "pending") {
      cleanupFailure = { message: "Factory cleanup is pending",
        code: "factory_cleanup_pending", reportPath: businessFailure.reportPath };
    }
  } finally {
    // Do not pass the cancelled work signal: cleanup needs its own time limit.
    if (runtime) {
      try {
        cleanup = await runtime.close({ timeoutMs: config.closeTimeoutMs });
        if (cleanup.cleanup !== "complete" ||
            cleanup.agents.some(agent => agent.execution !== "stopped" || agent.cleanup !== "complete")) {
          cleanupFailure = { message: "Run cleanup is pending",
            code: "cleanup_pending", reportPath: cleanup.reportPath };
        }
      } catch (error) { cleanupFailure = describe(error); }
    }
  }
  return { result, businessFailure, cleanup, cleanupFailure,
    serviceState: [...notes.values()], reads };
}

// Host entry: preserve the result even when business work or cleanup failed.
export async function main(config: Config, signal?: AbortSignal) {
  const report = await run(config, signal);
  await mkdir(config.outputDir, { recursive: true });
  const reportPath = join(config.outputDir, "harness-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { reportPath, report };
}
```

示例对 Service 交接验证了作者、固定源码内容和 reader 的读取证据；产物回执用于定位 `review.md`。是否接受实际文件内容还需读取归档或在具体项目的验收函数中检查，不能只因模型声称已写文件就算交付成功。

### A.3 局部检查范围

修订期间用模拟 Runtime 检查了等待 helper 的事件顺序、取消、超时、重复 ID、失败结果，以及 Harness 的工厂失败、业务/清理双失败和报告保存。它们验证示例自身控制流，不验证尚未实现的 Core、真实模型、Bridge 或 OpenSandbox。真实链路仍按第 10 节实施验收。

## 附录 B：一次性输入等待 helper

文件为 Harness 的 `run-input.ts`。仅用于第 4.1 节的严格独占场景；不能作为通用输入完成协议。timeoutMs 要为有限正整数，所有取消只结束宿主等待。已提交但结果不确定时保留请求身份并进入收尾，不通过另起一次等待猜测之前的结果。

```ts
// Proposal example, not an implemented @murm/core API.
import type { Runtime, AgentEvent, InputReceipt } from "@murm/core";

type Settled = Extract<AgentEvent, { type: "settled" }>;
type Guard = { active: boolean; unresolved: boolean; used: Set<string> };
const guards = new WeakMap<Runtime, Map<string, Guard>>();

/**
 * Harness-only helper: one input source, idle Agent, no queued input or
 * automatic continuation. A new requestId is required for every invocation.
 * Timeout/abort end this host wait; they do not cancel the Agent or its input.
 */
export async function runInput(
  runtime: Runtime,
  agentId: string,
  input: string,
  options: { requestId: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ inputId: string; settled: Settled }> {
  const { requestId, timeoutMs, signal } = options;
  const error = (code: string, details: object = {}) =>
    Object.assign(new Error(code), { code, agentId, requestId, ...details });
  if (!requestId || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw error("invalid_wait_options");
  }

  let agents = guards.get(runtime);
  if (!agents) guards.set(runtime, agents = new Map());
  let guard = agents.get(agentId);
  if (!guard) agents.set(agentId, guard = {
    active: false, unresolved: false, used: new Set(),
  });
  if (guard.active) throw error("concurrent_wait_for_agent");
  if (guard.used.has(requestId)) throw error("wait_request_id_reused");
  if (guard.unresolved) throw error("previous_submission_unresolved");
  guard.active = true;
  guard.used.add(requestId);
  const currentGuard = guard;

  return new Promise((resolve, reject) => {
    let finished = false;
    let submitted = false;
    let receipt: InputReceipt | undefined;
    let settled: Settled | undefined;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (failure?: unknown, uncertain = false) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      currentGuard.active = false;
      currentGuard.unresolved ||= uncertain && submitted;
      if (failure !== undefined) reject(failure);
      else resolve({ inputId: receipt!.inputId, settled: settled! });
    };
    const onAbort = () => finish(error("wait_aborted", {
      inputId: receipt?.inputId, reason: signal?.reason,
    }), true);
    const complete = () => {
      if (receipt?.status === "accepted" && settled) finish();
    };

    timer = setTimeout(() => finish(error("input_timeout", {
      inputId: receipt?.inputId, settledObserved: Boolean(settled),
    }), true), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    void (async () => {
      try {
        if (finished) return;
        const before = await runtime.get(agentId);
        if (finished) return;
        if (before.status !== "idle") throw error("wait_requires_idle_agent");

        unsubscribe = runtime.onEvent(event => {
          if (finished || event.agentId !== agentId || event.seq <= before.cursor) return;
          if (event.type === "error" && event.fatal) {
            finish(error("agent_failed", { event }), true);
          } else if (event.type === "exit") {
            finish(error("agent_exited", { event }), true);
          } else if (event.type === "settled") {
            if (event.outcome !== "completed") {
              finish(error("input_" + event.outcome, { event }));
            } else { settled = event; complete(); }
          }
        });
        if (finished) { unsubscribe(); return; }

        submitted = true;
        const result = await runtime.send(agentId, input, {
          requestId, mode: "followUp",
        });
        if (finished) return;
        receipt = result;
        if (result.status === "unknown") {
          finish(error("input_unknown", { receipt: result }), true);
        } else if (result.disposition === "handled") {
          finish(error("input_handled_without_model_run", { receipt: result }));
        } else if (result.disposition === "queued") {
          // The promised idle/exclusive precondition did not hold.
          finish(error("exclusive_input_was_queued", { receipt: result }), true);
        } else complete();
      } catch (failure) {
        finish(failure ?? error("send_failed"), submitted);
      }
    })();
  });
}
```

## 附录 C：确认状态与修订记录

产品目标、五个 mode 名称、四个基础工具、Core 模块化与 Harness 编程方式，以及 **Q1–Q8 的八项决策**均已确认。精确接口、backend 配置、Service v2、输入保证与清理政策是本阶段待实施和核验的目标合同；完整已确认约束保存在配套 Core 文档附录 C。

**Q4 已确认：省略 send.mode 时默认 steer，显式 followUp 仍可选。** 本文 PeerMesh 串行 router 和 runInput 一律显式 followUp。**Q8 已确认：首版为 TaskPool + PeerMesh + 最小开发者示例。** 本轮先通过文档 PR 将设计纳入 main，再按入库版本建立总 issue 与分阶段执行 issues。

2026-11-23 本轮同步 Q1–Q8：首版 Pi/OpenSandbox、配置冻结、独立目录、默认 steer、idle 保留资源、required 导出失败保留 sandbox、PeerMesh 核心闭环及 TaskPool+PeerMesh+最小示例。此前修订合并原正文与接线附录，统一各模式的结构；修正输入等待前提、事件错误快照、TaskPool 准备期 heartbeat、模型授权接缝、三类 Agensh 身份映射、原生 Git 凭据和有期限收尾。
