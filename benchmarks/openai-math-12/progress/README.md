# OpenAI Math 12：证明进度评分与拆题

这份清单把 [PR #147](https://github.com/LuNa-shi/SwarmEnv/pull/147) 中配置的 **12 道题拆成 227 个固定验收项**。每项写明要证明的结论、允许的前提、上游依赖、验收条件和参考源码。工作范围见 [Issue #150](https://github.com/LuNa-shi/SwarmEnv/issues/150)。

全部题目使用同一个分数：**通过的固定验收项数 ÷ 本题固定验收项总数**。原题完整证明核验通过时记 1。一题有 20 项，通过 12 项就是 0.6；另一实验通过 8 项就是 0.4。这里比较的是同一清单中已完成的证明工作，不把不同项理解成等量的时间或数学难度。

## 12 题总表

当前判断为 **4 题适合，8 题需进一步确认**。这判断的是本版评分表能否稳定衡量参考路线上的进展，不要求数学证明路线唯一。每题的具体条件写在对应文档开头；本次没有删除或替换题目。

| 题目 | 固定项数 | 判断 | 主要依据 |
|---|---:|---|---|
| [SeymourSecondNeighborhood](problems/SeymourSecondNeighborhood.md) | 19 | 需进一步确认 | 匹配、核向量和剪枝必须对应同一套构造。 |
| [OneWayLiveness](problems/OneWayLiveness.md) | 19 | 需进一步确认 | 运行语义、配对图和秩下界之间需要稳定对应。 |
| [PartialPermutation](problems/PartialPermutation.md) | 19 | 适合 | 小类型覆盖、余类能量和统一常数的接口清楚。 |
| [ShortEgyptianFractions](problems/ShortEgyptianFractions.md) | 21 | 适合 | 联合余数供给已细拆；与另一道埃及分数题重叠。 |
| [PowerFreeValues](problems/PowerFreeValues.md) | 19 | 需进一步确认 | 三个代数点计数核心仍较大，需要复核粒度。 |
| [SecondKahnKalai](problems/SecondKahnKalai.md) | 20 | 需进一步确认 | 概率、剪枝容量和路径恢复须指向同一棵树。 |
| [EuclideanRamsey](problems/EuclideanRamsey.md) | 20 | 需进一步确认 | 需要明确通用工具定理对本题实例的验收范围。 |
| [EntropyPhotonNumber](problems/EntropyPhotonNumber.md) | 20 | 需进一步确认 | Gibbs/谱数据这一核心接口的粒度需要复核。 |
| [StronglyRayleighDPP](problems/StronglyRayleighDPP.md) | 16 | 适合 | 协方差符号、导数和全局响应界衔接明确。 |
| [KMedianRefinedRecovery](problems/KMedianRefinedRecovery.md) | 16 | 需进一步确认 | 参考使用通用近似算法；专门恢复路线未必对应。 |
| [MatchingFPRAS](problems/MatchingFPRAS.md) | 20 | 需进一步确认 | 需固定采样、冷却与机器构造，核对定量混合接口。 |
| [EgyptianFractions](problems/EgyptianFractions.md) | 18 | 适合 | 联合供给、坏集递推和展开恢复可以分别验收。 |

四个“适合”题可以优先制作逐项验收记录：PartialPermutation、StronglyRayleighDPP、ShortEgyptianFractions、EgyptianFractions。其中两道埃及分数题研究高度重合的长度问题；若希望题集覆盖不同数学任务，应在正式比较前选一个，或明确保留两个实现版本的目的。两题都已完整拆分，当前配置保留不变。

八个“需进一步确认”题也有完整清单。启用前需要完成各题写明的检查：有些要固定共享构造，有些要明确等价接口，有些还要复核大引理的粒度。对于允许自由替换整套算法的 MatchingFPRAS，当前表不宜直接比较未完成证明；对于专门想测证书几何恢复的实验，KMedianRefinedRecovery 的通用算法参考路线可能偏离测试目标。这两种使用场景已标为暂缓或换题讨论候选，尚未作删题决定。

## 一份证明片段怎样得到分数

验收对象是预先写好的完整数学结论。例如 StronglyRayleighDPP 的 SR07 要求所有外场、所有不同坐标的协方差都非正。几个特殊外场的计算无法完成这一项。

局部引理也可以得分。SR07 的非对角符号、SR13 的行和非负、SR14 的绝对行和界是不同工作：前两项已证明而缺少合并推理时，只完成前两项。若先证明了“给定这两种符号，绝对行和界成立”的完整条件引理，SR14 可以先通过；它不会自动使前两项通过。

另一个常见缺口是见证不一致。EgyptianFractions 的 EF06 要求同一随机样本同时满足中层和终端条件。分别得到两个存在性结果，尚未完成这一项。类似要求也用于树、矩阵、自动机和算法。

因此，许多零散引理可以作为证据保存；只有足以交付某个固定验收项时，才增加这一项的分数。具体规则见 [统一评分与验收协议](PROTOCOL.md)。

## 跑完两个实验后怎样使用

1. 在比较前固定本版清单、题目集合、允许的基础事实和相同预算。评分表由评估端保存。
2. 冻结实验截止时刻已公开的证明产物。逐项记录对应文件版本、声明、证明检查结果以及是否满足量词和共享构造要求。
3. 完整验收的项记 `passed`，审计后确认尚未完成的项记 `not_completed`。证据不足或尚未检查记 `unassessed`；未审完时不发布可比较分数。
4. 按同一分母算出每题分数。比较多题时，对预先固定题集的各题分数取等权平均，最终仍只有一个进度数。

未通过项的备注用于解释瓶颈，例如缺主引理、缺组合推理、见证不兼容或证明未通过检查；这些备注不产生额外指标。修改清单时创建新版本，并按同一新版本重新审计所有被比较的实验。

## 文件与评分范围

- [manifest.json](manifest.json) 给出题目、根目标、项数和文件映射。
- `problems/*.json` 是逐项规格；同名 Markdown 提供阅读版本，内容对应同一份 JSON。
- 每项的 `sources` 指向固定版本的真实参考声明，`depends_on` 记录它怎样接到后续证明。

评分范围以 [运行配置](../../../config/openai-math-12.json) 的唯一根目标为准。StronglyRayleighDPP 只计 `finite_strongly_rayleigh_response`；EgyptianFractions 只计 `main_double_log_order`。同文件中其他 theorem holes 和额外的 PlaneColoring smoke 题均不进入分母。

参考证明是评分表的依据。候选证明可以使用不同名字、表示和更强的结论；是否满足固定验收项，要核对完整数学含义。若换路线后大段有效工作无法映射到本表，应重新评审该题的适用性，不能临时给新产物加分母。

## 来源与本次检查

本版固定 SwarmEnv 源码于 [`7617767a945e`](https://github.com/LuNa-shi/SwarmEnv/commit/7617767a945e263f3fa412255e1a570ccdbfb98c)，上游 openai/math 为 `4eaee87548250b2682affda7d05d947c05554bae`。Lean 和 Mathlib 版本保存在 manifest 与统一协议中。

本次完成分组源码审阅、关键衔接的交叉复核，以及以下清单检查：

- 12 个题目 ID、题面路径、配置根和参考模块与原配置一致。
- 227 个评分项的 ID、依赖和来源完整；依赖无环，每项都连接到最终根目标。
- 449 条声明引用对应 188 个固定源码文件；文件路径及完整声明名均已核对。
- 阅读版与 JSON 对应，文档链接和提交空白检查通过。

这次提交的是可用于人工事后验收的评分规格。没有运行新的 Lean 全工程编译或模型实验，也没有实现自动证明匹配器；现有参考工程的构建报告仍见 [SELECTION.md](../SELECTION.md)。运行器、checker 和 12 题配置保持原样。
