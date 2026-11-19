# SecondKahnKalai：Second Kahn–Kalai：期望阈值、概率树与图包含阈值

**20 个固定评分项 · 需进一步确认**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](SecondKahnKalai.json)

## 目标与适用性

- 题目 ID：`oai_second_kahn_kalai`。
- 唯一计分根：`OAI.LeanBlast.SecondKahnKalai.secondKahnKalaiBounds`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/SecondKahnKalai.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 参考证明的 20 个义务可按图表示、概率树构造、随机剪枝、路径恢复及阈值转换验收。它很适合检查“局部概率估计已有，但接不回原图”的瓶颈；前提是全过程能追溯同一棵树和同一概率分布。

**需要留意：** 局部 failure 界、spread 界和树容量界可以分别成立，却未必属于同一个构造。树的共享见证和条件分布变化尤其容易漏接。另一条不使用该树构造的完整路线可直接验收根目标；其内部进展不一定能由本表公平表达。

**下一步：** 先试标同一轨迹中的树见证 T、容量 m、参数 q 和 reduceTree。要求 skk06、skk10–skk13、skk18 能用明确映射连接。若轨迹没有这些可核对对象，暂不将它纳入固定路线的比较题集；保留本拆分供后续换题判断。

## 参考证明主线

根证明先在实际子图期望阈值 q 上取得所有约束，再把原图转为边轨道，构造 spread 为 128q 的概率树。局部重采样界经树势函数给出一次好抽样概率；剪枝同时保持容量、spread 和路径恢复，重复抽样后覆盖整条路径，最后转回实际图包含概率与两个阈值上界。分数统计下面固定的完整义务；参数 m、q、容量减半只出现在参考证明的数学陈述中，不按参数大小或特殊图范围分档给分。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| skk01 | 期望阈值确实可用且严格为正 | — |
| skk02 | 轨道计数等于实际无标号副本计数 | — |
| skk03 | 把阈值约束和包含事件接到同一边集 | skk01、skk02 |
| skk04 | 选择严格变小的前驱 | skk01、skk03 |
| skk05 | 同一前驱给出条件扩张概率界 | — |
| skk06 | 构造所有性质同时成立的概率树 | skk03、skk04、skk05 |
| skk07 | 局部重采样失败概率界 | — |
| skk08 | 处理子树与重采样权重的相关性 | — |
| skk09 | 从局部界得到整树好抽样概率 | skk07、skk08 |
| skk10 | 好抽样生成合法且容量减半的子树 | — |
| skk11 | 把剪枝子树的每条路径接回原树 | skk10 |
| skk12 | 控制剪枝后的 spread 损耗 | skk10 |
| skk13 | 一次好抽样产生真正的严格推进 | skk10、skk11、skk12 |
| skk14 | 有限次自适应推进覆盖原树 | skk13 |
| skk15 | 向上封闭事件的 Bernoulli 单调性 | — |
| skk16 | 得到整棵 spread 树的覆盖定理 | skk09、skk13、skk14、skk15 |
| skk17 | 把树采样参数接到图参数 | skk01、skk06 |
| skk18 | 覆盖路径真正给出原图阈值界 | skk03、skk06、skk15、skk16、skk17 |
| skk19 | 把边数形式转成顶点数形式 | — |
| skk20 | 完成题面两个临界阈值上界 | skk18、skk19 |

### skk01 · 期望阈值确实可用且严格为正

类型：数学结果。上游：无表内上游项。

**完整结论**

在 |V(H)|≤n、edgeCount(H)≥1 下，对 q=expectationThreshold n H 证明 q∈[0,1]、每个实际子图 F 的 expectedCopies n q F≥1/2，并证明 q>0。

**允许的前提**

- 原题有限 H、顶点数界和至少一条边；题面下确界及实际子图期望定义。

**验收条件**

需证明可行集非空、闭性导致下确界达到，并用实际含边子图排除 q=0。只把 infimum 当成可行点、或只检查 H 自身不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.expectationThreshold_attained](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Thresholds.lean#L150)
- [OAI.LeanBlast.SecondKahnKalai.expectationThreshold_pos](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Thresholds.lean#L169)

### skk02 · 轨道计数等于实际无标号副本计数

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意边集 S⊆Edge n，证明 orbitCount(S)=完整图中 edgeSupportGraph(S) 的实际无标号 copyCount，并推出 expectedCopies n p edgeSupportGraph(S)=orbitCount(S)·p^|S|。

**允许的前提**

- 源码 Edge、copyOrbit、edgeSupportGraph 及题面的实际无标号 copyCount 定义。

**验收条件**

需给出边轨道与实际子图副本的双射并保留精确倍数；带标号嵌入数或忽略自同构倍数不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.orbitSubgraphEquiv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphCopies.lean#L29)
- [OAI.LeanBlast.SecondKahnKalai.orbitCount_eq_copyCount](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphCopies.lean#L48)
- [OAI.LeanBlast.SecondKahnKalai.expectedCopies_edgeSupportGraph](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphCopies.lean#L63)

### skk03 · 把阈值约束和包含事件接到同一边集

类型：衔接推理。上游：skk01、skk02。

**完整结论**

构造同一个 E⊆Edge n，|E|=edgeCount H；对所有随机边集 W，H 有副本当且仅当 E 的某个轨道副本包含于 W；对所有 S⊆E，证明 orbitCount(S)·q^|S|≥1/2。

**允许的前提**

- 原题 |V(H)|≤n；skk01 的全部子图约束；skk02 的精确计数。

**验收条件**

基数、事件等价和全部子集约束必须使用同一个 E；原图有孤立顶点时也需正确恢复包含事件。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.exists_graphRepresentationWithConstraints](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphCopies.lean#L91)
- [OAI.LeanBlast.SecondKahnKalai.orbit_expectation_constraint](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphCopies.lean#L70)
- [OAI.LeanBlast.SecondKahnKalai.copyCount_pos_iff_orbit_subset](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphCopies.lean#L79)

### skk04 · 选择严格变小的前驱

类型：数学结果。上游：skk01、skk03。

**完整结论**

对满足全部非空子集轨道期望约束的非空 I，在 σ=128q 下选择 maximizingPredecessor S⊆I，并证明 17|S|<|I|。

**允许的前提**

- q>0；对每个非空 U⊆I 的 orbitCount(U)·q^|U|≥1/2；predecessorScore 的源码定义。

**验收条件**

需证明实际有限最大值所选 S 的严格缩小；不能直接假设有小前驱，或只展示一个不具备最大值性质的小子集。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.maximizingPredecessor_subset](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Predecessor.lean#L125)
- [OAI.LeanBlast.SecondKahnKalai.maximizingPredecessor_small](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Predecessor.lean#L175)

### skk05 · 同一前驱给出条件扩张概率界

类型：数学结果。上游：无表内上游项。

**完整结论**

对 σ>0 和 maximizingPredecessor 的任意轨道副本 S₀，证明 containmentProb(I,S₀)>0，并对与 S₀ 不交的 J 证明 containmentProb(I,S₀∪J)/containmentProb(I,S₀)≤σ^|J|。

**允许的前提**

- 任意有限群作用、有限 I、σ>0；S₀ 是源码所选 maximizingPredecessor 的副本，Disjoint S₀ J。

**验收条件**

必须控制全部副本和全部允许的 J，且分母严格为正；只在原位置的 S 上给界不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.predecessor_copy_prob_pos](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Predecessor.lean#L190)
- [OAI.LeanBlast.SecondKahnKalai.predecessor_conditional_ratio_le](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Predecessor.lean#L195)

### skk06 · 构造所有性质同时成立的概率树

类型：衔接推理。上游：skk03、skk04、skk05。

**完整结论**

从 E 的约束构造 k>0、容量序列 m 和 T:ProbabilityTree(Edge n,k)，同时满足 IsDisjoint、HasCapacities m、HasSpread(128q)、每层容量正、16m_i≤m_(i+1)、末层容量≤|E|，且每条路径并集都是 E 的轨道副本。

**允许的前提**

- 同一个 E、q>0 及其全部轨道约束；skk04、skk05。

**验收条件**

必须实际构造 T，全部性质绑定同一 T,m；不能把一棵具有所需性质的树作为假设，也不能只给出集合层级而缺少条件概率分布。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.exists_setHierarchy](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphHierarchy.lean#L78)
- [OAI.LeanBlast.SecondKahnKalai.exists_spread_orbit_tree_of_predecessors](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphHierarchy.lean#L269)
- [OAI.LeanBlast.SecondKahnKalai.exists_spread_orbit_tree](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/GraphHierarchy.lean#L302)

### skk07 · 局部重采样失败概率界

类型：数学结果。上游：无表内上游项。

**完整结论**

对正有限分布 ν、标签 A_b、0<ρ<1、容量 m≥1、|A_b|≤m、spread 参数 a≥0 且 a/ρ≤exp(−50)，证明重采样 LocalFailure 的 Bernoulli 平均概率≤exp(−9m)。

**允许的前提**

- local_failure_bound 的完整容量、正性、spread 与参数假设；源码实际 resamplingLaw 和 LocalFailure 定义。

**验收条件**

需同时控制归一化密度过小和残余片段过大两种失败；只给某一种尾界或把来源/目标样本混成独立样本不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.local_failure_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/LocalFailure.lean#L246)

### skk08 · 处理子树与重采样权重的相关性

类型：数学结果。上游：无表内上游项。

**完整结论**

在源码 spread、容量和 a/p≤exp(−50) 条件下，对仅依赖 A_b 外部的非负 f，以及被 cutoffTargetMass 控制的 t，证明 E_p[t(W)f(W)]≤exp(11m)·ν(b)·E_p[f(W)]。

**允许的前提**

- 0<p≤1、a≥0、IsSpread ν A a、|A_b|≤m、f≥0、DependsOutside(A_b,f)、t 的逐点 cutoff 上界。

**验收条件**

需证明换测度不等式并保留 DependsOutside 的真实适用范围。直接把两个相关随机量的期望拆成乘积不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.outside_change_of_measure_of_le](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/OutsideChangeOfMeasure.lean#L247)

### skk09 · 从局部界得到整树好抽样概率

类型：衔接推理。上游：skk07、skk08。

**完整结论**

对满足源码不交性、容量 m、spread a、m_j≥1、a_j/p≤exp(−50) 及 16 倍容量增长的同一 T，证明 P_p(Good p m W T)≥3/4。

**允许的前提**

- 0<p<1；完整树性质、全部层的容量和 spread 条件；skk07、skk08。

**验收条件**

需建立递归势函数期望界，并把全树坏事件控制到小于 1/4。每层失败概率很小而未控制整树，或把子树错误视为独立，不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.treePotential_expectation_node_le](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreePotential.lean#L256)
- [OAI.LeanBlast.SecondKahnKalai.treePotential_expectation_le](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreePotential.lean#L279)
- [OAI.LeanBlast.SecondKahnKalai.reduction_good_probability_ge](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreePotential.lean#L325)

### skk10 · 好抽样生成合法且容量减半的子树

类型：数学结果。上游：无表内上游项。

**完整结论**

给定 Good ρ m W T，构造实际 reduceTree；证明保留的条件分布归一化且为正，标签是原标签减去 W，容量变为 ⌊m_j/2⌋，并保持 IsDisjoint。

**允许的前提**

- ρ>0、原各层容量正、原树 IsDisjoint 以及明确的 Good 输入；reduceTree 使用源码的 successfulTargetMass。

**验收条件**

需交付同一个合法概率树及两项结构性质。只删掉标签、只减小数值容量，或未证明剩余概率质量可归一化，不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.retainedLaw](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeReduction.lean#L48)
- [OAI.LeanBlast.SecondKahnKalai.retainedLaw_positive](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeReduction.lean#L56)
- [OAI.LeanBlast.SecondKahnKalai.reduceTree](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeReduction.lean#L157)
- [OAI.LeanBlast.SecondKahnKalai.reduceTree_hasCapacities](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeReduction.lean#L190)
- [OAI.LeanBlast.SecondKahnKalai.reduceTree_isDisjoint](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeReduction.lean#L205)

### skk11 · 把剪枝子树的每条路径接回原树

类型：衔接推理。上游：skk10。

**完整结论**

对 skk10 的 reduceTree 每条路径 q，构造原 T 的路径 p，使 T.pathUnion(p)⊆W∪reduceTree.pathUnion(q)。

**允许的前提**

- 同一 T,W,ρ,m 及 Good 证据；skk10 的构造。

**验收条件**

必须是对所有新路径的可恢复性，且恢复到同一个原树；一个小残余集合或某条不相关原路径不满足本义务。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.reduceTree_path_recovery](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeReduction.lean#L222)

### skk12 · 控制剪枝后的 spread 损耗

类型：衔接推理。上游：skk10。

**完整结论**

若原 T.HasSpread a 且每层 a_j≥0，证明同一 reduceTree.HasSpread(j↦a_j/(1−exp(−m_j)))。

**允许的前提**

- skk10 同一个构造与正容量；原树全部层的 spread 界。

**验收条件**

需计算条件化后每层分布的分母和片段概率，不得沿用原 spread 常数而忽略归一化损耗。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.retainedLaw_isSpread](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeReduction.lean#L71)
- [OAI.LeanBlast.SecondKahnKalai.reduceTree_hasSpread](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeReduction.lean#L249)

### skk13 · 一次好抽样产生真正的严格推进

类型：衔接推理。上游：skk10、skk11、skk12。

**完整结论**

对 rank 非零的 CoverState，在 Good 抽样下构造下一个状态，保持原树路径恢复、spread 预算与容量条件；seen 更新为 seen∪W，删去零容量前缀后 rank 严格降低。

**允许的前提**

- 同一个原树与合法 CoverState；σ>0、ρ>0、rank≠0 和 Good；skk10–skk12。

**验收条件**

需同时给出状态合法性、恢复关系和严格 rank 下降。仅证明容量减半而状态无法继续迭代，不能验收。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.ProbabilityTree.CoverState.exists_advance_of_halved](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeCovering.lean#L282)
- [OAI.LeanBlast.SecondKahnKalai.ProbabilityTree.CoverState.exists_advance_of_good](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeCovering.lean#L332)

### skk14 · 有限次自适应推进覆盖原树

类型：数学结果。上游：skk13。

**完整结论**

对任意初始 rank≤s 的 CoverState，若每个非零状态下一次抽样的严格推进概率≥3/4，证明 4s 次 iid 抽样后原树被 seen 与抽样并集覆盖的概率≥2/3。

**允许的前提**

- 固定抽样分布 μ；各状态的一步全称推进概率假设；源码 step 的 rank 不增及恢复关系；初始 rank≤s。

**验收条件**

需证明适应于历史的状态过程，而不是假设推进事件相互独立；rank=0 必须能推出原树路径被覆盖。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.adaptive_rank_completion](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/AdaptiveTrials.lean#L186)
- [OAI.LeanBlast.SecondKahnKalai.ProbabilityTree.CoverState.prob_covered_of_advance_probability](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeCovering.lean#L263)

### skk15 · 向上封闭事件的 Bernoulli 单调性

类型：数学结果。上游：无表内上游项。

**完整结论**

对任何向上封闭的边集事件 P 和 0≤p≤q≤1，证明 bernoulliProbability p P≤bernoulliProbability q P。

**允许的前提**

- 有限底集、事件关于包含的单调性及 0≤p≤q≤1。

**验收条件**

证明完整概率比较，之后可用于同一个 CoveredBy 事件；仅比较期望边数不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.bernoulliProbability_mono_parameter](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/BernoulliMonotonicity.lean#L54)

### skk16 · 得到整棵 spread 树的覆盖定理

类型：衔接推理。上游：skk09、skk13、skk14、skk15。

**完整结论**

对 k>0、正容量且 16 倍增长的 disjoint、σ-spread 树 T，证明在 pTree=min(1,16·exp(50)·σ·(1+log₂ m_(k−1))) 下，P(T.CoveredBy)≥2/3。

**允许的前提**

- 同一 T,m,σ>0 的完整结构性质；skk09、skk13–skk15。

**验收条件**

需推出每个状态的推进概率、合并 iid 抽样的 Bernoulli 分布、控制总抽样预算并处理 min=1 情形；不能只给单次好抽样概率。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.tree_covering](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeCovering.lean#L407)
- [OAI.LeanBlast.SecondKahnKalai.tree_covering_of_progress](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeCovering.lean#L356)
- [OAI.LeanBlast.SecondKahnKalai.sampling_budget_le](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/TreeCovering.lean#L59)

### skk17 · 把树采样参数接到图参数

类型：衔接推理。上游：skk01、skk06。

**完整结论**

对 skk06 的同一树，取 σ=128q，证明 pTree≤p=min(1,2048·exp(50)·q·(1+log₂ edgeCount H))，且两个参数都在 [0,1]。

**允许的前提**

- q>0；同一树末层容量为正且≤edgeCount H；原题至少一条边。

**验收条件**

保留 2048 的精确常数和末层容量界；不能更换树、放宽为未给定常数或只讨论足够大的边数。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.treeSamplingParameter_mem_unitInterval](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/ThresholdBounds.lean#L80)
- [OAI.LeanBlast.SecondKahnKalai.graphThresholdParameter_mem_unitInterval](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/ThresholdBounds.lean#L71)
- [OAI.LeanBlast.SecondKahnKalai.treeSamplingParameter_le_graphParameter](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/ThresholdBounds.lean#L88)

### skk18 · 覆盖路径真正给出原图阈值界

类型：衔接推理。上游：skk03、skk06、skk15、skk16、skk17。

**完整结论**

把 skk16 的概率先由 pTree 单调提升到 p，再用 skk06 的路径并集与 skk03 的事件等价推出 containmentProbability n p H≥2/3，最终 criticalThreshold n H≤p。

**允许的前提**

- 同一 E,T,m,q,p；树的每条路径都是 E 的轨道副本；skk03、skk15–skk17。

**验收条件**

需关闭从树事件到实际 copyCount>0 的逐样本蕴含，并使用题面 criticalThreshold 下确界。只有抽象树覆盖概率而没有 H 的真实副本不通过。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.secondKahnKalaiBounds](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Main.lean#L25)
- [OAI.LeanBlast.SecondKahnKalai.criticalThreshold_le_of_probability](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Thresholds.lean#L107)

### skk19 · 把边数形式转成顶点数形式

类型：数学结果。上游：无表内上游项。

**完整结论**

对 n≥2、|V(H)|≤n、edgeCount H≥1 和 q≥0，证明 min(1,2048·exp(50)·q·(1+log₂ edgeCount H))≤6144·exp(50)·q·log₂ n。

**允许的前提**

- 原题 n、H 的完整范围；任意 q≥0。

**验收条件**

需从实际简单图边数界推出对数比较，保留精确常数和 n=2 等边界；不能只证明渐近 O(q log n)。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.graph_one_add_logTwo_le_three_logTwo](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/ThresholdBounds.lean#L64)
- [OAI.LeanBlast.SecondKahnKalai.graphThresholdParameter_le_vertexBound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/ThresholdBounds.lean#L104)

### skk20 · 完成题面两个临界阈值上界

类型：汇合结论。上游：skk18、skk19。

**完整结论**

在原题全部范围内，证明 p_c≤min(1,2048·exp(50)·q·(1+log₂|E(H)|)) 且 p_c≤6144·exp(50)·q·log₂n，其中 q 是题面实际子图期望阈值。

**允许的前提**

- 原题有限 H、n≥2、|V(H)|≤n、至少一条边；skk18、skk19。

**验收条件**

交付精确 OAI.LeanBlast.SecondKahnKalai.secondKahnKalaiBounds。两个界和 q 的原始定义都须恢复；同文件的包装定理不额外计分。

**参考声明**

- [OAI.LeanBlast.SecondKahnKalai.secondKahnKalaiBounds](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/GraphThreshold/Main.lean#L25)
