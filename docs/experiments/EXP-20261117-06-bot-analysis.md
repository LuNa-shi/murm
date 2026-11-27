# EXP-20261117-06：独立Task／Bot推进与价值分析

## Setup

本报告重建自然运行的proposal→take→执行→局部交付→组合main→原始Mission接受，分别评价Task责任、Bot身份、Core资源和数学价值。运行期间仅只读权威记录，未向Bot提供建议、修改研究数据、触发模型或提供历史证明。完整配置及正式验收结论由[同EXP主报告](EXP-20261117-06-nested-resource-acceptance.md)负责；本附件不独立授权合并。

固定clean实现 `d5e07ac5d027ebd0ac7445fc95c3d38dd226e2b3`，Putnam `putnam_2025_b1`，原输入SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`，4研究Cores、最多1小时、`gpt_proxy/gpt-6.1-sol`。Mission `mission:putnam_2025_b1:c45cede6-305e-4783-8cc3-9f83ec699294`。所有时间为2026-11-17 UTC。

只读截面分别覆盖初始、早期、约10分钟、整合及终态；终态cutoff `2026-11-17T14:41:27.478466+00:00`，各SQLite顺序backup，非跨库原子。逐Bot操作按权威Execution owner归属；UNBOUND操作按同Core不重叠started–closed窗口连接，保留实际Bridge operation IDs及行定位，不按“最新Bot”猜测。源码复用另以不可变Git树和内容hash核对，不复制proof正文。

## Results

### 验收层次与时间边界

原目标可信接受，protocol有效；root独立物理清理确认11沙箱404、64 checker unit全部settled/inactive且无cgroup，Context/Judge进程及组不存在、pending/live为0。完整analyzer重建6Execution，warnings0。以上与本报告的Task终态相互独立，不能用CLOSED标签代替物理删除。

自然资源诊断出现3次：一次嵌套maxRecDepth、两次同一目标源码的heartbeat耗尽，均为ERROR／lean_resource_limit／unassessed／retryable=false，位置可见；后续源码或依赖更新后PASS。本轮自然触发了EXP05漏分的嵌套形式，支持该具体repair路径通过；不代表所有资源、panic、基础设施边界均在自然运行中覆盖。未触发的种类仍只有控制验证证据。整体Issue修复验收和PR合并仍需结合其他修复项／评审，不能由数学PASS独自推出。

| 边界 | UTC | 解释 |
|---|---|---|
| metadata started_at | 14:25:25.598 | 含初始化的实验入口 |
| Mission created_at | 14:27:53.451 | 权威Mission创建 |
| project run.started_at | 14:27:56.675 | report.elapsed_ms起点 |
| 首Bot ready／首Execution开始 | 14:28:00.678／14:29:16.425 | 身份就绪／局部责任开始 |
| 完整目标merge main0.24 | 14:38:36.889 | 组合开发检查完成，尚非Mission接受 |
| submission created_at | 14:39:15.927 | 固定main进入最终验收 |
| 原目标accepted | 14:41:11.507 | 唯一完整目标接受 |
| project run.ended_at | 14:41:12.465 | report计时结束，cleanup单列936ms |

metadata→接受945.909秒（15m45.909s），project run→接受794.832秒（13m14.832s）；report.elapsed_ms=795790不是metadata总时长。metadata→project起点151.077秒。接受到run结束0.958秒。不同实现、资源、随机轨迹和计时起点的历史样本仅可作观察性比较，不能宣称因果speedup。

唯一submission `submit-complete-proof-1`，由B5在ACTIVE E5期间发起，最终check `treecheck:0e548d27-4f6f-4947-9344-3b2fc4a15af7` PASS；main0.24 commit `95ea2be3d2b532d7f6aa7ac70be5d02234e2294f`，tree `0cf72277d0f8d0d11d00bcf721c5c3d1c27674fc`。最终submission显式选择M5；这不代表没有采用更早助手，实际采用由固定树继承验证。最终普通局部PASS、组合merge与Mission接受是三个不同范围。

6Task均DONE、6Execution均SUCCEEDED、11Bot均CLOSED；18普通检查9PASS／6FAIL／3ERROR，数学outcome均unassessed。6份Material、6条消费记录。模型198请求均有usage，输入6,335,334 tokens、输出39,058 tokens，unknown/pending均0；货币cost和币种unknown，不记0。

### 稳定身份与责任

| Bot | 完整Bot ID | Core | 责任 | 方向 |
|---|---|---|---|---|
| B1 | `bot:928b72fb-7678-47b0-ab05-ed430df7dba5` | core-1 | T1 / E1 | 圆色排除与圆心颜色接口 |
| B2 | `bot:d40f0be2-cc97-455b-8646-008ccbac76b3` | core-2 | T2 / E2 | 数学路线及Lean接口说明 |
| B3 | `bot:9621a8b8-3a5c-48f4-a754-fa5f819bc78a` | core-3 | T3 / E3 | 18对12有限计数 |
| B4 | `bot:76b36059-5077-499e-93ae-8da6d456f4e8` | core-4 | T4 / E4 | 显式双圆心18点网格 |
| B5 | `bot:5c176c70-ed16-4a21-a5d4-9cb05207652f` | core-2 | T5 / E5 | 抽象容量桥与原目标整合 |
| B6 | `bot:85862812-69d3-4a2e-9683-7abf9650f3f5` | core-3 | T6 / E6 | 独立helper及最终目标axiom审计 |
| B7 | `bot:a0b54280-9893-4556-9713-26fdb400bb94` | core-1 | 无Task／Execution | UNBOUND公共复核／冲突提交 |
| B8 | `bot:52370bf4-057f-4387-a300-46b8e3b356a8` | core-4 | 无Task／Execution | UNBOUND公共复核／等待 |
| B9 | `bot:9d858998-baa3-4334-8720-ac4eccaf20d5` | core-3 | 无Task／Execution | UNBOUND后续复核／等待 |
| B10 | `bot:1d0e08f4-cfb4-4503-86ab-bf9d14595a95` | core-2 | 无Task／Execution | UNBOUND后续复核／等待 |
| B11 | `bot:528b87ab-0ece-4ac9-98bf-0cafc777662a` | core-1 | 无Task／Execution | UNBOUND后续复核／等待 |

| Task／Execution | 完整稳定ID | priority | 终态 |
|---|---|---|---|
| T1 / E1 | `a1a9bc80-787e-4bd3-a06e-ea9d7b2ba69b` / `a837c1e7-f6c2-49bb-9600-7186c5dcc9b7` | high | DONE／SUCCEEDED |
| T2 / E2 | `6138aa7f-8cb4-4ede-8615-6c480536daed` / `959f58d5-8af8-4b4d-b537-77793b7b8661` | high | DONE／SUCCEEDED |
| T3 / E3 | `8886696f-c841-4eb6-8002-95926a5712da` / `71afe1b9-d35b-40a8-a9ea-8d727fc410df` | medium | DONE／SUCCEEDED |
| T4 / E4 | `911246a7-b52a-4e43-b557-63a69c7563bc` / `3c580031-de81-4a88-9a42-4e18005d1962` | high | DONE／SUCCEEDED |
| T5 / E5 | `33705e65-8aa0-4fae-9de0-cd3887b7bd47` / `0bb1b597-a70b-4187-95c9-8224fe00a81f` | high | DONE／SUCCEEDED |
| T6 / E6 | `3a7fe88c-469c-489d-b184-64b0062f7a86` / `6b63ae2a-6e98-4291-ab37-96a56b2a5ae9` | medium | DONE／SUCCEEDED |

### 全部11Bot：Target／Action／Immediate result／Next effect

| Bot | Target与实际Action | Immediate result | Next effect／价值边界 |
|---|---|---|---|
| B1 | 首先读取公开任务与原目标，自提自取圆色排除。查固定Mathlib API；两次API探针FAIL，基础引理先PASS，扩展反色容量接口再修布尔分支。 | source0.10检查 `cfab3b47-2b16-4ec4-91d8-e4a736639327` PASS；14:34:06 main0.12；M3交付；14:34:39结束。 | 最终目标实际调用color_center_of_three，从原始circumcenter假设推出所需三点排除。没有停留在正半径或新增非共线假设包装。其他附带接口不是全部都被最终调用，不按声明数量放大价值。 |
| B2 | 自提自取手工有限circle-incidence证明与Lean接口；写路线说明、公开Material，未编译证明模块。 | source0.5保存说明，M1于14:31:36发布；14:32:00.906局部finish接受；无普通Judge check。 | B5在提出整合Task前实际取M1和路线说明，并据此实现18点／12容量桥。DONE表示被承诺的数学路线责任完成，不能写成原目标已Lean完成。 |
| B3 | 自提自取独立18对12计数，和圆色／几何接口分离。 | source0.6检查 `08f8931b-fc9a-41ef-b8c8-8855eb9f3324` PASS；M2；14:32:50 main0.8；局部DONE。 | IncidenceCounting被B5的IncidenceBridge实际调用，进入最终目标依赖链；不是只有Material阅读记录。 |
| B4 | 自提自取任意不同平面中心的3×3×2交点网格。首失败涉及不存在API和noncomputable，第二失败涉及frame注入类型／剩余目标，修源码。 | source0.13检查 `d007efa5-6d88-4c65-9db6-7d8a954b2124` PASS；M4；14:35:00 main0.15。 | 最终目标调用point_injective及两侧距离公式，解除抽象桥的真实几何存在性与注入前提；不需颜色作为几何构造输入。 |
| B5 | 接替Core2的新身份，读前作路线/计数和在运行分工后自提自取整合。先写条件容量桥，修嵌套递归及pair投影类型错误；再接CircleColor/CircleGrid到原目标，修目标heartbeat。 | bridge0.18 `4ff5cb3c-8db5-4d6b-b547-965c2386a71f` PASS；目标0.21 `95d1f301-91fe-450b-bc0a-a73163c5643a` PASS；14:38:36组合main0.24；M5；唯一final submission。 | 是实际原目标集成者和最终提交者。其条件桥在最终目标里获得所有实例，最终原型／axiom／kernel接受；不是仅新增条件包装。14:40:20局部DONE先于Mission接受，不能将该DONE当最终收据。 |
| B6 | 接替Core3的新身份，自提自取独立信任／接口audit。先检查helper，随后导入整合目标，guard transitive axioms并重检查原目标类型。 | source0.17/0.19 PASS；0.22因导入旧目标heartbeat ERROR；应用B5已修0.21后audit0.23 `83c62c99-ad33-4829-b90e-0955b541d40b` PASS。M6，报告save0.25，未merge。 | 覆盖原目标及助手的独立检查说明，比只读标题更强；但未修改目标、不是accepted源码依赖，也未见触发B5修复（B5先已修）或改变已在执行的final。不能替代Mission验证。 |
| B7 | 接替Core1，UNBOUND持续读任务、Materials、源码和main历史；没有新Task、take或源码编辑。 | final-main024-a0b54280于14:39:24遭CONFLICT，已有B5 submission；后查询等待。14:40:39.774因selection-budget CLOSED。 | 可见公共复核与冲突保护，没有新增证明／交付或改变决策证据。selection-budget在自然运行出现；没有材料支持这是unrecoverable failure或截止reason错分。 |
| B8 | 接替Core4，UNBOUND读任务、4份Material及6次源码返回，跟踪整合和pending final。 | 无新Task／Execution、check、publish、submit或修改；14:41:12.343清理关闭。 | 有实际公共阅读，不是完全无工具活动；未见新增数学产物或决策影响。started→closed约359秒主要处于后段复核／等待窗口，不能全部算进展。 |
| B9 | 接替审计Bot的Core3新身份，读M5/M6、main0.24及pending结果。 | 无新Task／take／修改／发布／提交；接受后清理关闭。 | 对已在执行的最终验收作只读观察，未见新检查输入或下游动作。 |
| B10 | 接替整合Bot的Core2新身份，读M5/M6、main0.24和pending结果。 | 无新Task／Execution／修改／提交；接受后清理关闭。 | 不能因solved_by_core2把本身份说成证明作者；实际作者／提交者是前一身份B5。 |
| B11 | 接替selection-budget结束身份的Core1新身份，短窗口读M5/M6与main0.24、pending结果。 | 无新Task／Execution／修改／提交；ready后25.774秒即清理关闭。 | 是最终验收窗口中的替换身份，未观察到额外科学产物。不能把多一个Bot计为多一份有效并行贡献。 |

### Material与实际数学采用

| 材料 | 完整ID | 生产者 | 内容范围 |
|---|---|---|---|
| M1 | `3ab8d358-8db5-4bb1-bd73-9f9836f4c437` | B2 | Explicit finite circle-grid proof and Lean interface |
| M2 | `1519b059-3116-4ee3-925a-e2c97b5b1770` | B3 | Checked 18-versus-12 bipartite intersection counting lemma |
| M3 | `0d03b236-09c2-4ae1-b700-8ad48a7e181d` | B1 | Checked circle-color exclusion interface |
| M4 | `10ce9409-a874-4450-9750-126c9ab41dfd` | B4 | Checked explicit 18-point two-center circle grid |
| M5 | `0e36260f-a3b9-488b-a5d6-a832963bc98f` | B5 | Checked complete proof and incidence bridge, merged to main |
| M6 | `79e32c39-2da2-4195-9e9e-c5bc4e4387b0` | B6 | Independent guarded axiom audit passes for assembled theorem |

B5通过实际context_get_material读取M1/M2，后实现并消费（consume-bridge-1，14:34:30.828）；又读取M3/M4并在原目标里实例化（consume-geometry-bridge-1，14:36:54.939）。B6消费M1/M2（consume-trust-audit，14:37:11.473）是审计采用，不是另外两条目标证明。消费记录的自述与固定源码调用交叉验证；其他Bot的read只有送达／复核证据，不能单靠次数认定改变决策。B6的Material发布晚于final submission，不能倒推其触发了final。

最终目标实际导入CircleColor、CircleGrid、IncidenceBridge，调用color_center_of_three、monochromatic_of_triples_and_grid、point_injective及两侧距离引理；IncidenceBridge导入并调用IncidenceCounting的有限计数。四个helper均在目标依赖链中；没有像EXP05 CircleGridBridge那样已merge但完全不被目标采用的另一路实现。B2是非源码路线交付，B6是独立audit，二者不混入证明文件数量。

内容hash确认CircleColor@0.10、IncidenceCounting@0.6、CircleGrid@0.13、IncidenceBridge@0.18及target@0.21在final main0.24均原样继承。main0.8／0.12／0.15分别并入计数／圆色／几何，最后main0.24一次组合bridge与目标；组合检查与独立最终接受都保留。TrustAudit和说明source0.25未merge，final main仅5Lean文件，不宣称audit已进入交付树。

### 自然资源错误与恢复链

| 检查ID／输入 | 实际反馈 | Bot后继动作／结果 |
|---|---|---|
| `8ab5f818-8023-458b-b0b2-b1b079d25495`，B5 bridge0.14，commit `b86173bc98bbafd0b59cb4a3ca3df9a2f8de7ea8` | 14:34:48.209；嵌套simp maxRecDepth，位置39:2；ERROR／lean_resource_limit／unassessed／retryable=false，completed且timed_out=false。 | 把广泛simplification改为定向rewrite后exact；0.16另有真实pair投影type mismatch FAIL，再修0.18于14:36:00.797 PASS。未提高资源配置、未重复同树。 |
| `30753927-ef36-4505-8e7d-5482e9f22092`，B5 target0.20，commit `aa3cdf2277386d3d2a3aed4e1a15fd7b1e8b6e6e` | 14:37:18.605；whnf heartbeat耗尽，位置44:55；同上正确资源分类。 | 给注入中间等式显式类型／中心参数，target0.21新hash，于14:38:05.824 PASS。不是将未完成检查改判数学FAIL或PASS。 |
| `0ce5f9f7-a274-4c7c-a792-1c4738d434d7`，B6 audit0.22，commit `f6549aa7bcc5bb61f8fd4aef9bffb4221b92c536` | 14:38:06.903；真正位置在导入target44:55，同一旧target heartbeat；requested scope仍为audit模块，诊断准确指向传递依赖。 | 读取已经通过的target0.21，apply-typed-proof-audit，保存audit0.23，14:38:39.513 PASS。没有重写audit掩盖错误，也没有把导入失败归成audit数学错误。 |

上表时间以持久CheckResult updated_at为准，Bridge complete通常晚几十毫秒。三项ERROR的result_class沿既有顶层分类为infrastructure_failure，细分diagnostic_code为lean_resource_limit；不把该顶层名字解释成OS／远端服务故障。retryable=false传到实际Bridge返回，位置和资源原因可见。原始Lean JSON、OS exitcode等未单列持久字段不补猜。后继PASS都是新源码／依赖输入，不能说原来的ERROR现在变成了PASS。

### 普通错误、并发冲突与停止异常

B1在14:29:40.042读尚不存在的临时Mathlib参考文件收到ENOENT；下一动作14:29:44.928改为获取固定Mathlib commit参考文件并搜索API，随后继续源码实现。该工具事件有稳定toolCallId `call_b85376c9f111491794cee25e85d3932f|fc_0439c46e6bf44367016afc64d3877c87d08115ffa279a28a69`。report.tool_error_count=1不能解释成全过程只有一次不成功工具调用：source-check CLI失败、B7 final CONFLICT有各自结构化证据和计数口径。

B7唯一重复submit被CONFLICT拒绝；没有新增freeze或第二final检查，随后读取既有submission。B1／B4的API、类型和非计算性错误各有新源码及后继PASS，不据FAIL数量一概认定盲重试。

最终report中4个identity_loop均保留PROCESS_EXITED／Pi RPC session closed before agent_settled，take_failure_count各1、stopped=true、state=STOPPING。最后state_history／last_event_at为14:41:11.513/.516/.519/.521，分别晚于accepted6–14毫秒，与接受后停止窗口相邻。最终独立评审在report.run.identity_loop_events的105–108项找到identity_loop_take_failed回调：core1于14:41:11.581、core3于.590、core2于.597、core4于.604，分别晚于accepted74/83/90/97ms。每Core仅此一次failed事件、无其他failed/invalid，与最终count=1形成唯一候选对应。该事件清洗后没有error正文；原生会话错误首次产生时间仍未单独记录，不能把STOPPING或失败回调时刻当成原生错误首次时间。现有关闭流程停止loop/controller并结束等待agent_settled的会话，与这些接受后回调相容；当前没有阻止接受、Execution失败或物理cleanup失败证据。保留异常字段，不将其描述为新的不可恢复服务故障，也不声称原始session错误已被完整捕获。

### Task合同、可见关系与自然覆盖

6份Task均有具体gap/output/acceptance/priority；T1/T2/T4/T5为high，T3/T6为medium。6次take均由提案者自己领取，6份contract仅初始spec1，无revision、ACTIVE新提案、跨Bot take、多提案或取消的自然样本。depends_on及input_material_refs均空、task_relations空；分工关系由gap、公开Task、Material和代码建立，不能称显式关键路径调度或竞争优先级排序已获验证。未自然触发的功能仍是controlled-only。

每份completion_contract只有空required_capabilities，没有workspace_delivery机器门禁。Task DONE是局部责任被接受，本轮用独立源码检查、Material与最终目标调用另证局部交付。T2的手工说明DONE与T6的审计DONE尤其不能算两次根目标完成。

### 投入、等待与价值解释

下表“ready后未承责”对有Execution者是ready→E开始，对其余是ready→closed；E占用用started→最终updated_at，含检查、模型、编辑、工具、finish结算，不是纯数学工作时间。

| Bot | ready后未承责或无责窗口（秒） | E占用（秒） | 普通check数 |
|---|---:|---:|---:|
| B1 | 75.747 | 322.643 | 5 |
| B2 | 50.181 | 130.662 | 0 |
| B3 | 55.595 | 136.241 | 1 |
| B4 | 48.822 | 201.286 | 3 |
| B5 | 51.995 | 442.982 | 5 |
| B6 | 106.153 | 289.807 | 4 |
| B7 | 354.622 | 0.000 | 0 |
| B8 | 354.495 | 0.000 | 0 |
| B9 | 74.048 | 0.000 | 0 |
| B10 | 41.944 | 0.000 | 0 |
| B11 | 25.774 | 0.000 | 0 |

全部18普通check均为lean-module；9/18请求有cache命中，合计26模块hit／18miss。相同目标与依赖内容的校验复用不代表额外数学结果；失败依赖及后继新hash也不等同同树重试。没有同输入禁cache对照，本轮自然节省秒数unknown，不能从工程warm探针倒推总提速。

B7/B8较长无Execution窗口有实际阅读，后继B9–B11主要落在final等待窗口；没有证据把这些窗口全算作有效推进，也不能全部填为idle。B2的手工接口明确被B5采用，不能因为未写Lean就判零价值；B6的独立检查覆盖最终目标，但没有改变已运行final的证据，不能夸大为必要前提削减。是否减少末段替换身份或优化价值排序，是另需比较的问题，本次没有改算法。

## Analysis

本轮可见真实多任务闭合：圆色闭包、有限计数、独立几何构造和整合桥都进入原目标，所有附加前提在最终目标中提供，独立type／axiom／kernel接受排除了仅条件包装结束。数学路线和审计也是被承诺的局部责任，但其价值类型不同，不能靠DONE／PASS数混为同一收益。

对修复的最强自然证据是同类嵌套资源错误在本轮正确分类、位置保真，随后Bot改源码而非原树重试；另有目标heartbeat和导入依赖heartbeat的相同边界。它只支持观测范围，不能把未触发panic/OOM/wallclock等说成自然PASS。EXP05历史repair FAIL仍不变。

计时与资源有明确混杂，短成熟Putnam单样本不证明Q20、8h效率、最优分工或一般成功率。接口阅读、缓存命中、活跃Core和最终提交者都须连接具体输入／动作／下游，不能独自代表科学进展。

## Next steps

由主报告汇总数学接受、protocol、独立physical cleanup、repair-specific控制／自然证据与独立代码评审，再判断Issue验收和合并。保留4loop PROCESS_EXITED最终字段、接受后失败回调的已知时间和原生session错误首次时刻的采集局限，不根据成功结论反写无异常。本报告未修runtime、重跑模型或修改原始实验结果。

公开仅保留稳定IDs与聚合行为；原始证据、证明、对话、stdout和私有数据库仅在ignored本地目录。自然未覆盖行为明确保持controlled-only。任何后续实验或算法变更依人类批准范围执行。
