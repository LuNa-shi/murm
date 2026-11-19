# ShortEgyptianFractions：短埃及分数展开

**21 个固定评分项 · 适合**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](ShortEgyptianFractions.json)

## 目标与适用性

- 题目 ID：`oai_short_egyptian_fractions`。
- 唯一计分根：`OAI.ShortEgyptian.main`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/ShortEgyptianFractions.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 存在性、分母下界和统一上界的汇合清楚；已把共同分母、高层分布、联合随机选择与 ResidueSystem 拼接分成四项，得到 21 个可分别验收的义务，适合固定参考路线评分。

**需要留意：** 它与 EgyptianFractions 使用同类的余数供给与密度下降思路，数学内容高度重合；本版本使用 List、ListScale、FourierBad 和素数区间 [S^100,2S^100]，另一个版本用 Fin 元组、原始密度结构和不同的常数。不能直接复制源声明或数值条件，也不能把两题视为独立领域样本。

**下一步：** 可按本版 21 项试评分；重点核对 SE06–SE09 的同一分母和联合样本见证。如果要避免同一数学任务重复计入总分，和 EgyptianFractions 二选一。

## 参考证明主线

先建立展开和最小长度的语义。下界给 (b−1)/b 的展开补上 1/b，转为和为 1 的分母上界。上界构造共同分母的余数系统，利用终端展开和坏集递推得到稠密的短展开，再把贪心余项拆成两个好分子，最后去重并取分子最大值。以下 21 项是这条固定路线的证明义务，不按有限分母或参数范围给分。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| SE01 | 展开存在且最短长度可取得 | — |
| SE02 | 和为 1 时每个分母的统一上界 | — |
| SE03 | 最坏分子的双对数下界 | SE01、SE02 |
| SE04 | 重复分母清理不损失长度预算 | — |
| SE05 | 一次余数下降能够反向补成展开 | — |
| SE06 | 确定性和全部随机列表共用有界分母 | — |
| SE07 | 高层确定性列表的 Fourier 坏集足够小 | — |
| SE08 | 同一组随机列表覆盖所有中层和终端 | — |
| SE09 | 构造覆盖所有下降层的共同余数系统 | SE06、SE07、SE08 |
| SE10 | 终端层的短展开预算 | SE05、SE09 |
| SE11 | 证明失败必须传到下一层 | SE05、SE10 |
| SE12 | 坏集密度的一步递推 | SE09、SE11 |
| SE13 | 把递推收敛为统一的八分之一坏集界 | SE10、SE11、SE12 |
| SE14 | 获得大部分分子的短展开 | SE09、SE10、SE13 |
| SE15 | 贪心一步同时减少分子和平方压缩余项 | — |
| SE16 | 在对数步数内把余项分母送入目标区间 | SE15 |
| SE17 | 稠密集合中的两个好分子能覆盖中间区间 | — |
| SE18 | 把任意小分子余项拼为短展开 | SE14、SE17 |
| SE19 | 拼接并去重，得到任意分数的尺度上界 | SE04、SE16、SE18 |
| SE20 | 统一到自然数分母并取最坏分子 | SE01、SE14、SE19 |
| SE21 | 闭合题面要求的存在性与双边阶 | SE01、SE03、SE20 |

### SE01 · 展开存在且最短长度可取得

类型：数学结果。上游：无表内上游项。

**完整结论**

对所有自然数 a<b，存在严格递增、各分母至少为 2、单位分数之和为 a/b 的有限表 ns；并存在这样的 ns 使 |ns|=minLength(a,b)。任何合法展开的长度都不小于 minLength(a,b)。

**允许的前提**

- a,b∈ℕ，a<b；题面 IsExpansion 与 minLength 的定义。

**验收条件**

同时交付存在性和 sInf 确为可取得的最小值。只给任意展开或直接把 sInf 当作最小值，不能通过。

**参考声明**

- [OAI.ShortEgyptian.exists_expansion](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/GreedyExistence.lean#L7)
- [OAI.ShortEgyptian.minLength_attained](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/GreedyExistence.lean#L63)
- [OAI.ShortEgyptian.minLength_le](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/GreedyExistence.lean#L70)

### SE02 · 和为 1 时每个分母的统一上界

类型：数学结果。上游：无表内上游项。

**完整结论**

任意正整数表 ns，若 ∑(1/n)=1，则每个 n∈ns 满足 n≤|ns|^(2^(|ns|−1))；不要求原表有序或分母互异。

**允许的前提**

- ns 的分母均为正；unitSum ns=1。

**验收条件**

证明对任意长度成立的递归分母界，保留重复分母情形；有限枚举不通过。

**参考声明**

- [OAI.ShortEgyptian.denominator_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/LowerBound.lean#L80)
- [OAI.ShortEgyptian.denominator_bound_aux](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/LowerBound.lean#L18)

### SE03 · 最坏分子的双对数下界

类型：衔接推理。上游：SE01、SE02。

**完整结论**

对每个 b≥2，任意 (b−1)/b 的合法 k 项展开满足 b≤(k+1)^(2^k)，进而 log(log b)≤2k；结合最短展开与最大值，得到 (1/2)log(log b)≤maxMinLength(b)。

**允许的前提**

- b≥2；SE01 的最短展开语义；SE02 的和为 1 分母界。

**验收条件**

补上 1/b 后仍须满足 SE02 的正分母条件；最终下界必须落到 maxMinLength，不能只留下某个未关联的展开长度界。

**参考声明**

- [OAI.ShortEgyptian.hard_numerator_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/LowerBound.lean#L97)
- [OAI.ShortEgyptian.loglog_le_twice_length](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/LowerBound.lean#L127)
- [OAI.ShortEgyptian.main_lower](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/LowerBound.lean#L154)

### SE04 · 重复分母清理不损失长度预算

类型：数学结果。上游：无表内上游项。

**完整结论**

对 0<a<b 和任意正整数表 ns，若 unitSum(ns)=a/b，则存在合法 IsExpansion(a,b,xs)，且 |xs|=|ns|。

**允许的前提**

- 0<a<b；ns 中分母为正；unitSum(ns)=a/b。

**验收条件**

交付严格递增、分母≥2、和不变、长度不增加的同一输出表；参考接口给出长度相等。单独排序或仅删除重复项不通过。

**参考声明**

- [OAI.ShortEgyptian.remove_repetitions](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/Distinctness.lean#L63)

### SE05 · 一次余数下降能够反向补成展开

类型：衔接推理。上游：无表内上游项。

**完整结论**

对正 M,Q,Q′,u,t，Q′∣Q、t∣M、u<M Q，令 v=residue(Q t,u,quotient(Q t,u))。若 v/(M Q′) 有至多 k 项 IsUnitSum 展开，则 u/(M Q) 有至多 k+1 项 IsUnitSum 展开。

**允许的前提**

- 上述整除、正性和分数小于 1 条件；输入余数展开是显式条件。

**验收条件**

构造同一余数的提升，保留所有分母≥2 和长度增加至多 1。只证明数值恒等式不通过。

**参考声明**

- [OAI.ShortEgyptian.residue_lift](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/TerminalExpansion.lean#L51)

### SE06 · 确定性和全部随机列表共用有界分母

类型：衔接推理。上游：无表内上游项。

**完整结论**

在 ListScale(S) 下，给定 scaleM(S) 个素数 p₀,j∈[S^100,2S^100]、取值为正素数且≤2S^100 的 p，以及任意 1000 组样本 f，构造 M=auxiliaryDenominator(binaryExponent(S),p₀,p,f)。同一 M 满足 exp S<M≤exp(dimM·S)、2^binaryExponent(S)∣M；每个确定性子集乘积和每组随机乘积都为正、整除 M，并≤exp(101S)。

**允许的前提**

- ListScale(S)；上述 p₀、p 的范围与素性；f 任意，不能在结论中重新选择各列表的分母。

**验收条件**

用一个乘积式 M 同时证明二进制整除、全部候选整除、大小上下界；分别对每张列表找分母不通过。

**参考声明**

- [OAI.ShortEgyptian.auxiliary_lower](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ResidueAssembly.lean#L94)
- [OAI.ShortEgyptian.auxiliary_upper](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ResidueAssembly.lean#L63)
- [OAI.ShortEgyptian.two_pow_dvd_auxiliary](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ListConstruction.lean#L53)
- [OAI.ShortEgyptian.deterministic_dvd_auxiliary](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ListConstruction.lean#L58)
- [OAI.ShortEgyptian.sample_dvd_auxiliary](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ListConstruction.lean#L67)
- [OAI.ShortEgyptian.deterministicProduct_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ListConstruction.lean#L100)
- [OAI.ShortEgyptian.sampleProduct_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ListConstruction.lean#L117)

### SE07 · 高层确定性列表的 Fourier 坏集足够小

类型：数学结果。上游：无表内上游项。

**完整结论**

在 ListScale(S) 下，给定 scaleM(S) 个互异素数 p_j≤2S^100。统一对 exp S≤X≤exp(dimX·S) 和 exp(dimC·S)≤C≤exp(2dimC·S)，证明 badLevel(deterministicProduct(p),C,X,scaleRho(S)) 的基数≤X exp(−scaleM(S)/1000)。

**允许的前提**

- ListScale(S)；p 的素性、单射性、数量和上界；上述完整 X,C 区间。

**验收条件**

交付全 X,C 的坏集界及其 Fourier 矩估计依据；只证明某个模数的平均或某个样本的好表现不通过。

**参考声明**

- [OAI.ShortEgyptian.high_badLevel](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ResidueAssembly.lean#L14)

### SE08 · 同一组随机列表覆盖所有中层和终端

类型：数学结果。上游：无表内上游项。

**完整结论**

在 ListScale(S) 下，对任意有限非空素数池 p:A→ℕ，若 p 单射、p(a)≤2S^100、|A|≥S^99，则存在同一个 f:Fin 1000→(Fin(scaleM(S))×Bool)→A。其 f₀ 对所有 j<depth(S)、level(S,j)≤exp S 的 badLevel 均有基数≤level(S,j)exp(−scaleM(S)/1000)；每个 S^100000<u≤exp(scaleM(S))，还有某个 f_i 在该 u、收缩率 exp(−log u/10000) 下非 FourierBad。

**允许的前提**

- ListScale(S) 的全部数值界；上述素数池条件；固定 level、depth 与 FourierBad 定义。

**验收条件**

所有层和所有终端 u 共用一组 f。需完成联合选择的总失败概率界，而非逐层分别找成功样本；终端 Fourier 好性将在 SE09 转成实际余数收缩。

**参考声明**

- [OAI.ShortEgyptian.choose_random_lists](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/LevelSelection.lean#L101)
- [OAI.ShortEgyptian.exists_residueSystem](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ResidueSystem.lean#L137)

### SE09 · 构造覆盖所有下降层的共同余数系统

类型：数学结果。上游：SE06、SE07、SE08。

**完整结论**

对任意满足 ListScale(S) 的 S 和 exp(dimC·S)≤C≤exp(2·dimC·S)，构造同一个 ResidueSystem(S,C)：exp S<M≤exp(dimM·S)，2^binaryExponent(S)∣M；各层候选 t 均为正且整除 M；每层坏集至多 level(S,j)exp(−scaleM(S)/1000)；坏集外至少 scaleRho(S)·2^scaleM(S)/2 个候选把余数降至下一层；每个 S^100000<u≤exp(scaleM(S)) 还有正因子 t∣M 使余数≤u^(9999/10000)。

**允许的前提**

- ListScale(S) 的完整数值条件；C 的上述统一区间；固定源码的尺度和余数定义。

**验收条件**

全部字段使用同一个 M 与同一组候选。把 SE06 的共同分母、SE07 的高层界、SE08 的联合样本接起来，并从 Fourier 好性得到实际小余数；不能分别选择彼此不兼容的 M，不能假设结构已经存在。

**参考声明**

- [OAI.ShortEgyptian.exists_residueSystem](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ResidueSystem.lean#L137)
- [OAI.ShortEgyptian.assemble_residueSystem](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ResidueSystem.lean#L48)
- [OAI.ShortEgyptian.high_badLevel](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/ResidueAssembly.lean#L14)
- [OAI.ShortEgyptian.choose_random_lists](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/LevelSelection.lean#L101)

### SE10 · 终端层的短展开预算

类型：衔接推理。上游：SE05、SE09。

**完整结论**

给定 ListScale(S) 和 R:ResidueSystem(S,C)，对所有自然数 u≤exp(scaleM(S))，u/R.M 有 IsUnitSum 展开，长度≤terminalLength(S)；在 log S≥1 时，该长度≤terminalConstant·log S。

**允许的前提**

- 给定完整的 ResidueSystem；ListScale(S)；u 的上述上界。

**验收条件**

把余数收缩迭代和最终二进制展开真正接起来，提供对所有 u 的共同长度预算。只证明余数变小或二进制特例不通过。

**参考声明**

- [OAI.ShortEgyptian.residueSystem_terminal](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/TerminalScale.lean#L90)
- [OAI.ShortEgyptian.terminalLength_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/TerminalScale.lean#L24)
- [OAI.ShortEgyptian.binary_unitSum](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/TerminalExpansion.lean#L25)

### SE11 · 证明失败必须传到下一层

类型：衔接推理。上游：SE05、SE10。

**完整结论**

以 levelBad(S,M,C,K,j) 表示在第 j 层预算 K+depth(S)−j 下不能展开的分子：若坏分子 u 已在下一层范围内，则 u 仍在下一层坏集；若一个候选 t∣M 把 u 的余数 v 降到下一层，则 v 也在下一层坏集。对 K=terminalLength(S)、M=R.M，终端坏集为空。

**允许的前提**

- M,C>0；j<depth(S)；相应层分数 u/(M·levelMultiplier) 小于 1；完整 ResidueSystem。

**验收条件**

证明两种传递情况和终端为空，并保持预算随层数的变化。只给坏集大小的猜测不通过。

**参考声明**

- [OAI.ShortEgyptian.levelBad_inherit](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DescentSets.lean#L93)
- [OAI.ShortEgyptian.levelBad_residue](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DescentSets.lean#L104)
- [OAI.ShortEgyptian.levelBad_terminal](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DescentSets.lean#L81)

### SE12 · 坏集密度的一步递推

类型：衔接推理。上游：SE09、SE11。

**完整结论**

在 ListScale(S)、MomentScale(S)、2≤S^(1/4) 和 SE09 的 C 区间内，对任意 R:ResidueSystem(S,C)、j<depth(S)，证明 levelDensity(j)≤exp(−scaleM(S)/1000)+exp(2S^(1/4))·levelDensity(j+1)^descentAlpha。

**允许的前提**

- 给定完整 ResidueSystem；ListScale 与 MomentScale 的完整数值条件；SE11 的坏集继承结论。

**验收条件**

把好余数计数、同一前驱的除数计数与矩估计连接为这个带常数的一步界；不能假定所需坏集递推本身成立。

**参考声明**

- [OAI.ShortEgyptian.density_recurrence](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DensityBounds.lean#L12)
- [OAI.ShortEgyptian.residue_double_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DoubleCount.lean#L14)

### SE13 · 把递推收敛为统一的八分之一坏集界

类型：衔接推理。上游：SE10、SE11、SE12。

**完整结论**

由 SE12 和终端密度为 0，证明初始密度≤depth(S)·exp(2·descentR·S^(1/4)−scaleM(S)·S^(−1/4)/1000)；并证明这个表达式对所有充分大的 S 不超过 1/8。

**允许的前提**

- SE12 递推；终端为 0；参考固定尺度定义。

**验收条件**

同时交付完整递推展开及 eventually 的共同阈值。只验证若干 S 或只说指数衰减不通过。

**参考声明**

- [OAI.ShortEgyptian.density_unrolled](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DensityBounds.lean#L52)
- [OAI.ShortEgyptian.eventually_density_numeric](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DensityBounds.lean#L73)
- [OAI.ShortEgyptian.backwards_recurrence_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/RecurrenceUnrolling.lean#L17)

### SE14 · 获得大部分分子的短展开

类型：衔接推理。上游：SE09、SE10、SE13。

**完整结论**

对所有充分大的 S，统一对 exp(dimC·S)≤C≤exp(2·dimC·S) 构造 DenseData(S,C)：exp S<M≤exp(dimM·S)；G⊆[1,⌊exp(dimX·S)⌋]，缺口数≤exp(dimX·S)/8；每个 u∈G 的 u/(M C) 都有长度≤densityConstant·log S 的 IsUnitSum 展开。

**允许的前提**

- SE09–SE13 的完整接口；固定尺度定义。

**验收条件**

给出同一 G、M 和对所有 u∈G 的展开；同时消除 ListScale、MomentScale 等临时条件，证明它们对充分大的 S 统一成立。仅有稠密计数而无展开证据不通过。

**参考声明**

- [OAI.ShortEgyptian.density_from_residueSystem](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/Density.lean#L29)
- [OAI.ShortEgyptian.eventually_density](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/Density.lean#L74)

### SE15 · 贪心一步同时减少分子和平方压缩余项

类型：数学结果。上游：无表内上游项。

**完整结论**

对 0<A<C，令 z=quotient(C,A)、r=residue(C,A,z)。证明 2≤z≤C、r<A、A/C=1/z+r/(Cz)，以及 r/(Cz)≤(A/C)^2 和 r/(Cz)≤1/2。

**允许的前提**

- A,C 为自然数且 0<A<C；参考 quotient、residue 定义。

**验收条件**

所有不等式和等式必须对应同一 z,r；这一步是后续统一长度预算的依据。

**参考声明**

- [OAI.ShortEgyptian.greedy_step](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/GreedyPreparation.lean#L9)

### SE16 · 在对数步数内把余项分母送入目标区间

类型：衔接推理。上游：SE15。

**完整结论**

对 0<a<b<T、T>1、T≤exp(2^k log 2)，构造 ns,A,C，使各 n∈ns 满足 n≥2、|ns|≤k+1、A≤a、A<C、a/b=unitSum(ns)+A/C，且 A=0 或 T≤C<T²。对 T=exp(dimC·S)、k=greedySteps(S)，还须有 |ns|≤greedyConstant·log S（S≥1，log S≥1）。

**允许的前提**

- 贪心一步接口；上述 T,k,S 条件。

**验收条件**

保留终止分支 A=0 和分母越过 T 后的上界 T²，并交付同一个输出余项；只有余项变小而没有进入统一供给区间不通过。

**参考声明**

- [OAI.ShortEgyptian.prepare_denominator](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/GreedyPreparation.lean#L130)
- [OAI.ShortEgyptian.greedy_power_cap](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/GreedyPreparation.lean#L162)
- [OAI.ShortEgyptian.greedy_length_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/GreedyPreparation.lean#L173)

### SE17 · 稠密集合中的两个好分子能覆盖中间区间

类型：数学结果。上游：无表内上游项。

**完整结论**

对 X>4 和任意 G⊆ℕ，若 [1,⌊X⌋] 中缺失于 G 的数至多 X/8，则每个自然数 n∈[X/2,X] 都能写成 n=u+v，u,v∈G。

**允许的前提**

- X>4；上述坏集基数界；X/2≤n≤X。

**验收条件**

证明覆盖所有目标 n 的组合计数结论；仅证明存在某一可分解 n 不通过。

**参考声明**

- [OAI.ShortEgyptian.dense_split](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DenseSplit.lean#L37)

### SE18 · 把任意小分子余项拼为短展开

类型：衔接推理。上游：SE14、SE17。

**完整结论**

给定 S>0、4<exp(dimX·S)、C>0、D:DenseData(S,C)、0<A≤exp S，构造 A/C 的 IsUnitSum 展开，长度≤2·densityConstant·log S。

**允许的前提**

- 完整 DenseData；A,C,S 的上述条件。

**验收条件**

选 g 使 g·A·D.M 落在稠密拆分区间，两个好分子的展开拼接后按同一个 g 缩放，确实得到 A/C。不能只证明 G 内的分子。

**参考声明**

- [OAI.ShortEgyptian.dense_remainder](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/UpperAssembly.lean#L12)
- [OAI.ShortEgyptian.floor_multiple](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DenseSplit.lean#L50)
- [OAI.ShortEgyptian.isUnitSum_scale](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/DenseSplit.lean#L74)

### SE19 · 拼接并去重，得到任意分数的尺度上界

类型：衔接推理。上游：SE04、SE16、SE18。

**完整结论**

对 S≥2、log S≥1，假设每个 C∈[exp(dimC·S),exp(2·dimC·S)] 都有 DenseData(S,C)。则对所有 0<a<b=exp S，存在合法严格递增展开，长度≤upperConstant·log S，其中 upperConstant=greedyConstant+2·densityConstant>0。

**允许的前提**

- 同一 S 下所有 C 的 DenseData 供给；S,a,b 的上述条件。

**验收条件**

处理零余项和非零余项，匹配贪心分母区间与密度供给区间，拼接后执行 SE04。只给允许重复分母的和不通过。

**参考声明**

- [OAI.ShortEgyptian.upper_at_scale](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/UpperAssembly.lean#L58)
- [OAI.ShortEgyptian.upperConstant_pos](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/UpperAssembly.lean#L54)

### SE20 · 统一到自然数分母并取最坏分子

类型：衔接推理。上游：SE01、SE14、SE19。

**完整结论**

存在一个 b₀≥2，对所有 b≥b₀、1≤a<b，均有长度≤upperConstant·log(log b) 的合法展开；因此同一阈值下 maxMinLength(b)≤upperConstant·log(log b)。

**允许的前提**

- SE14 的共同 eventually 阈值；SE19 的统一尺度结论；SE01 的最小值语义。

**验收条件**

阈值和常数必须独立于 a,b。说明 S=log b 的代入及有限最大值为何仍受同一界控制。

**参考声明**

- [OAI.ShortEgyptian.eventually_upper_at_scale](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/Main.lean#L11)
- [OAI.ShortEgyptian.main_upper_expansions](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/Main.lean#L18)
- [OAI.ShortEgyptian.main](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/Main.lean#L33)

### SE21 · 闭合题面要求的存在性与双边阶

类型：汇合结论。上游：SE01、SE03、SE20。

**完整结论**

证明 OAI.ShortEgyptian.main 的完整合取：所有 1≤a<b 都有合法展开；存在 c₁,c₂>0 和 b₀≥2，对所有 b≥b₀，同时有 c₁log(log b)≤maxMinLength(b)≤c₂log(log b)。参考取 c₁=1/2、c₂=upperConstant。

**允许的前提**

- 原题定义；前述已冻结的存在性、统一下界与统一上界接口。

**验收条件**

最终结论逐项对齐 configured root，使用同一阈值和两个正的固定常数；不遗留余数供给、稠密性或展开存在的假设。

**参考声明**

- [OAI.ShortEgyptian.main](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/ShortEgyptian/Main.lean#L33)
