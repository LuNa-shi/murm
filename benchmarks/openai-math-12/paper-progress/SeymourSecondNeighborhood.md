# SeymourSecondNeighborhood 的论文形式化验收表

配置根为 `OAI.SeymourSecondNeighborhood.exists_goodVertex`。共 19 个等权项。[统一协议](README.md) · [结构化表](SeymourSecondNeighborhood.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/paper.pdf)

有限非空有向无二环图的严格第二邻域。论文反例归约、增广匹配剪枝、极值矛盾三段分别对应 ssn01–05、06–12、13–18，最后交付配置根。

匹配、系数、核与剪枝输出要可用于同一见证。任意最小出度的特殊情形可以在旁列报告；单个特例无法完成要求所有有限图的项目。

## ssn01 · 取得完整的极小反例

从任意有限非空有向无二环关系 r 的 Counterexample，构造 n>0 与 Fin n 上的 s，同时满足 IsOriented、Counterexample、ArcMinimal、NonemptyBoundary 和 PositiveIndegree。

**允许前提**　原题有限非空顶点集及 IsOriented r；反证假设 Counterexample r。

**依赖**　无

**验收**　同一非空有限图同时满足五项。ArcMinimal 要与同顶点集上所有有向反例比较弧数。仅证明删去本图任意真子集的边后不再是反例，仍缺全局极小性。允许在等价有限顶点类型上提供完整证明，再作固定重标号。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/01-reduction.tex#L37-L58)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.exists_minimal_counterexample`。

## ssn02 · 删边产生严格亏损的一步增广

对有向、弧数极小的反例 r，任意 S 和 T⊊image r S\S，存在非空 Q⊆(image r S\S)\T，使 deficitPotential r S (T∪Q)<deficitPotential r S T+|Q|。

**允许前提**　ssn01 的 IsOriented、Counterexample 和 ArcMinimal；任意满足源码包含关系的 S、T。

**依赖**　ssn01

**验收**　必须证明存在这样的非空 Q 并给出严格不等式；把增广的存在性当作假设、只证明单个 S/T，均不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/01-reduction.tex#L59-L126)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.deficitPotential_step`。

## ssn03 · 把局部增广接成全部子集亏损

利用一步增广和非空边界，证明所有非空真子集 S 都满足 |image r (image r S)\image r S|<|image r S\S|，即 SubsetDeficit r。

**允许前提**　ssn01 的 NonemptyBoundary；ssn02 的全称增广结论。

**依赖**　ssn01、ssn02

**验收**　需完成从任意部分 T 到整个边界的增广论证，并识别终点势函数；不能把几组 S 的正确不等式替代全称结论。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/01-reduction.tex#L126-L139)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.subsetDeficit_of_minimal`、`OAI.SeymourSecondNeighborhood.deficitPotential_terminal`、`OAI.SeymourSecondNeighborhood.strict_deficit_of_augmentation`。

## ssn04 · 扩张把亏损转为严格增长

对满足 PositiveIndegree 和 SubsetDeficit 的有向 r，任意 m>|V| 的传递扩张 blowup r m 满足：每个非空真子集 U 都有 |U|+|image g(image g U)|<2|image g U|。

**允许前提**　同一个 r 的 IsOriented、PositiveIndegree；ssn03 的 SubsetDeficit；整数 m>|V|。

**依赖**　ssn03

**验收**　验收完整 StrictSubsetGrowth；需同时覆盖 U 投影满支撑和非满支撑的情形。只证明单个纤维、整块子集或部分 U 不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/01-reduction.tex#L151-L235)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.blowup_strictSubsetGrowth`。

## ssn05 · 把任意反例送入矛盾模块

从原题反例构造 Fin n×Fin(n+1) 上同一个 g，证明 n>0、IsOriented g、PositiveIndegree g 和 StrictSubsetGrowth g。

**允许前提**　原题反证假设；ssn01、ssn03、ssn04。

**依赖**　ssn01、ssn03、ssn04

**验收**　所有输出性质绑定同一个扩张 g；须保留入度性质和非空性，能够直接交给 ssn18。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/01-reduction.tex#L237-L242)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.counterexample_reduction`、`OAI.SeymourSecondNeighborhood.blowup_isOriented`、`OAI.SeymourSecondNeighborhood.blowup_positiveIndegree`。

## ssn06 · 同时取到三个最大匹配

对任意有限关系 r 和任意 R,C⊆V×V，存在增广图的最大匹配 M，使 alphaEdges M 和 betaEdges M 也分别是 AlphaRelation 和 BetaRelation 的最大匹配。

**允许前提**　任意有限 V、关系 r 与有限集 R,C；采用源码增广图定义。

**依赖**　无

**验收**　三个最大性必须属于同一个 M；分别找到三个不相容的最大匹配不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/02-pruning.tex#L121-L147)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Pruning.exists_augmented_maximum_matching`。

## ssn07 · 选出兼顾两侧的秩系数

给定两侧最大匹配 α、β，构造同一个系数赋值 v，使 selectedA/selectedB 有正确支撑、selectedB 满足 LocalMaximalRanks、两侧选定子式非零，且 matrixL 与 matrixN 转置的秩分别等于 |α|、|β|。

**允许前提**　ssn06 同一个 M 导出的 α、β；其最大性转写为源码 matrixLSupport 与 matrixNTransposeSupport。

**依赖**　ssn06

**验收**　全部支撑、局部最大秩、非零子式和精确秩结论绑定一个 v；只有泛称“取一般位置系数”没有证明存在性不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/02-pruning.tex#L207-L258)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Pruning.exists_pruning_rank_coefficients`。

## ssn08 · 为原始匹配边构造归一化核向量

用非零选定子式及秩上界，在匹配列之外的互异列上构造 U、W：它们分别落在 matrixL 和 matrixN 转置的核中，并在指定互异坐标上取 Kronecker delta 值。

**允许前提**　ssn07 的同一个 v、子式与秩；原始匹配边两端的单射性，以及与辅助匹配列不交。

**依赖**　ssn07

**验收**　需要核方程和指定坐标值同时成立；任意非零核向量、只有维数下界或左右两侧来自不同系数赋值不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/02-pruning.tex#L258-L275)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Pruning.exists_normalized_kernelLifts_of_det_ne_zero`、`OAI.SeymourSecondNeighborhood.Pruning.original_add_auxiliary_card_le_corners`。

## ssn09 · 从核提升得到原始边和辅助边的总界

对左右端点分别避开辅助匹配选中列的原始冲突边族 E，证明 |E|+|α|+|β|≤|Z r R C|+|H r R C|。

**允许前提**　ssn07 的受支撑系数和局部最大秩；ssn08 的归一化核提升；E 每条边满足源码 Conflict。

**依赖**　ssn07、ssn08

**验收**　证明须把核/复合矩阵的秩界接到匹配基数界，包含原始边项 |E|；仅分别给出 matrixL、matrixN 的秩不够。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/02-pruning.tex#L276-L334)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Pruning.card_add_rank_matrixL_add_rank_matrixN_le_card_Z_add_card_H_of_lifts`、`OAI.SeymourSecondNeighborhood.Pruning.original_add_auxiliary_card_le_corners`。

## ssn10 · 得到整个增广匹配的大小界

对 ssn06 的同一个 M，利用原始边、α 边和 β 边的分解，证明 |M|≤|Z r R C|+|H r R C|。

**允许前提**　ssn06 的匹配及两侧最大性；ssn09 的总界。

**依赖**　ssn06、ssn09

**验收**　需检查原始边端点互异、与两侧辅助边不交并正确计数全部 M；只界住某一类边不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/02-pruning.tex#L188-L206)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Pruning.augmented_matching_card_le_corners`。

## ssn11 · 最大匹配给出等大的无孤立点覆盖

对任意有限二分图 E 和最大匹配 M，构造点覆盖 A,B，使 |A|+|B|=|M|，并且覆盖中每个左右顶点都确实关联至少一条边。

**允许前提**　任意有限二分图与其最大匹配 M；不额外假设图无孤立点。

**依赖**　无

**验收**　需证明点覆盖与匹配等大的存在性，同时排除覆盖中无用的孤立点。只给匹配数≤覆盖数、或仅有等大但不证明保留条件所需性质，不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/02-pruning.tex#L335-L356)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Bipartite.exists_vertexCover_card_eq_of_isMaximumMatching`。

## ssn12 · 从增广覆盖构造完整剪枝定理

对任意有限关系 r 和所有 R,C⊆V×V，利用增广图的等大点覆盖构造 R′⊆R、C′⊆C：无冲突、保留原来与另一侧完全无冲突的点，且 |R\R′|+|C\C′|≤|H r R C|+|uncoveredZ r R C R′ C′|。

**允许前提**　ssn06 的增广最大匹配、ssn10 的大小界和 ssn11 的等大无孤立点覆盖；r 无需额外有向性、增长性或正入度。

**依赖**　ssn06、ssn10、ssn11

**验收**　完整 PruningResult 的子集、无冲突、两侧保留及删除预算必须属于同一对 R′,C′，并对所有 R,C 成立。只找到无冲突子集或留下覆盖构造为未证输入，不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/02-pruning.tex#L101-L120)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Pruning.exists_pruning_of_augmented_cover`、`OAI.SeymourSecondNeighborhood.Pruning.exists_pruning_of_augmented_matching_bound`、`OAI.SeymourSecondNeighborhood.Pruning.pruning`、`OAI.SeymourSecondNeighborhood.Pruning.PruningResult`。

## ssn13 · 建立可取极大的可容许对

对任意有向 r，以双对角线为可容许对，证明存在 Admissible r P Q，使 objective r P Q=|P|+|Q|+uncoveredCount r P Q 在全部可容许对上达到最大。

**允许前提**　原题有限顶点集及 IsOriented r；Admissible、objective 的源码定义。

**依赖**　无

**验收**　必须同时保证两侧含对角线、无冲突，以及对所有可容许 P',Q' 的最大性。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/03-incompatibility.tex#L23-L50)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Extremal.diagonal_admissible`、`OAI.SeymourSecondNeighborhood.Extremal.exists_maximizing_pair`。

## ssn14 · 将子集严格增长提升到行列像

对任意 Admissible r P Q，在正入度与 StrictSubsetGrowth 下证明 |P|+|leftImage r(leftImage r P)|<2|leftImage r P|，以及对应 Q 的 rightImage 不等式。

**允许前提**　Admissible r P Q；PositiveIndegree r；StrictSubsetGrowth r，作为反证分支的明确输入。

**依赖**　ssn13

**验收**　两侧都需证明；行、列必须非空且为真子集的条件要由可容许性和正入度导出，不能新增为假设。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/03-incompatibility.tex#L52-L64)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Extremal.Admissible.strict_leftImage_growth`、`OAI.SeymourSecondNeighborhood.Extremal.Admissible.strict_rightImage_growth`。

## ssn15 · 候选补集带来严格总收益

在同一可容许 P,Q 上证明 |P|+|Q|+2·uncoveredCount r P Q < |leftCandidate r Q|+|rightCandidate r P|。

**允许前提**　ssn14 的两侧增长；同一 P,Q 的无冲突性。

**依赖**　ssn14

**验收**　需把两侧严格增长和未覆盖部分的精确计数接起来；分别有两个局部增长式而未得到候选对收益不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/03-incompatibility.tex#L66-L80)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Extremal.complement_gain`、`OAI.SeymourSecondNeighborhood.Extremal.uncoveredCount_add_images`。

## ssn16 · 把候选角点费用计入未覆盖部分

对任意 r,P,Q，证明 H r (leftCandidate r Q) (rightCandidate r P) 包含于原来的 uncovered 集，因此其基数不超过 uncoveredCount r P Q。

**允许前提**　有限关系和源码 leftCandidate、rightCandidate、H、uncovered 定义。

**依赖**　无

**验收**　需对全部候选角点给出包含关系或等价基数证明；不能把费用界当成剪枝输入假设。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/03-incompatibility.tex#L95-L112)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Extremal.H_candidates_subset_uncovered`、`OAI.SeymourSecondNeighborhood.Extremal.H_candidates_card_le_uncovered`。

## ssn17 · 剪枝后的新对既合法又严格更好

把 ssn12 用于候选集，并结合收益和费用界，证明得到的同一 P',Q' 仍 Admissible，且 objective r P Q<objective r P' Q'。

**允许前提**　原来的 Admissible r P Q；候选集上的完整 PruningResult；ssn15、ssn16。

**依赖**　ssn12、ssn15、ssn16

**验收**　两侧对角线保留和严格目标提升必须属于同一个剪枝结果。无冲突的新对与另一个大目标值的新对不能拼接计分。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/03-incompatibility.tex#L81-L137)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Extremal.pruning_preserves_diagonal`、`OAI.SeymourSecondNeighborhood.Extremal.objective_lt_of_pruning`。

## ssn18 · 以极大性排除严格增长

对有限非空有向且正入度的 r，由 PruningStatement r 推出 ¬StrictSubsetGrowth r。

**允许前提**　IsOriented r、PositiveIndegree r；完整剪枝定理；ssn13 的极大对及 ssn17。

**依赖**　ssn13、ssn17

**验收**　必须关闭反证：把新对的严格提升与原对对所有可容许对的最大性应用到同一对象上。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/03-incompatibility.tex#L128-L141)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.Extremal.no_strictSubsetGrowth_of_pruning`。

## ssn19 · 完成原图第二邻域结论

证明配置根目标：每个有限非空有向无二环关系 r 都存在 v，使 |firstNeighbors r v|≤|secondNeighbors r v|。

**允许前提**　原题全部类型条件和 IsOriented r；ssn05 的反例归约与 ssn18 的矛盾；不再保留反例或剪枝作为未证假设。

**依赖**　ssn05、ssn12、ssn18

**验收**　交付精确的 OAI.SeymourSecondNeighborhood.exists_goodVertex；恢复原顶点集，第二邻域采用题面排除自身和直接邻居的定义。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-proof-of-Seymours-second-neighborhood-conjecture-September-23-2026/build/source/03-incompatibility.tex#L143-L148)

参考 Lean 声明：`OAI.SeymourSecondNeighborhood.exists_goodVertex`、`OAI.SeymourSecondNeighborhood.counterexample_iff_not_conjecture`。
