# EXP-20261117-05：逐Bot协作与价值分析

## Setup

这是[Issue137 Putnam正式验收报告](EXP-20261117-05-issue137-putnam-acceptance.md)的公开分析附件，整合Task推进、Materials／Workspace接续和四Core价值投入三份独立只读审计。分析在运行期间没有指导Bot、修改域状态或提供历史证明；公开稿只保留行为摘要、稳定ID、固定revision及聚合数值，不复制证明、原始对话或私密路径。

实际clean实现 `8e6d15213aaccccd7f6ed5aeca10d5b639ab4c6c`，Mission `mission:putnam_2025_b1:c7e33366-6b42-4ec7-9083-de24570ee962`，4研究Cores。metadata到接受834.255秒，project run到接受686.662秒，最终check113.260秒；计时、资源、模型及清理的完整边界见主报告。最终main0.29 commit `d76d90bd7ea3c919fb052990f3f3952a9517732f`，tree `2f7bc16bdcf351a198c3792ba54f6cde7af049b4`。

## Results

三个互补助手的结果进入最终原目标，主Bot完成归约和整合；另一已合并桥是未用于目标的备选，独立helper审计是检查说明。10个Bot不是10个并行Core，同Core替换身份有各自Session和生命周期。6DONE是局部责任完成，不是6次Mission接受；最终只有一次原目标接受。数学、protocol和物理cleanup均PASS，嵌套资源诊断repair FAIL，整体修复验收仍incomplete。

最终唯一受理submission为 `final-main-review-8727b82f`，独立check `treecheck:3ef31183-8b1d-4122-8529-f7e1a488ba04` 于13:37:32.359 UTC接受。protocol_valid=true，后续物理核验10沙箱404、68 checker units settled且无cgroup残留、Service进程及组不存在；这些结论不依赖Bot CLOSED标签。

### 稳定身份字典

| 标签 | Bot（完整稳定ID） | Core | Task／Execution |
|---|---|---|---|
| B1 | `bot:19d8cdd6-774f-4395-9cfb-dd97186bdbb2` | 1 | T1／E1 |
| B2 | `bot:07e27eaf-268a-4d14-8fd0-c925e94daef3` | 2 | T2／E2 |
| B3 | `bot:5b83b5d0-45e9-476d-8e1d-ff4d7f5ac8d3` | 3 | T3／E3 |
| B4 | `bot:685c17dd-dd72-4fc5-b7e9-b9dcde6af007` | 4 | T4／E4 |
| B5 | `bot:dd3c0bf7-e07a-4f6a-83eb-b45db7cf39de` | 2 | T5／E5 |
| B6 | `bot:9f496bc3-7f74-45d1-acd6-7d657b17b15a` | 4 | T6／E6 |
| B7 | `bot:0c7e758c-8fbd-4c92-9cc4-0e5eb1c56af1` | 3 | T7撤销，无Execution |
| B8 | `bot:8727b82f-739d-4993-92aa-e24e78a35999` | 2 | 无Task／Execution；最终提交者 |
| B9 | `bot:d6e81b0c-6888-426c-bd70-a1ab86a8ee52` | 4 | 无Task／Execution |
| B10 | `bot:d88150c7-8a8c-455a-bb96-fe04d5bacda0` | 1 | 无Task／Execution |

| Task／Execution | 完整ID | 目标与结局 |
|---|---|---|
| T1／E1 | `9406471d-bc4b-4f76-aaee-f3036cadf0c3`／`02a07793-5eef-483b-986e-0ede55b54b6b` | 整体圆心染色论证与整合，DONE |
| T2／E2 | `021502c0-b5f9-47c8-aa4d-0531eb6e9542`／`7a2cb4ad-a19f-45f7-90a5-9a4a79fa9dea` | 有限5×5双色计数矛盾，DONE |
| T3／E3 | `ba6e270f-95f9-43cc-a73e-4f6da49a92f4`／`d3f355d2-2e9c-471a-ba8b-3de5264e3365` | 两圆心可注入交点网格，DONE |
| T4／E4 | `0a54f421-aabe-47e6-a6b9-767647f4e98c`／`dc3a8110-2fb9-4559-bb0f-0bae0ab7d943` | 同圆三点到Simplex/circumcenter及颜色桥，DONE |
| T5／E5 | `d3cc832d-0f2d-44e1-8e33-f73d06bca557`／`e38e5c8d-e74a-4544-81a9-58c2bf464ccc` | 圆三点排除→有限基数→网格单色，DONE，替代路线 |
| T6／E6 | `8b0933c6-475c-488d-933b-771ec29106ed`／`85baba2a-fe38-4785-9077-d99be60852fa` | 助手axiom与接口独立审计，DONE，未并main |
| T7 | `140cf005-cc24-41ff-9be5-767df2ade8e7` | 重复审计提案，未take即CANCELLED |

### 每 Bot：Target／Action／Immediate result／Next effect

| Bot | 目标与实际动作 | 立即结果 | 后续效果／价值边界 |
|---|---|---|---|
| B1 | 13:26:32提出整体目标、13:26:38执行。用3个失败API probe查签名；公开路线。发现B4做CircleTriple后发布去重说明，转向cardinality和整合。自己实现ColorReduction并读取三位助手Material及main文件。 | reduction0.21检查`a091609f-7428-4035-b3fc-a5cbadc2e8ef` PASS；目标0.26 full-project检查`710b8926-da57-4511-ab67-421a752c04e5` PASS；依次merge main0.25和0.29。 | 是最终原目标证明的实际集成者。最终引用CircleTriple、TwoCenterGrid、ColorReduction，后者引用ColorGrid。不是仅汇总标题。自己13:35:50提交遇已在验收的CONFLICT后查询状态，再正常完成Task；没有抢占或改变固定提交。E1执行589.056秒至finish接受。 |
| B2 | 13:27:58提出计数助手并自取。第一次simp嵌套递归耗尽后仅改两处为lemma-only简化，不提高资源。 | 0.4检查`af6888f1-57e9-43cb-8ebe-ea3e3e0ed7c6` PASS；M2发布、链接整体Task；main0.8于13:30:25采用；13:30:39局部DONE。 | ColorGrid.five_by_five_impossible被ColorReduction真实调用，最终证明的必要计数桥。E2执行157.085秒，第一条失败后38.598秒拿到修正PASS。资源误分类单独FAIL。 |
| B3 | 13:29:02提出几何网格并自取。初始检查指出实数运算/sqrt定义需noncomputable，随后修正并完成距离恒等式和行列injectivity。 | 0.12先局部PASS，完整交付0.16检查`7af4a99b-2a37-4f71-80f6-34ffe3056423` PASS；M4；13:32:41 main0.19采用。 | TwoCenterGrid.exists_grid由最终目标真实调用，把任意两个不同点的抽象网格前提落到原始平面上，没有留下新几何假设。E3执行224.581秒。 |
| B4 | 13:29:32提出圆三点引理并自取。未知API/有意类型探针后改用Cospherical.affineIndependent和Simplex.eq_circumcenter_of_dist_eq。 | 0.15检查`906257fb-fd95-41cd-83a1-6c0b3ff7e414` PASS；13:32:17 main0.17采用；M5。 | 最终目标使用color_center_of_circle_triple，把原假设转成圆上反色三点排除；无需额外正半径假设。E4执行179.790秒。 |
| B5 | 接替Core2但为新身份／新Session；读取M1/M2并提出独立基数桥T5。两次rewrite/type错误后修正。 | 0.23检查`2f8fe517-3861-4a61-81ca-f350e237e2ab` PASS，含ColorGrid依赖命中；M6，main0.27于13:34:30采用。 | 可检查的另一条一般桥，局部责任成功。最终目标**没有导入/调用CircleGridBridge**，而使用B1已经并行实现的ColorReduction。不能把T5的207.646秒全部计为关键路径收益；也不能据此称证明无效。M8整合说明明确承认此文件未使用。 |
| B6 | 接替Core4，新身份；自提自取T6，以受guard的axiom输出及实例检验三条原助手接口。 | audit0.24 `c8f60aa4-e3e4-4787-942a-feb8221e919f` PASS；修订后0.28 `f834dd80-580f-4177-b902-61756a87e46b` PASS；M7及未合并save0.30；13:35:51 DONE。 | 没改目标、ColorReduction或桥；main0.29不含HelperAudit。M7后来被B9/B10阅读，未见触发修复或改变已在执行的最终验证。可称独立检查说明，不能称对最终目标的额外形式前提削减或替代Mission trust。E6执行140.001秒。 |
| B7 | 接替Core3，先读取几何Material，13:33:41新建T7；最后刷新发现T6已运行。 | 13:33:54 UNBOUND取消自己的重复提案（`cancel-duplicate-audit-0c7e`），无take/Execution。随后读main及助手，一次读尚未并入的CircleGridBridge报文件不可用；更新至main0.29恢复。 | 可见重复控制与错误后刷新。13:35:40尝试提交遇已有freeze CONFLICT，随后只查询等待；没有证明交付或修复证据。started→closed278.783秒不等于生产性研究时间。 |
| B8 | 接替Core2。先读main0.27；读M6后再次读已更新main0.29，选择提交当前main。 | `final-main-review-8727b82f`13:35:39受理，空Material选择、无Task/Execution；13:37:32原目标最终PASS。 | 实际完成最后固定提交动作。没有新增证明源码，接受归因于固定main及独立checker，不能把“solved_by_core2”误读为Core2独立写完证明。占用156.953秒，其中大部分为最终检查等待。 |
| B9 | 接替Core4。检查pending submission，读M8、M7及main0.29/ColorReduction/CircleTriple。 | 没提Task、没take、没发布、没提交或修改。 | 可证实只读核对和等待，未见改变证明、检查输入或决策。started→closed100.401秒；不称额外数学进展。 |
| B10 | 接替Core1。读main0.29及M8/M7，查询pending submission。 | 没提Task、没take、没发布、没提交或修改。 | 可证实只读核对和等待，未见新增产物或决策影响。started→closed63.798秒；不以活跃Core时间代表价值。 |

### Material 与 main 的具体采用链

| Material | 完整ID | 可见后续 |
|---|---|---|
| M1 路线 | `a2cc421b-0109-4edb-a1bd-1137c3fe2f6b` | B1发布手工路线并明确尚未Lean验证；B5在新Task前实际取正文。路线本身不当证明。 |
| M2 计数 | `6145e8f6-3789-4dae-8f28-842f601422b3` | B1正文读取13:31:13，integration消费13:33:34；B5也消费。ColorGrid由两个桥导入，最终路径只走ColorReduction。 |
| M3 去重/API | `727303d7-6e55-4d12-8670-a08506b35b1e` | B1承认新CircleTriple Task并改做integration/cardinality；提供API探针观察，不宣称probe证明成功。 |
| M4 网格 | `e3593e80-b32b-434b-a14c-03374abd167f` | B1完整正文返回13:34:23.337，integration消费13:34:55，目标0.26实际调用exists_grid。 |
| M5 圆三点 | `21bdc3c1-37dc-47ef-9221-5baa09a5251e` | B1完整正文返回13:34:23.337，integration消费13:34:55；目标真实调用color_center_of_circle_triple。B6用于审计。 |
| M6 替代桥 | `a6e14232-a0c3-4584-b3e6-6840f09f19b2` | B7/B8取正文，源文件并main0.27。被读和被编译不等于被最终目标调用。 |
| M7 审计 | `b23811fd-b682-418c-a2e0-b370265eb74b` | B9/B10取正文；未见由此修复或重新选择最终提交。 |
| M8 完整解 | `b8e9f3f3-6aba-4cba-8d72-a40014c52ca6` | B1发布既有完成树及研发/merge检查证据；B9/B10实际读取。发布时清楚区分尚待Mission接受。 |

`material_consumptions`最终6条：B1消费M2/M4/M5，B5消费M2，B6消费M4/M5。消费记录是主张，价值判断还用正文读取、后续修订、Git导入和实际常量调用交叉验证。首次三个被最终使用的助手从各自proposal到take仅3.897/6.371/5.943秒；未见长期无人领取的关键任务。几何与圆三点在13:32:41前均已进main，完整目标13:35:16进main，相隔155.196秒；这段是cardinality／目标整合及检查，而非助手一直悬空。

## Analysis

### Task 关系、gap 与优先级：有可见分工，没有结构图或排序效果的证据

7个Task均有具体gap/output/acceptance/priority；T1 high，其余medium。6个执行Task的created_by与Execution owner完全相同。7条初始contract revision均spec1，没有revision更新、无ACTIVE新提案、无一Bot多提案；T7取消是自然触发。`task_relations`为空，creation provenance记录均为ROOT（历史存储枚举，表示没有creator Task，不是Mission/root Task层级），source_material_refs为空。因此“整体—计数—几何—圆三点—桥”的关系主要在gap、Material和实际代码里表达，不能说系统执行了显式depends_on关键路径调度或跨Bot任务交接。

6份completion_contract仅含required_capabilities空列表，没有声明workspace_delivery机器验收门。DONE本身表示局部责任被接受，不能独立证明交付数学内容。这里其局部成功另有具体源码检查、Material、merge与最终调用证据，而不是凭DONE数认定。Mission PASS仍是另一个固定输入/独立信任边界。

### 实际有效的数学推进与条件包装

最终目标的导入路径：`CircleTriple + TwoCenterGrid + ColorReduction → ColorGrid`。CircleTriple用原始闭包假设给出圆心颜色；TwoCenterGrid对任意不同平面点构造所需等距可注入网格；ColorReduction把圆三点条件变成<=2的基数约束，再调用计数矛盾。这些前提在最终目标中都有实际实例，且最终固定目标type/axiom/kernel验证PASS。因此本次没有停留在“再假定一个所需几何性质就完成”的条件包装。

另一方面，CircleGridBridge与ColorReduction解决相近的抽象基数/网格桥。两位Bot在相近时间并行实现，证明代码及Material互相独立，最终目标明确选用ColorReduction。T5提案13:31:19比M3公开调整计划13:31:25还早约6秒，不能据此说新Bot忽视了已经发布的变更。这里存在真实替代路线投入；后续研究可问如何在避免过早串行阻塞的同时，把正在变化的整合计划及时公开。当前证据不能量化这条替代路线让完成更快或更慢。

### 检查反馈后的实际动作

20个普通CheckResult中19次lean-module、1次lean-project；9PASS/11FAIL，均数学outcome unassessed。缓存统计合计11 hits/19 misses是模块构建单位，不是11次新数学成果。API probe的有意FAIL用于查询类型，不能一概当“写证明失败”；它们没有被合入最终目标路径。几个清晰反馈链：B2限定simp；B3加noncomputable并修完整几何定义；B4从不存在API转向真实专化接口；B5从rewrite的dependent motive错误改为明确布尔命题关系。均有后续新revision/hash，未见这些链仅对同一原树反复盲重试。

真实缺陷：CheckResult `d95bedef-1039-4764-8d86-3636225c7ddd`在两处嵌套tactic消息中包含maxRecDepth耗尽，却被标记source_failure。原始结构化记录与有界事件证据在ignored证据集中冻结。位置保留，checker_process_status=completed，retryable=false，数学outcome仍unassessed，未有falsePASS。原始Lean JSON severity/pos和OSexitcode未被保留，不重建成“已观测”字段。该可恢复缺陷按登记的unrecoverable-stop规则不要求中止，但修复项FAIL/incomplete；禁止事后修改本轮历史结果。

误分类对应T2/E2的source0.2、commit `448825ecdbc1774f069a7a44aaf4a684412ffae3`，检查于13:28:46.750完成。Bot把两处宽泛simplification限定为显式引理集，source0.4、commit `7bae53d2697f81c8127ad95ff2c808680ea620db` 于13:29:05.666保存；后继check `af6888f1-57e9-43cb-8ebe-ea3e3e0ed7c6` 于13:29:25.348通过。失败后18.916秒形成新保存，38.598秒形成PASS；没有提高Lean资源选项。普通字段记录为FAIL/source_failure、completed、retryable=false，正确资源分类应为ERROR/unassessed，不能将未完成检查当数学FAIL。

其余明确Bridge错误包括B7读尚未存在于main的文件，以及两个同时提交触发的CONFLICT。B7随后刷新main；两个提交者查询已受理submission，没有再产生独立最终检查。最终机器接受只归于一个受理submission，不能把冲突提交算多次完整验收。

### 资源／价值解释的限度

10Bots/6DONE/20checks不是速度结论。T2/T3/T4和B1集成有直接最终证明调用证据；T5是已验证但未被目标使用的替代桥；T6是独立检查说明；B7–B10无Execution，其中B8有必需的提交动作。最后几个替换Bot在最终提交已排队/运行时继续只读轮询，未见新增科学结果。是否应在此阶段减少替换身份启动，是另需设计与比较的问题，本次不改算法。

本次是成熟短Putnam单样本，允许自然早停；不与不同实现/资源的历史样本做因果速度比较，也不证明Q20或长时程价值排序改善。自然运行没有覆盖的Task多提案/ACTIVE提案、跨Bot take和UNBOUND contract revision依然只能引用单独控制测试，而不能宣传为本次自然观测。


### 正文送达、源码继承与组合检查

独立接续审计覆盖8/8 Material正文及6/6消费记录；read要求实际tool结果完整返回不可变正文，排除列表摘要、通知和生产者publish回显。7/8材料至少送达一个其他Bot，共22个Bot×Material对；M3没有确认foreign完整正文送达。因此不能把“公开了去重计划”写成“其他Bot已读并据此改变计划”。read证明送达，不证明理解；consume也需后续源码/行为佐证。

| 材料 | 其他Bot完整正文数 | 消费记录数 | 下游证据 |
|---|---:|---:|---|
| M1 | 1 | 0 | B5收到手工路线；无单独因果归因 |
| M2 | 7 | 2 | B1和B5实际调用计数接口；仅B1分支进入最终目标 |
| M3 | 0 | 0 | 公开责任调整；后继作用unknown |
| M4 | 3 | 2 | B1目标集成、B6接口／axiom审计 |
| M5 | 3 | 2 | B1目标集成、B6接口／axiom审计 |
| M6 | 4 | 0 | 备选桥已merge，目标未调用 |
| M7 | 2 | 0 | B9/B10收到；未见触发修复或改变提交 |
| M8 | 2 | 0 | 完整解说明；发布晚于最终submission，不能说它触发提交 |

六次消费均有消费前完整正文。四条是定理集成（M2→B1、M2→B5、M4/M5→B1），两条是审计采用（M4/M5→B6）。B6也读取并检查ColorGrid，但没有对M2记consume；记录数不替代实际工作核实。

| 新main | 全组合树merge CheckResult | Lean文件数 | 作用 |
|---|---|---:|---|
| 0.8 | `projectcheck:45d10d8d-7a5d-4707-8151-a54be9c3597c` | 2 | ColorGrid |
| 0.17 | `projectcheck:606d1cf2-84e2-4c77-8664-06e2fff95760` | 3 | CircleTriple |
| 0.19 | `projectcheck:07fe49ec-ecba-4d05-9464-70056d2b3b5c` | 4 | TwoCenterGrid |
| 0.25 | `projectcheck:f5babed1-9fe1-405a-9c86-b98408f94921` | 5 | ColorReduction |
| 0.27 | `projectcheck:1dc055c2-5144-4fdd-a73c-4a83e075fade` | 6 | 备选CircleGridBridge |
| 0.29 | `projectcheck:76845690-cd40-4ca0-abc7-eb05aa05f321` | 6 | 完成原target |

五个helper在final main的内容hash分别与其checked source0.4/0.15/0.16/0.21/0.23相同；target与checked source0.26相同。source0.26的普通full-project PASS覆盖5文件，组合main0.29覆盖6文件，最终独立Mission仍另行验证完整树。HelperAudit source0.28有PASS，交付save0.30未merge；不能声称它成为accepted源码。最终submission的空Materials列表不否定固定树中的真实继承。

### 并行投入与等待成本

责任时间有两个不同终点：上表E持续时间采用finish被接受时刻；下面资源占用采用Execution最终updated_at，包含finish后的生命周期结算。二者相差不到1秒，不混合加总。所有区间都含等待、检查、模型及工具活动，不能命名为有效数学工作秒数。

| Bot | Core | ready后到承责或无责结束（秒） | Execution占用（秒） | 责任内check在途并集（秒） |
|---|---:|---:|---:|---:|
| B1 | 1 | 29.141 | 589.995 | 71.831 |
| B2 | 2 | 53.041 | 157.671 | 23.849 |
| B3 | 3 | 59.284 | 225.321 | 41.801 |
| B4 | 4 | 28.238 | 180.734 | 39.608 |
| B5 | 2 | 42.604 | 208.439 | 46.484 |
| B6 | 4 | 48.052 | 140.739 | 29.488 |
| B7 | 3 | 273.709 | 0 | 0 |
| B8 | 2 | 151.493 | 0 | 0 |
| B9 | 4 | 96.380 | 0 | 0 |
| B10 | 1 | 59.667 | 0 | 0 |

6个Execution合计1502.899 Core-s，check在途并集253.061 Core-s，补集1249.838 Core-s含编辑、阅读、模型、其他工具和未知间隔。10Bot启动到ready合计43.039 Core-s；6个承责Bot ready到E开始260.360 Core-s；4个无Execution Bot ready到closed581.249 Core-s，含取消、复核和最终验证等待。无Execution不等于完全空闲，但没有证据把其全部算为证明推进。

同时4Core承责133.506秒，至少3Core承责310.166秒；0/1/2/3Core承责分别97.731/120.763/159.066/176.660秒。责任占用约为project run容量54.6%，更宽的turn占用约85.0%，两者均不表示研究收益。60秒初始stagger是批准配置，首4个身份不是同时起跑。

局部请求created→updated合计235.351秒，中位13.007秒，范围8.111–20.301秒；唯一普通full-project为17.710秒。这些含服务与排队开销，不全是编译。7/19局部请求有cache命中，11hit/19miss，全部请求至少有一个目标miss，无完全cache请求，也没有同scope/path/目标hash重复检查。命中组中位14.481秒、无命中组8.887秒，输入依赖规模不同，不能由此估计cache因果节省。主报告另列固定Q20三轮冷／热／leaf探针；自然cache节省秒数仍unknown。

## Next steps

本轮数学、protocol、物理清理结果保留PASS；诊断repair保留FAIL，整体修复验收incomplete，不清除合并门禁。后续修复、测试与独立评审另行报告，不回填本轮。自然未触发的多提案／ACTIVE／跨Bot take／UNBOUND revision仅有控制公共入口测试证据。

替代桥、审计和等待身份揭示的是价值分配研究问题，当前没有证明它们违反框架或可无损删除。若进一步改变选工或等待策略，需先批准比较问题和验收。本公开稿不提供新实验或合并授权。

证据为同EXP固定最终report、只读数据库快照、不可变Workspace树、Bridge实际调用和Agent tool结果、三份独立审计、full analyzer及物理清理检查。跨库backup非原子；稳定终态与固定源码交叉核对降低了偏差。analyzer重建6Execution且warnings0，不表示所有反馈分类正确。公开稿未带入raw proof、conversation、stdout、数据库或私密路径。
