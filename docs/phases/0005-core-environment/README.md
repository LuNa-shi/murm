# Phase 0005：Core / Environment — Build your own swarm

> 本阶段唯一权威设计 · 2026-11-23 · 目标规范，尚待实现和验收

## 权威入口与适用范围

按项目负责人 2026-11-23 的明确要求，**本目录在 `main` 上已合入的版本，是 Core / Environment 阶段需求、范围、设计决策和验收条件的唯一权威**。先通过文档 PR 完整入库，再依据该版本建立一个总 issue 和分阶段、可验收的子 issues。

GitHub issues 负责实施切片、真实阻塞关系、进度、PR 和验收证据。每张票引用本目录的固定 commit 与对应章节；票内摘要不能独立改写本目录的要求。若摘要与设计冲突，以本目录为准并修正任务；需求变化先通过文档 PR 更新权威设计，再同步受影响 issues。后续文档修改应明确影响的任务，不能静默改变已验收版本。

这一权威规则仅适用于 Phase 0005。其他阶段保留既有的 Issue-led 工作方式。[Architecture](../../architecture/INDEX.md) 继续说明实际运行的代码；历史 ADR、旧阶段设计和 Notion 来源用于理解背景，不覆盖本目录的新阶段合同。当前文档发布不表示新 Core 已实现、旧运行逻辑已迁移或任何真实实验已经通过。运行预算、对外发布等仍遵守[项目工作约定](../../../AGENTS.md)。

## 阅读顺序

| 文档 | 内容与权威边界 |
| --- | --- |
| [Core 设计](01-core.md) | Core/Runtime/Bot/Slot 定义，公开 API、输入和事件、模型与 Service 授权、文件准备与成果导出、停止关闭、迁移与验收；包含完整公共类型附录 |
| [Environment 设计](02-environment.md) | 普通宿主模块装配，flat、agensh 和后续三种模式的协作、输入、结束与验收；包含完整 Notes 示例与 runInput helper |
| [推进、验收与发布](03-delivery-and-validation.md) | 开发、本人的使用验收、条件启动的外部试用与发布、时间窗口和收尾检查 |

Core 文档定义公共接口及其最低保证；Environment 文档在此保证内定义各模式。推进计划安排交付顺序，不改变技术合同。单次宿主等待的 60 秒是建议默认值，具体配置需要有界且可检验，不是整个项目的耗时承诺。

## 已确认决策：Q1–Q8

| 决策 | 本阶段采用的选择 |
| --- | --- |
| Q1 | 首版仅 Pi 1.3.0 + OpenSandbox；保留内部 backend 边界，不公开通用多执行器插件接口 |
| Q2 | Profile 与 ServiceRegistry 启动前装配并冻结；可按既有 Profile 动态 spawn |
| Q3 | 各 Bot 有独立 Session、sandbox、workDir；经 Git、Service 或显式 artifact 交接，不共享私有目录 |
| Q4 | `send` 默认 `steer`；显式 `followUp` 可用；agensh 串行 router 与一次性等待 helper 明确使用 `followUp` |
| Q5 | idle 继续持有 Session、workDir 与 Slot；`settled` 不代表业务完成或资源释放 |
| Q6 | 预先声明 required 的成果导出失败，停执行后保留 sandbox 与 Slot，报告 cleanup pending 并允许核对、重试 |
| Q7 | agensh 首版验证 Git/PR、peer messages、shared context 与事件续轮核心闭环；完整 mid-turn notices 和 ACP/MCP 运维细节不作门槛 |
| Q8 | 首版最低交付为 **flat + agensh + 仓库外最小开发者示例**，三者实际复用同一 Core 并通过验收 |

`subagents / scaleMAS / lead-helper` 保留为后续累计交付目标，不阻塞 Q8 首版。Core 内置 Bot Service 的合同验证不等于 subagents Environment 已交付。旧稿中的“Task/Material + 无 Task 公共结果库”不再定义第二个正式 mode；当前第二个 mode 是 agensh，Notes 示例负责证明无 Task 自定义 Service 接入。

## 实现基线、术语与证据

- 固定 SwarmEnv 基线：[`fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`](https://github.com/LuNa-shi/SwarmEnv/commit/fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e)。该版本仍有 Runtime、Bridge、模型访问与 Task/Execution 的耦合；目标 API 尚未落地。
- Core 是可导入的库；Runtime 是一次运行的宿主对象；Slot 是容量单位；workDir 是 Bot 私有目录；Workspace 保留 flat 公共 Git 项目的领域含义。旧实现的 `coreId` 不能被误当作新 `Runtime.id`。
- Pi 与 Agensh 的固定参考版本保留在详细设计中。已有原生 Agensh 实验使用独立执行链；它不构成“flat 与 agensh 已共用新 Core”的证据。
- API 类型与附录代码说明目标合同；类型检查、模拟 Runtime 或局部 helper 检查不代替真实 Pi/OpenSandbox、Service 交接和双 peer 协作验收。
- 每个实现切片应有固定输入、参与角色、实际行为、明确失败判定和相应预算前提；保存版本、prompt/Profile/manifest、请求与事件身份、结果内容以及 execution/cleanup 回执。业务成功、执行收束、产物保存与资源清理分别判断。
- 实现 PR 同步维护实际 Architecture；规范调整、执行进度与真实证据各有明确位置，不另建状态账本。

## 文档迁移与版本来源

| 来源 | 源修订时间 | 入库处理 |
| --- | --- | --- |
| [Notion Core 设计](https://app.notion.com/p/4214e07aa023818d80cdd0a88891299c) | `2026-11-23T11:10:12.147Z` | 完整正文、类型与参考附录；转换 Markdown，更新阶段状态 |
| [Notion Environment 设计](https://app.notion.com/p/4214e07aa023813e9e5bdeb3dc7b3e32) | `2026-11-23T11:10:13.849Z` | 完整五模式、Notes 与 runInput；转换 Markdown，更新阶段状态 |
| [Notion 收尾计划](https://app.notion.com/p/41f4e07aa023816a962ec311172f3599) | `2026-11-22T15:00:32.538Z` | 保留推进、试用、发布内容；将过时的未定范围与阶段时态对齐 Q1–Q8 |

[11 月 21 日项目方案](https://app.notion.com/p/41f4e07aa0238193a49af0567b5aa16a)仅作为历史讨论来源，不是并行的实施规范。旧文中通用 BotExecutor、物理拆包数量、第二协作机制、完整交互等候选，均不得覆盖本目录的已确认范围。

本次迁移保留详细设计代码围栏内部原文、固定源码引用和全部验收/失败路径；只转换 Notion 格式、修复误识别的代码链接、更新交叉链接和已被最新指示取代的“暂不创建 issue”状态说明。

## 交付门槛与时间窗口

第一条真实无 Task 路径、flat 兼容回归、agensh 单 peer 到双 peer 协作、仓库外自定义 Environment，逐项以运行证据判断完成。基本版本先由文翔按说明在自己的任务与环境中使用，通过后再交给外部用户；对外发布前处理主要使用阻塞。

“前三天 Core”“一周版”“第 5–7 天可运行”“第 8–10 天本人验收”是计划窗口，应按真实阻塞校准，不是逐票承诺。**2026-12-07 是收尾检查点，不能以日期到达替代验收，也不意味着此次文档 PR 已安排自动提醒或实际发布。**
