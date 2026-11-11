# 当前实现与证据状态

> Type: Implementation / evidence snapshot · As of: 2026-11-11 · Code tree: `02adbb43d39e0b23befb7f2ffc4b19ffb386a36d`（PR #115）
>
> 本表为人工可读的核对索引，不声明所有能力通过真实 Agent 验收。完成一个新代码 PR 或实验后应更新本表，不沿用旧 Issue #111 的静态通过清单。

| 模块/能力 | 代码与现有记录能说明什么 | 尚缺的证据或限制 |
|---|---|---|
| Agent Core / reusable identity | Pi adapter、capability profile、Services Bridge 与 identity loop 存在；源码中 `PROMPT_VERSION=5`、`SYSTEM_PROMPT_VERSION=3` | 具体运行的 Prompt/profile hash 必须读该次 metadata；不能以源码版本代替运行证据 |
| Task / Execution | 共享 Mission Task 可多 Execution；普通 Task 有独立责任；`task_register(take: true)` 注册并在同 Core 切换 | 不等于所有自主分工都产生有价值产出 |
| Context / Judge | Material 生产和消费、Candidate 检查及失败诊断可观测 | 读取不等于采用，检查次数不等于数学进展 |
| Workspace / Runtime | 私有工作面、Progress/本地 Git、fencing/释放和 compaction 规则有实现路径 | 部分跨执行来源、通知处理与真实轮换场景仍需逐项证据 |
| Observability | 事件和状态投影可辅助定位执行行为 | 不是领域权威，也不是因果判断引擎 |
| 实验体系 | PR #116 的阶段/编号/报告约定属于开发协作规范 | 新的预注册流程尚不能借 R16 事后示例声称验收 |

## R16 固定运行快照（不可上移为普遍结论）

- 运行代码：`93176b746492ecbe4c64ec18643a8356b7f5255e`，与 `02adbb43` 的文件树相同。
- 2026-11-06 完成的一小时四 Core 实验：4 Tasks、15 durable Executions、106 Materials、44 次消费、6 次 Judge 检查；全部为 source failure，`solved=false`。
- 运行 `protocol_valid=true`；缺少匹配的 root-only 对照、完整的每条成果下游作用证据与所有接续来源链。
- 详见 [R16 回溯示例](experiments/EXP-20261111-01-r16-example.md)。此报告是事后整理，未按新的预注册流程启动。

## 维护约束

每项新的实现状态必须绑定 clean commit、具体回归/真实实验和未覆盖项。先区分 `source-verified`、确定性测试、受控真实 probe、自然真实运行及未验证；不要从旧实验或代码存在推断系统效果。最新工作范围以获批的 [阶段](phases/INDEX.md) 为准。
