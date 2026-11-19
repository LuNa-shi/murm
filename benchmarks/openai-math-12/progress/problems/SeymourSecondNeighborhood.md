# SeymourSecondNeighborhood：Seymour 第二邻域：极小反例、剪枝与极值矛盾

**19 个固定评分项 · 需进一步确认**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](SeymourSecondNeighborhood.json)

## 目标与适用性

- 题目 ID：`oai_seymour_second_neighborhood`。
- 唯一计分根：`OAI.SeymourSecondNeighborhood.exists_goodVertex`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/SeymourSecondNeighborhood.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 参考证明有清楚的三段接口：反例推出 StrictSubsetGrowth；任意有限关系满足 PruningStatement；剪枝与严格增长矛盾。可以据此冻结 19 个义务。中段的匹配、矩阵核和极值对使用同一套专门编码，验收前要确认现有实验产物能对应这些对象。

**需要留意：** SubsetDeficit、PruningResult 和最终邻域不等式具有明确含义；selectedA/selectedB、Z/H 角点和归一化核提升更依赖实现。若只换了等价编码，应给出对象对应后验收；若采用完全不同的反例机制，这套中段义务可能低估它的进展。

**下一步：** 先用本参考路线的少量轨迹试标。重点检查 ssn07–ssn10 的系数、核及同一个匹配是否可追溯，以及 ssn17 能否接回同一个极值对。能稳定映射后纳入固定题集；不能映射则保留题目及拆分，暂缓比较分数。

## 参考证明主线

按真实调用链拆分：极小反例 → 子集亏损 → 传递扩张 → 严格子集增长；增广匹配 → 秩与核界 → 完整剪枝证书；候选集增长 → 保持可容许性的目标函数提升 → 极值矛盾 → 原图存在好顶点。PositiveIndegree 指入度为正。19 项均服务于配置根目标，不把有限阶数或特殊图类当作分数阶梯。这里的必要性是这条冻结参考路线的证明义务，并非所有数学证明都必须经过这些中间对象。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| ssn01 | 取得完整的极小反例 | — |
| ssn02 | 删边产生严格亏损的一步增广 | ssn01 |
| ssn03 | 把局部增广接成全部子集亏损 | ssn01、ssn02 |
| ssn04 | 扩张把亏损转为严格增长 | ssn03 |
| ssn05 | 把任意反例送入矛盾模块 | ssn01、ssn03、ssn04 |
| ssn06 | 同时取到三个最大匹配 | — |
| ssn07 | 选出兼顾两侧的秩系数 | ssn06 |
| ssn08 | 为原始匹配边构造归一化核向量 | ssn07 |
| ssn09 | 从核提升得到原始边和辅助边的总界 | ssn07、ssn08 |
| ssn10 | 得到整个增广匹配的大小界 | ssn06、ssn09 |
| ssn11 | 最大匹配给出等大的无孤立点覆盖 | — |
| ssn12 | 从增广覆盖构造完整剪枝定理 | ssn06、ssn10、ssn11 |
| ssn13 | 建立可取极大的可容许对 | — |
| ssn14 | 将子集严格增长提升到行列像 | ssn13 |
| ssn15 | 候选补集带来严格总收益 | ssn14 |
| ssn16 | 把候选角点费用计入未覆盖部分 | — |
| ssn17 | 剪枝后的新对既合法又严格更好 | ssn12、ssn15、ssn16 |
| ssn18 | 以极大性排除严格增长 | ssn13、ssn17 |
| ssn19 | 完成原图第二邻域结论 | ssn05、ssn12、ssn18 |

### ssn01 · 取得完整的极小反例

类型：数学结果。上游：无表内上游项。

**完整结论**

从任意有限非空有向无二环关系 r 的 Counterexample，构造 n>0 与 Fin n 上的 s，同时满足 IsOriented、Counterexample、ArcMinimal、NonemptyBoundary 和 PositiveIndegree。

**允许的前提**

- 原题有限非空顶点集及 IsOriented r；反证假设 Counterexample r。

**验收条件**

五个性质必须属于同一个 s；NonemptyBoundary 要覆盖所有非空真子集，不能仅选一个最小坏顶点。

**参考声明**

- [OAI.SeymourSecondNeighborhood.exists_minimal_counterexample](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/MinimalCounterexample.lean#L132)

### ssn02 · 删边产生严格亏损的一步增广

类型：数学结果。上游：ssn01。

**完整结论**

对有向、弧数极小的反例 r，任意 S 和 T⊊image r S\S，存在非空 Q⊆(image r S\S)\T，使 deficitPotential r S (T∪Q)<deficitPotential r S T+|Q|。

**允许的前提**

- ssn01 的 IsOriented、Counterexample 和 ArcMinimal；任意满足源码包含关系的 S、T。

**验收条件**

必须证明存在这样的非空 Q 并给出严格不等式；把增广的存在性当作假设、只证明单个 S/T，均不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.deficitPotential_step](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/Deletion.lean#L75)

### ssn03 · 把局部增广接成全部子集亏损

类型：衔接推理。上游：ssn01、ssn02。

**完整结论**

利用一步增广和非空边界，证明所有非空真子集 S 都满足 |image r (image r S)\image r S|<|image r S\S|，即 SubsetDeficit r。

**允许的前提**

- ssn01 的 NonemptyBoundary；ssn02 的全称增广结论。

**验收条件**

需完成从任意部分 T 到整个边界的增广论证，并识别终点势函数；不能把几组 S 的正确不等式替代全称结论。

**参考声明**

- [OAI.SeymourSecondNeighborhood.subsetDeficit_of_minimal](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/SubsetDeficit.lean#L44)
- [OAI.SeymourSecondNeighborhood.deficitPotential_terminal](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/SubsetDeficit.lean#L10)
- [OAI.SeymourSecondNeighborhood.strict_deficit_of_augmentation](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/SubsetAugmentation.lean#L11)

### ssn04 · 扩张把亏损转为严格增长

类型：数学结果。上游：ssn03。

**完整结论**

对满足 PositiveIndegree 和 SubsetDeficit 的有向 r，任意 m>|V| 的传递扩张 blowup r m 满足：每个非空真子集 U 都有 |U|+|image g(image g U)|<2|image g U|。

**允许的前提**

- 同一个 r 的 IsOriented、PositiveIndegree；ssn03 的 SubsetDeficit；整数 m>|V|。

**验收条件**

验收完整 StrictSubsetGrowth；需同时覆盖 U 投影满支撑和非满支撑的情形。只证明单个纤维、整块子集或部分 U 不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.blowup_strictSubsetGrowth](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/TransitiveBlowup.lean#L136)

### ssn05 · 把任意反例送入矛盾模块

类型：衔接推理。上游：ssn01、ssn03、ssn04。

**完整结论**

从原题反例构造 Fin n×Fin(n+1) 上同一个 g，证明 n>0、IsOriented g、PositiveIndegree g 和 StrictSubsetGrowth g。

**允许的前提**

- 原题反证假设；ssn01、ssn03、ssn04。

**验收条件**

所有输出性质绑定同一个扩张 g；须保留入度性质和非空性，能够直接交给 ssn18。

**参考声明**

- [OAI.SeymourSecondNeighborhood.counterexample_reduction](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/Reduction.lean#L11)
- [OAI.SeymourSecondNeighborhood.blowup_isOriented](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/TransitiveBlowup.lean#L13)
- [OAI.SeymourSecondNeighborhood.blowup_positiveIndegree](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/TransitiveBlowup.lean#L31)

### ssn06 · 同时取到三个最大匹配

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限关系 r 和任意 R,C⊆V×V，存在增广图的最大匹配 M，使 alphaEdges M 和 betaEdges M 也分别是 AlphaRelation 和 BetaRelation 的最大匹配。

**允许的前提**

- 任意有限 V、关系 r 与有限集 R,C；采用源码增广图定义。

**验收条件**

三个最大性必须属于同一个 M；分别找到三个不相容的最大匹配不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Pruning.exists_augmented_maximum_matching](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/AugmentedMatching.lean#L88)

### ssn07 · 选出兼顾两侧的秩系数

类型：衔接推理。上游：ssn06。

**完整结论**

给定两侧最大匹配 α、β，构造同一个系数赋值 v，使 selectedA/selectedB 有正确支撑、selectedB 满足 LocalMaximalRanks、两侧选定子式非零，且 matrixL 与 matrixN 转置的秩分别等于 |α|、|β|。

**允许的前提**

- ssn06 同一个 M 导出的 α、β；其最大性转写为源码 matrixLSupport 与 matrixNTransposeSupport。

**验收条件**

全部支撑、局部最大秩、非零子式和精确秩结论绑定一个 v；只有泛称“取一般位置系数”没有证明存在性不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Pruning.exists_pruning_rank_coefficients](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/GenericRankSelection.lean#L35)

### ssn08 · 为原始匹配边构造归一化核向量

类型：衔接推理。上游：ssn07。

**完整结论**

用非零选定子式及秩上界，在匹配列之外的互异列上构造 U、W：它们分别落在 matrixL 和 matrixN 转置的核中，并在指定互异坐标上取 Kronecker delta 值。

**允许的前提**

- ssn07 的同一个 v、子式与秩；原始匹配边两端的单射性，以及与辅助匹配列不交。

**验收条件**

需要核方程和指定坐标值同时成立；任意非零核向量、只有维数下界或左右两侧来自不同系数赋值不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Pruning.exists_normalized_kernelLifts_of_det_ne_zero](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/KernelBasisLifts.lean#L107)
- [OAI.SeymourSecondNeighborhood.Pruning.original_add_auxiliary_card_le_corners](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/RankBoundFromMinors.lean#L13)

### ssn09 · 从核提升得到原始边和辅助边的总界

类型：衔接推理。上游：ssn07、ssn08。

**完整结论**

对左右端点分别避开辅助匹配选中列的原始冲突边族 E，证明 |E|+|α|+|β|≤|Z r R C|+|H r R C|。

**允许的前提**

- ssn07 的受支撑系数和局部最大秩；ssn08 的归一化核提升；E 每条边满足源码 Conflict。

**验收条件**

证明须把核/复合矩阵的秩界接到匹配基数界，包含原始边项 |E|；仅分别给出 matrixL、matrixN 的秩不够。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Pruning.card_add_rank_matrixL_add_rank_matrixN_le_card_Z_add_card_H_of_lifts](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/CompositeRankBound.lean#L60)
- [OAI.SeymourSecondNeighborhood.Pruning.original_add_auxiliary_card_le_corners](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/RankBoundFromMinors.lean#L13)

### ssn10 · 得到整个增广匹配的大小界

类型：衔接推理。上游：ssn06、ssn09。

**完整结论**

对 ssn06 的同一个 M，利用原始边、α 边和 β 边的分解，证明 |M|≤|Z r R C|+|H r R C|。

**允许的前提**

- ssn06 的匹配及两侧最大性；ssn09 的总界。

**验收条件**

需检查原始边端点互异、与两侧辅助边不交并正确计数全部 M；只界住某一类边不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Pruning.augmented_matching_card_le_corners](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/AugmentedRankBound.lean#L12)

### ssn11 · 最大匹配给出等大的无孤立点覆盖

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限二分图 E 和最大匹配 M，构造点覆盖 A,B，使 |A|+|B|=|M|，并且覆盖中每个左右顶点都确实关联至少一条边。

**允许的前提**

- 任意有限二分图与其最大匹配 M；不额外假设图无孤立点。

**验收条件**

需证明点覆盖与匹配等大的存在性，同时排除覆盖中无用的孤立点。只给匹配数≤覆盖数、或仅有等大但不证明保留条件所需性质，不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Bipartite.exists_vertexCover_card_eq_of_isMaximumMatching](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/MatchingCover.lean#L181)

### ssn12 · 从增广覆盖构造完整剪枝定理

类型：衔接推理。上游：ssn06、ssn10、ssn11。

**完整结论**

对任意有限关系 r 和所有 R,C⊆V×V，利用增广图的等大点覆盖构造 R′⊆R、C′⊆C：无冲突、保留原来与另一侧完全无冲突的点，且 |R\R′|+|C\C′|≤|H r R C|+|uncoveredZ r R C R′ C′|。

**允许的前提**

- ssn06 的增广最大匹配、ssn10 的大小界和 ssn11 的等大无孤立点覆盖；r 无需额外有向性、增长性或正入度。

**验收条件**

完整 PruningResult 的子集、无冲突、两侧保留及删除预算必须属于同一对 R′,C′，并对所有 R,C 成立。只找到无冲突子集或留下覆盖构造为未证输入，不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Pruning.exists_pruning_of_augmented_cover](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/CoverPruning.lean#L13)
- [OAI.SeymourSecondNeighborhood.Pruning.exists_pruning_of_augmented_matching_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/CoverPruning.lean#L128)
- [OAI.SeymourSecondNeighborhood.Pruning.pruning](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/Pruning.lean#L10)
- [OAI.SeymourSecondNeighborhood.Pruning.PruningResult](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/PruningDefinitions.lean#L53)

### ssn13 · 建立可取极大的可容许对

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有向 r，以双对角线为可容许对，证明存在 Admissible r P Q，使 objective r P Q=|P|+|Q|+uncoveredCount r P Q 在全部可容许对上达到最大。

**允许的前提**

- 原题有限顶点集及 IsOriented r；Admissible、objective 的源码定义。

**验收条件**

必须同时保证两侧含对角线、无冲突，以及对所有可容许 P',Q' 的最大性。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Extremal.diagonal_admissible](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCompatibility.lean#L54)
- [OAI.SeymourSecondNeighborhood.Extremal.exists_maximizing_pair](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCounting.lean#L53)

### ssn14 · 将子集严格增长提升到行列像

类型：衔接推理。上游：ssn13。

**完整结论**

对任意 Admissible r P Q，在正入度与 StrictSubsetGrowth 下证明 |P|+|leftImage r(leftImage r P)|<2|leftImage r P|，以及对应 Q 的 rightImage 不等式。

**允许的前提**

- Admissible r P Q；PositiveIndegree r；StrictSubsetGrowth r，作为反证分支的明确输入。

**验收条件**

两侧都需证明；行、列必须非空且为真子集的条件要由可容许性和正入度导出，不能新增为假设。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Extremal.Admissible.strict_leftImage_growth](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCompatibility.lean#L94)
- [OAI.SeymourSecondNeighborhood.Extremal.Admissible.strict_rightImage_growth](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCompatibility.lean#L102)

### ssn15 · 候选补集带来严格总收益

类型：衔接推理。上游：ssn14。

**完整结论**

在同一可容许 P,Q 上证明 |P|+|Q|+2·uncoveredCount r P Q < |leftCandidate r Q|+|rightCandidate r P|。

**允许的前提**

- ssn14 的两侧增长；同一 P,Q 的无冲突性。

**验收条件**

需把两侧严格增长和未覆盖部分的精确计数接起来；分别有两个局部增长式而未得到候选对收益不通过。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Extremal.complement_gain](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalContradiction.lean#L12)
- [OAI.SeymourSecondNeighborhood.Extremal.uncoveredCount_add_images](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCounting.lean#L21)

### ssn16 · 把候选角点费用计入未覆盖部分

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意 r,P,Q，证明 H r (leftCandidate r Q) (rightCandidate r P) 包含于原来的 uncovered 集，因此其基数不超过 uncoveredCount r P Q。

**允许的前提**

- 有限关系和源码 leftCandidate、rightCandidate、H、uncovered 定义。

**验收条件**

需对全部候选角点给出包含关系或等价基数证明；不能把费用界当成剪枝输入假设。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Extremal.H_candidates_subset_uncovered](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCompatibility.lean#L162)
- [OAI.SeymourSecondNeighborhood.Extremal.H_candidates_card_le_uncovered](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCompatibility.lean#L174)

### ssn17 · 剪枝后的新对既合法又严格更好

类型：衔接推理。上游：ssn12、ssn15、ssn16。

**完整结论**

把 ssn12 用于候选集，并结合收益和费用界，证明得到的同一 P',Q' 仍 Admissible，且 objective r P Q<objective r P' Q'。

**允许的前提**

- 原来的 Admissible r P Q；候选集上的完整 PruningResult；ssn15、ssn16。

**验收条件**

两侧对角线保留和严格目标提升必须属于同一个剪枝结果。无冲突的新对与另一个大目标值的新对不能拼接计分。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Extremal.pruning_preserves_diagonal](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCompatibility.lean#L188)
- [OAI.SeymourSecondNeighborhood.Extremal.objective_lt_of_pruning](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalCounting.lean#L40)

### ssn18 · 以极大性排除严格增长

类型：衔接推理。上游：ssn13、ssn17。

**完整结论**

对有限非空有向且正入度的 r，由 PruningStatement r 推出 ¬StrictSubsetGrowth r。

**允许的前提**

- IsOriented r、PositiveIndegree r；完整剪枝定理；ssn13 的极大对及 ssn17。

**验收条件**

必须关闭反证：把新对的严格提升与原对对所有可容许对的最大性应用到同一对象上。

**参考声明**

- [OAI.SeymourSecondNeighborhood.Extremal.no_strictSubsetGrowth_of_pruning](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ExtremalContradiction.lean#L29)

### ssn19 · 完成原图第二邻域结论

类型：汇合结论。上游：ssn05、ssn12、ssn18。

**完整结论**

证明配置根目标：每个有限非空有向无二环关系 r 都存在 v，使 |firstNeighbors r v|≤|secondNeighbors r v|。

**允许的前提**

- 原题全部类型条件和 IsOriented r；ssn05 的反例归约与 ssn18 的矛盾；不再保留反例或剪枝作为未证假设。

**验收条件**

交付精确的 OAI.SeymourSecondNeighborhood.exists_goodVertex；恢复原顶点集，第二邻域采用题面排除自身和直接邻居的定义。

**参考声明**

- [OAI.SeymourSecondNeighborhood.exists_goodVertex](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/Main.lean#L11)
- [OAI.SeymourSecondNeighborhood.counterexample_iff_not_conjecture](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/SecondNeighborhood/ReductionCore.lean#L48)
