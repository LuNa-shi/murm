# 五种 Environment 的实现差距审核

审核 [#199 Subagents](https://github.com/LuNa-shi/SwarmEnv/issues/199)、[#200 Flat](https://github.com/LuNa-shi/SwarmEnv/issues/200)、[#201 Agensh](https://github.com/LuNa-shi/SwarmEnv/issues/201)、[#202 ScaleMAS](https://github.com/LuNa-shi/SwarmEnv/issues/202) 和 [#203 Lead-helper](https://github.com/LuNa-shi/SwarmEnv/issues/203)。结论供 owner 确认改动范围和深度。审核覆盖固定源码、普通安装入口、Service 及历史验收证据。本轮没有启动新的模型、原生环境或 benchmark 运行。

| Environment | 建议改动深度 | 首要差距 |
| --- | --- | --- |
| Subagents | 重做普通 Environment | 当前入口规定人数、固定题型和逐字引用，缺递归目录、外部消息与同 Turn 等待 |
| Flat | 补生产接线，局部清理宿主配置 | 当前 Core 装配缺运行中可信字节到公共 Workspace revision 的生产链路 |
| Agensh | 重做项目输入和交付装配，扩展 router | 普通入口播种固定验收内容，可信合入靠测试驱动，缺即时 notice 和持久事件处理 |
| ScaleMAS | 先补持久内容闭环，另决定论文复现深度 | 已有 substrate，论文发布、读取、排序与自主推进方式都有差异 |
| Lead-helper | 重做默认 driver，保留 Board 事务 | 固定两波工作、宿主补充和全员反馈限制动态方向，缺共同产物验收 |

## 基线与导航

- 当前实现基线是 [SwarmEnv `ec4d286f1f452eb03bb11113ff9c48234c1357c1`](https://github.com/LuNa-shi/SwarmEnv/commit/ec4d286f1f452eb03bb11113ff9c48234c1357c1)。Phase 0005 的 Q1–Q8 和范围调整按该树的[固定设计](https://github.com/LuNa-shi/SwarmEnv/tree/ec4d286f1f452eb03bb11113ff9c48234c1357c1/docs/phases/0005-core-environment)解释。五张下一阶段 Issue 的接受条件另行核对。
- [#198](https://github.com/LuNa-shi/SwarmEnv/issues/198) 是共用依赖。本报告对其开发分支的观察固定为 [`43184a06ef30abf0c8f795ca81bda812b59e3afb`](https://github.com/LuNa-shi/SwarmEnv/commit/43184a06ef30abf0c8f795ca81bda812b59e3afb)。候选有实现时，仍应独立验证新包、Worker 和普通入口。
- [#185 的五次历史长跑](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7127956232) 使用各自的固定版本。它们证明预设场景下真实执行、交付及清理。候选安装验证另见 [#164 的冻结回执](https://github.com/LuNa-shi/SwarmEnv/issues/164#issuecomment-7132163510)。
- [Subagents](#subagents-199) · [Flat](#flat-200) · [Agensh](#agensh-201) · [ScaleMAS](#scalemas-202) · [Lead-helper](#lead-helper-203) · [Core 共用缺口](#core-共用缺口) · [完整任务评测](#完整任务评测) · [实施前决策](#实施前决策)

## Subagents #199

详细逐项对照见 [Codex V2 Subagents：功能清单与 SwarmEnv 对照](subagents-v2-feature-checklist.md)。该清单按原版功能核对当前代码、补改位置和验收方法；下面保留本总览对应的历史观察。

参考是 [Codex MultiAgentV2 `a0d5b0a661db3b34cd87bdf1c93736b90fd3694b`](https://github.com/openai/codex/commit/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b)。#199 采用 SwarmEnv 的四基础工具、Bash CLI 和外部 Service 来实现协作语义。

当前普通入口的 `childCount` 默认 2、范围 2–7。Root prompt 要求精确人数、一个原 Child 续轮，以及逐字引用恰好 `childCount + 1` 份结果。Child 无权继续创建。Controller 只向固定 parent 路由直接孩子的结果，用 `send(mode: 'followUp')` 送达。可选 staged 接口还要求三个原始孩子和四个有序阶段。**固定人数、题型、阶段、谁来续轮和逐字引用解析器应迁到 fixture。** 普通 Env 接完整用户任务，配置安全上限与权限，接受零委派、一个或多个 Child、三层递归与自然收尾。[普通入口](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/examples/subagents-environment/main.mjs) · [Prompt](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/examples/subagents-environment/prompts.mjs) · [Controller](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/examples/subagents-environment/controller.mjs) · [四阶段接口](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/examples/subagents-environment/stages.mjs)

### 参考配置分支

| 分支 | 固定源码的条件或默认 | 拟纳入的深度 |
| --- | --- | --- |
| 六能力主配置 | 显式选 V2，开启 native tools、direct message 和 wait，选择允许 Child 看见 V2 工具的 model metadata。默认 namespace 为 `collaboration`，并发配置值 4，wait 最小/默认/最大分别为 10 秒、30 秒、1 小时 | 冻结有效配置和实际工具清单，执行六项差分。记录容量是否包含 root。小于最小 wait 的请求 clamp，超过最大值拒绝 |
| 功能关闭 | `disable_direct_message` 移除 `send_message` 和 `followup_task`。自动子结果独立。关闭 wait 去掉 `wait_agent`。关闭 native tools 可保留 V2 runtime 给宿主工具 | 验证对应 Profile 的能力发现和真实调用拒绝。核对自动结果是否保留 |
| 角色、覆盖和暴露分支 | namespace、code-mode exposure、Child model metadata、角色、模型/推理覆盖、service tier、metadata 隐藏和 usage hint 改变可见合同。固定版默认隐藏 spawn metadata、配置允许展示模型覆盖，service tier 默认关闭 | 建议首批固定宿主 Profile 和模型。逐项记录差异。若开放覆盖，验授权列表与拒绝。SwarmEnv 的 `maxDepth` 是本地策略，Codex 的 `[agents].max_depth` 用于 V1 |
| 历史及兼容输入 | 省略 `fork_turns` 默认为 `all`，支持 `none`，旧正整数按完整历史处理。另有 `preserve_fork_prefix` 和 compaction 边界 | 主配置做 `all/none` 真实差分。记录旧整数兼容与特定历史布局差异 |
| 中断及消息存储 | 可选 `interrupt_at_item_boundary`、内存/远程 message board、idle 子线程驻留与恢复 | 首批验普通中断并列明已选分支。Pi 原生工具调用、消息项、idle 卸载恢复及离线 replay 按 #198/#199 已定边界处理 |

[参考配置](https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/config/mod.rs#L1466) · [工具注册](https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/tools/spec_plan.rs#L731) · [V2 spawn 参数](https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L204)

### 六项操作和子结果

| 操作 | 改动与验收 |
| --- | --- |
| `spawn_agent` | **重做外部目录和授权，接 Core fork。** 用可信 caller 建 canonical 路径与父子边。保留请求身份和未知创建的核对。真实 `/root/A/B` 递归、容量和越权反例须从普通入口走通。用 Child 首个实际模型请求区分 `all/none`，验证工具调用边界、父子独立演化、工作区模式和凭据隔离 |
| `send_message` | **做外部 inbox。** Codex `QueueOnly` 不开 idle Turn，#198 的 `steer` 会唤醒 idle。Idle 消息留队列。若策略选择即时推送给 running Bot，要处理 running 切到 idle 的竞态并以 Gateway 请求证明可信来源对模型可见 |
| `followup_task` | **单独定义激活政策。** Codex 对 idle 启动、对 running 按消息边界交付，拒绝 root 为目标。全映射成 `start` 会把 busy 目标的输入推到下一大阶段。冻结本地 busy 分支，验同 Bot/Session、root 拒绝、并发和未知回执 |
| `wait_agent` | **做外部可取消长等待。** 原生 wait 观察 mailbox 或用户 steer 活动，返回状态，正文由原生输入消费。Bash 等待 Service 可直接回正文。原子检查已有消息并订阅新消息，验先到、后到、并发、超时、取消及关闭。证明响应进入同一 parent 大阶段的后续模型请求 |
| `interrupt_agent` | **接非破坏性中断。** 保留身份、Session 和文件。验重放、迟到中断、执行换代以及受理与实际停止。中断与销毁各走其资源合同 |
| `list_agents` 与子结果 | **做可信目录、前缀及终态路由。** Core `list` 提供宿主观察的 Bot 集合，Env 归属同树可见性和跨树拒绝。结果进入真实直接父的 mailbox，idle 父保持 idle。验完成、失败、取消及去重，并阻止通过旧 bot Service 绕过新规则 |

[Codex 消息控制](https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control/api.rs#L113) · [Wait](https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L44) · [完成通知](https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control/completion.rs#L28) · [目录](https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control.rs#L389)

#185 的 `7ac891b` 真跑用了 1 父 3 子、4 组预定工作，证明了 12 次子工作输入的交付、续轮、引用、归档和清理。新验收至少覆盖 parent 同 Turn 等两个孩子、动态三层递归与外部输入、fork 后一子中断复用及另一子继续。每项核对真实模型输入、Service 可信来源和最终结果，另保留权限、超时和关闭反例。[原始回执](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7127956232)

## Flat #200

参考是 [迁移前 `fcbe0107`](https://github.com/LuNa-shi/SwarmEnv/commit/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e) 和 [Environment §6](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/docs/phases/0005-core-environment/02-environment.md#6-flat)。旧 v1 Bridge 将保存交给领域 Runtime，从绑定的 OpenSandbox Worker 读取运行中的项目。迁移后的 Flat 在普通 Core 下组合发现、排他认领、文件准备、授权和收尾，并继续使用 `ExecutionWorkspace` 的领域保存及 Git 恢复。生产断点是运行中可信字节怎样进入同一领域合同。[旧 Bridge](https://github.com/LuNa-shi/SwarmEnv/blob/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e/src/agent/services-bridge.js#L600) · [当前装配](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/flat/environment.js#L15)

| 项目 | 改动与验收 |
| --- | --- |
| 只读发现、排他 take 和模型权限 | **保留，重验。** Flat 绑定可信 caller、Mission/Task、Execution、lease 和 fence。保留准备期 heartbeat、固定 revision/Material 输入、激活后 grant、模型调用门禁与一 Bot 一 Execution。正常入口测竞争输家、身份造假、文件准备中断、lease/spec 变化和补位 |
| 生产 live save | **补真实 Core 接线。** 当前 `snapshotProject` 依赖宿主注入。无绑定时隐藏 live save、私有 status/current diff，保留公共 Workspace 与 Material。将 `files.snapshot` 的请求、真实 Bot、文件版本和 digest 绑定到 Execution/fence 和保存 lineage。验真实 Bash 写随机文本与二进制，固定 revision 回读与消费，以及保存方原 Session 续跑 |
| 重放、未知与停机 | **保留持久事务，补生产证据。** 同请求回原结果，变参冲突。未知捕获与已捕获但未知发布分开核对。验证并发写、lease/fence 变化及 stop 的各阶段竞态。执行确认已停才做领域补偿，物理清理完成才释放 Slot |
| 公共读、Material、Judge 和 merge | **保留独立合同和配置开关。** 公共 Workspace、Material/finish、固定 revision Judge、checked merge、Mission 接受分别核对。旧 active-project apply 沿用退役与历史安装结果恢复边界。Task 终态回执、Mission 检查回执各自取证 |
| 定向反馈 | **接新输入原语。** 发现、续轮用 `start`，定向即时反馈用 `steer`。提交前复核当前 owner、Execution 和 fence。已结束或换主则拒投，未知核对原请求。非破坏性 `interrupt` 保留 Session，领域释放仍由 stop 回执及补偿决定 |
| 脚手架 | **局部清理。** 历史 `flat-hour`、预置编程候选、verifier 已退役。保留通用的宿主准入 hook 和预算。固定数据、唯一通过路径及 `automaticContinuation=false` 的测试编排留在 fixture，正式配置走自然发现与续轮。修正启动说明里把缺 capture 一概写成启动失败的旧表述 |
| 自主拆分完整任务 | **需明确是否纳入。** 普通 Task Service 支持发现、take、修订或取消已有 Tasks，模型创建新 Task 的入口已退役。若要让 Flat 自主拆单，授权创建与策略归 Flat Service。沿用宿主预分解时，明确记录为实验条件 |

[Handoff](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/flat/task-handoff.js) · [模型授权](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/flat/model-access-policy.js) · [发布适配](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/flat/publication-services.js#L94) · [持久保存](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/runtime/execution-workspace.js) · [当前 Task Service](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/flat/task-service.js#L45) · [脚手架退役](https://github.com/LuNa-shi/SwarmEnv/commit/952570a) · [#198 快照](https://github.com/LuNa-shi/SwarmEnv/blob/43184a0/src/core/file-controls.js#L107)

历史 `7643cf1` Core 加 `e388064` 宿主用预置公共 revision 完成 17 次输入、17 个 Material、替补采用及五个 sandbox 清理，明确 `liveCapture:false`。注入快照的 CLI 和域存储回归另覆盖捕获合同、二进制和重放竞争。两类回执均应保留。#200 新门槛是实际安装入口的 **Worker 字节 → 原领域保存事务 → 公共 revision → 消费者**。[长跑](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7127873712) · [冻结候选回执](https://github.com/LuNa-shi/SwarmEnv/issues/164#issuecomment-7132163510) · [Flat 实现](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/docs/architecture/02-execution.md)

## Agensh #201

参考是 [microsoft/Agensh `2dae4e14a653da48549fd9aa093f834841475d6c`](https://github.com/microsoft/Agensh/tree/2dae4e14a653da48549fd9aa093f834841475d6c) 与 [Environment §8](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/docs/phases/0005-core-environment/02-environment.md#8-agensh)。上游把 seed、Issue、启动提示、时间策略和导出交给 task pack，由 dispatcher、Board、Git 等设施承载 peer 协作。本地已退役历史小时 runner，但 `provision.js` 默认创建 `acceptance.txt` 和固定验收 Issue，peer prompt 也要求遵循固定验收。可信合入模块 `createAgenshDelivery` 在 `src/`，调用点在测试。**普通装配缺真实项目输入到共同 main 的交付闭环。**[上游 driver](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/agensh/README.md) · [本地固定 seed](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/agensh/provision.js#L67) · [当前交付模块](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/agensh/delivery.js) · [普通前台入口](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/shared/foreground-host.js#L40)

| 项目 | 改动与验收 |
| --- | --- |
| 项目 seed、提示和收尾 | **重做装配，迁走固定验收数据。** 固定文件、固定 Issue、第二轮 checkpoint 和 canary 回到 fixture。普通配置接项目 seed、真实 brief、kickoff 与停止条件。保留设施所有权、peer 身份、工作目录、Session、Board 和清理。对照上游规划先行、idle watchdog、pause/finalize 和 resume，首版冻结要支持的工作与收尾分支 |
| Git/PR 与共同 main | **补正式合入。** 上游有 PR 与 main-health 策略，本地测试合入路径仍限制每 peer 的非 rejected 交付。普通项目可连续提交多个 PR。固定 head、merge authority、冲突、未知及合入回读都需有证据。当前设施授予 repository `write`，Service 校验 PR head，源码未显示相应的服务端分支保护装配。验证 peer 无权直接写 main 或他人分支 |
| 串行 dispatcher 与事件源 | **迁到 `start` 并补持续路由。** 上游持久事件、串行 ACP prompt、失败回退与启动恢复。本地是定向轮询、内存队列、`followUp` 与未知 fence，来源默认只读最新一页且有总轮询上限。明确游标、积压、重放冲突和待核对状态，反例覆盖 busy、突发与长时间运行 |
| mid-turn notices | **做可配置的 Env 适配。** 上游 MCP shim 在工具结果处租取 DM 和未读 gist，追加到响应并标记 shown，dispatcher 消除已投递的 DM。本地目前只在 settled 后发下一批。常规事件用 `start`，即时 DM 或关键提示可用 `steer`。关联可信来源、实际模型可见与后续批次去重。Pi 的工具步骤边界要与上游单个工具结果边界分别观察 |
| Board CLAIM/TTL 与共享上下文 | **保留软协商，补 TTL 和真实采用核验。** 固定上游 CLAIM 默认 3600 秒，可由请求覆盖。本地 `board_write` 未暴露 `ttl_seconds`。用真实 Board 验保存、过期后渲染及 peer 冲突协商，确需覆盖时提供有界参数。Gist、共享 lessons 和 DM notice 的消费分别取证 |
| 身份、凭据及清理 | **保留现有机制，补正式入口证据。** 检查 Gitea、Mattermost、Board 各自的可信映射和权限。停止事件源、确认 Core 与 required archives，再关本次拥有的设施。共同 repo、Board 及未知事件可读回。上游恢复 ACP Session 与本地复用活 Pi Session 分别记录 |

[上游 dispatcher](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/mini-router/src/dispatcher.ts#L47) · [上游 notice shim](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/mini-router/mcp_notice_shim.cjs) · [上游 Board](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/board-service/main.py#L42) · [本地事件源](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/agensh/event-source.js) · [本地 Service](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/agensh/services.js)

`7643cf1` 的历史八 peer 真跑有 40 个 durable Git 贡献和外部事件定向后的采用证据。原 wrapper 因报告文件名不匹配退出，独立回读另外确认了原产物。#201 的普通入口应从同一真实项目启动两只 peer，证明 A 的信息被 B 采用，两者贡献进入固定 main，且外部事件驱动原 peer 继续。短会话、失败、重复、未知及收尾均按真实回执判定。[长跑原始回执](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7124839747) · [#201](https://github.com/LuNa-shi/SwarmEnv/issues/201)

## ScaleMAS #202

审核以 [arXiv:2610.16120v1](https://arxiv.org/html/2610.16120v1) §2、§3 和附录 C 为准。论文和作者条目未找到可核验的官方 ScaleMAS harness。论文由无指定角色、异步运行的 peers 通过追加式 datastore 协作。本地 SQLite 已实现可信作者、同 run 准入、不可变内容、引用及 publish 请求账本。[作者条目](https://zhentingqi.github.io/) · [本地 substrate](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/scalemas/substrate.js)

| 项目 | 改动与验收 |
| --- | --- |
| 作者、精确字节、版本、摘要 | **#202 要补。** 当前 `visit` 返回作者、`version: 1`、文本和引用，地址哈希还包含 run、作者与请求等身份。补可独立核对载荷的 SHA-256 和规范字节定义，从真实读取返回核对原文、作者、版本、摘要与引用。保留跨 run、坏引用、请求重放与变参冲突 |
| 退出后访问及采用 | **提高证据门槛。** 当前 host verifier 容许 publisher 已停止但 cleanup pending，`visit` 的持久读取日志只记地址。先确认原 publisher 实际资源释放，再从 B 的原 Session 读取完整贡献。引用边用于追踪，实际采用由后续新贡献及独立 checker 验证 |
| 发布、检索、访问合同 | **若做论文机制复现则要改。** 论文有子问题、artifact、rationale 和引用，可引用任务资源。Search 与 visit 返回有界的原始消息及邻接内容，agent 视图隐藏作者及 citation weight。本地有单一文本、最多 16 条同 run 引用、搜索摘要、单地址 visit，并显示作者与 rank。#202 的可信出处回读可以和论文匿名视图分开配置 |
| 排序和成本 | **论文主张需要独立实现与实验。** 论文以归一化 BM25 加衰减 citation weight，引用可改变两个相关候选的顺序。本地按词命中数、仅同分时按入链数、再按地址，并扫描整个 run 内容。返回数有界，后端扫描随记录增长。若复现论文排序，验相关性、逆序、衰减、无关结果过滤，及排序改变是否提高下游采用 |
| 固定池、driver 和终止 | **保留固定池，拆出完整任务 driver。** 本地是 3–8 peers、宿主轮数、逐 peer/round 输入和回调。论文 peers 自主行动并提交最终回答，部分实验按 Pass@N。把固定 stop 和 handoff 留给机制测试，完整任务让 peers 对同一个问题异步推进。若要求一份最终交付，先确定候选选择与冻结规则 |

[论文发布和检索规则](https://arxiv.org/html/2610.16120v1#S2) · [本地 driver](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/scalemas/index.js#L27) · [协作 verifier](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/scalemas/collaboration-evidence.js#L13)

`47b33a9` 的六 peer 真跑有 36 个经过编程检查的不可变贡献，A 实际停止后保留十条后续 durable references。新验收要证明真实释放、同 Session 的内容回读与后续采用，覆盖持久故障、输入未知和清理 pending。Core 提供生命周期、Session 连续性与 Trace，排序和存储策略归 substrate Service。论文检索复现与规模/性能结论各自需要专门对照。[ScaleMAS 长跑](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7126892228) · [#202](https://github.com/LuNa-shi/SwarmEnv/issues/202)

## Lead-helper #203

参考是 [Anthropic 的 Fable 5.2 实验说明](https://claude.dev/blog/safely-scaling-multi-agent-teams-with-fable-5-2/) 与 [Environment §9](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/docs/phases/0005-core-environment/02-environment.md#9-lead-helper)。公开材料未附可逐行核对的实验 harness。原实验中 1 lead 和 999 helpers 在独立 sandbox，使用共享 PostgreSQL 和 Git。Lead 建表、读难度反馈、重分配，helpers 自主接单和递归拆分，成果最后进入共同 main。本地固定团队、SQLite Board 的唯一 owner、revision CAS 和 Git 字节验证覆盖了这套机制的一部分。[实验 harness 描述](https://claude.dev/blog/safely-scaling-multi-agent-teams-with-fable-5-2/#harness) · [本地 Board](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/lead-helper/board.js)

| 项目 | 改动与验收 |
| --- | --- |
| 默认两波 workflow | **重做默认 driver。** 当前流程强制全员初始分配、全员完成并反馈、固定 user supplement、lead 引用每人，再全员续轮。可选 staged 入口还固定三 helpers、最多四阶段和角色到交付路径映射。将这些条件留为 fixture 或显式场景。普通运行让 lead 决定何时怎样调整，helpers 按相同根任务分阶段行动 |
| 方向、重新分配和 claim | **保留事务，验证动态路线。** 更改 helper 的下一项工作和重置已有 claimed task 是两种动作。本地唯一 owner、revision 及重放冲突应保留。验真实 feedback 导致方向或优先级变化，随后旧 helper 读取并执行新选择。owner 接管、过期回收和替补可另议 |
| 真实采用证据 | **改业务验证。** 当前验证读过最新 direction、交付真实 Git 字节，并要求改方向后的 artifact 含完整方向文字。固定文本题可以验证 framing，完整项目应以实际行为变更为证据，例如新接口约束进入可独立运行的集成测试。仍保留 direction ID、读取和固定 commit/digest |
| Git 和共同产物 | **补合入及最终 checker。** 当前 Board 验 branch commit 和精确字节，PR 可选，普通 workflow 没有可信 main 合入和根 checker 链。核对 Gitea 对 main 与他人分支的实际权限，保留部分成果，处理 Git 已落地但 Board 回执未知 |
| Core 输入及工作区 | **接 `start` 和 Trace，按场景用 `steer` 或 `interrupt`。** 方向可由 Board 读取。确实影响当前工作时可提醒原 helper。中断保留 Session 和文件，领域归属由 Board 处理。原实验是独立 sandbox 与 Git，Core 的可选共享目录适合另作配置评估 |

[普通 driver](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/lead-helper/index.js#L236) · [本地 Git 验证](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/environments/lead-helper/git.js#L74) · [原实验的反馈与重新分配](https://claude.dev/blog/safely-scaling-multi-agent-teams-with-fable-5-2/#results)

`30c3035` 的历史四 Bot 回执有 20 次输入、12 个经检查的 Git/Board 交付和完整清理。普通入口的新证据应包括同一工作争用只有一个 owner、真实公开反馈引发方向变化、helpers 自主创建工作、变更后的产物被合入和验收，以及非 owner、重放、部分成果、未知输入与停止竞争。一千人的规模、通用 SQL 与原实验主动重启是额外参考条件。[Lead-helper 长跑](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7126614478) · [#203](https://github.com/LuNa-shi/SwarmEnv/issues/203)

## Core 共用缺口

| 能力 | 主线现状 | 候选进展与待验证边界 |
| --- | --- | --- |
| `start / steer / interrupt / list` | 公开 API 有 `send(mode)`、单 Bot `get` 及生命周期 `stop` | 新 API 已在候选出现。验 busy/idle 边界、迟到输入、中断保留身份及 Session、枚举 starting/closed/pending，和 `accepted` 到实际模型消费的关联 |
| 活 Bot fork 和工作目录 | 有 prepare/grant 及 Bot 停后收集 | 候选有活历史 fork、可信 live snapshot 和受控共享。验 Child 第一个请求历史边界、凭据隔离、父子演化、共享只读/写权限、并发写入、stop 以及最终所有者清理。Flat 自行适配 Execution/fence |
| Bridge 长等待与取消 | 有 Service 超时、授权与部分撤销 | 候选有断连取消和新增流水。需要对齐 Bash CLI、Bridge HTTP 和 Service 各层时限，测先到/后到、断连、中断、撤权和关闭。消息目录与等待政策归 Env/Service |
| 完整 Trace | 主线已有运行记录与成果收集 | 候选有原生 Session 归档、Gateway 请求/响应与 Bridge 流水。五种 Env 需要用正常、失败、中断路径核验记录完整性、时间关联、访问权限、认证密钥隔离及缺失/pending |

[主线公开 API](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/src/core/index.d.ts#L165) · [候选公开 API](https://github.com/LuNa-shi/SwarmEnv/blob/43184a0/src/core/index.d.ts#L199) · [候选 Bridge](https://github.com/LuNa-shi/SwarmEnv/blob/43184a0/src/core/bridge.js) · [Core 验收 #198](https://github.com/LuNa-shi/SwarmEnv/issues/198)

还需验证两个边界。候选 `steer` 的 `source` 进入宿主记录，Pi 收到的仍是文本，模型是否看见发件信息要用真实 Gateway 请求验证。候选 `interrupt` 已给原请求分配执行代次并支持重放，但公开调用未接受调用者此前观察到的预期代次。若业务要求一个延迟提交的**新**中断请求只能影响原阶段，先构造反例，再判断 Env 串行化或条件式 Core 操作各能保证什么。[候选 Runtime](https://github.com/LuNa-shi/SwarmEnv/blob/43184a0/src/core/index.js#L455) · [候选 Pi 传输](https://github.com/LuNa-shi/SwarmEnv/blob/43184a0/src/core/pi-opensandbox-backend.js#L231)

## 完整任务评测

**小场景继续验证机制，整体任务用来评价协作。** #185 的固定小题和窗口能稳定触发引用、回传、合入、替补和资源释放。要回答 MAS 能否自己发现依赖、调整分工并交付完整项目，每次应把同一个根问题交给整个团队，固定起始可见信息和最终 checker。历史 Agensh Seymour 轨迹提供一个可观察案例，从 claim、跨分支转移、修复冲突到共同结果验收可以沿实际产物追踪。这里引用的是既有记录，本轮未复跑。[固定短题的原始验收](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7127956232) · [历史 Agensh 真实任务](https://github.com/LuNa-shi/SwarmEnv/blob/ec4d286/docs/experiments/EXP-20261120-09-agensh-seymour-paper.md)

固定版 Agensh 自带 **ProgramBench task pack**。团队每次接一个原始任务，在隔离环境用参考程序和文档实现完整仓库，从已提交的共同 main 导出给独立 evaluator。#205 可选一个规模可控且有明显跨组件集成的 ProgramBench 项目，或具备隐藏集成测试的小型工程 Issue。给各模式相同业务 brief，由 root、lead 或 peers 自行组织。Flat 任何宿主预拆单都应列为实验条件。正式 benchmark、预算、模型、验收、停止规则在 #205 确认。[Agensh task pack](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/tasks/programbench/README.md) · [ProgramBench 论文](https://arxiv.org/abs/2605.03546) · [#205](https://github.com/LuNa-shi/SwarmEnv/issues/205)

| 结果维度 | 记录 |
| --- | --- |
| 协议 | 本模式使用了哪些 Service、工作区或输入原语，各自的正负例、未知、失败和清理状态 |
| 业务 | 团队提交的唯一候选、固定 revision 或 digest、独立 checker、到验收的时间和用量。若另报 Pass@N，将候选命中与团队最终选择分开 |
| 协作贡献 | 至少追出一条 A 产出 → B 实际读取并形成变更 → 进入最终候选 → checker 验证相关行为的事件和产物链 |
| 因果对照 | 要估计协作收益，使用同任务、模型、初始材料和资源规则，比较单 Agent、等人数独立采样和 MAS。记录壁钟和总用量，使并行额外尝试和跨 Agent 信息复用各有证据 |

## 实施前决策

1. **#199** 冻结六能力主配置及必测关闭分支。确定角色、模型覆盖和中断边界哪些属于首版发布门槛。
2. **#200** 先接生产 live save 与定向反馈。确认自主建 Task 是否在此次范围，及所需领域授权。
3. **#201** 确定首版的真实项目装配、生产合入和即时 notice 范围。保留通用设施、软 CLAIM 和可信身份，固定验收数据回归 fixture。
4. **#202** 先保证持久内容的精准回读与跨 Agent 采用。另决定同票是否纳入论文读写、排序和基准复现。
5. **#203** 将默认 driver 的动态调整、实际采用和共同产物定为普通入口门槛。保持 Board 所有权，明确现有 owner 的接管边界。
6. **#198 / #205** 冻结 Core 和 Worker 验收版本，再决定完整任务的冻结配置、预算、对照和独立 checker。可扩展性由未见过的独立 MAS 另行验证。

具体实施决定、证据和验收进度留在相关 Issue。本文保留本次源码审核与建议。
