# PartialPermutation：Partial permutation：余类约束到傅里叶范数界

**19 个固定评分项 · 适合**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](PartialPermutation.json)

## 目标与适用性

- 题目 ID：`oai_partial_permutation`。
- 唯一计分根：`OAI.PartialPermutation.complementaryCosets_finite`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/PartialPermutation.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 冻结参考路线后，核心接口有清楚的数学含义：不交支撑子群可交换、低维类型覆盖、余类能量界、对称群倒数维数和的一致上界、最终两种范数界。19 项可按完整陈述核对，等价表示或重标号容易通过明确同构对应。

**需要留意：** 低维核与投影需要使用同一个表示，左/右余类以及傅里叶归一化也必须一致。C(u) 的上确界不能在没有一致有界性证明时直接使用。本表只代表固定参考路线的完成比例，不宣称这些引理出现在每一种证明中。

**下一步：** 可作为首批固定路线题。先按这 19 项标注已有轨迹，检查低维覆盖是否真正作用于最终 Fourier 算子、C(u) 是否对全部 n≥1 有效；之后在同一冻结版本上比较实验。

## 参考证明主线

沿 Main.complementaryCosets_finite 的真实调用链：不交块子群 → 交换子群的小维数核 → 投影覆盖与余类能量 → inverse_degree_sum_transfer；另一支用 Specht 分类与 tableaux 一致界建立 C(u)；最后转回任意有限 X，控制 Hilbert–Schmidt 范数并推出算子范数。设 D=dimℂ V。Main 虽导入 DeficitPlancherel，却没有在配置根证明中调用 deficit_plancherel；该旁支不计分。Fin n 版本 complementaryCosets 也不代替本题任意有限 X 的根目标。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| pp01 | 不交块的置换子群逐元素可交换 | — |
| pp02 | 交换因子产生带乘积维数界的共同核 | pp01 |
| pp03 | 每个共同等型分量选到一个小核 | pp02 |
| pp04 | 把低能量恒等核替换为标准小类型投影 | — |
| pp05 | 标准小类型投影覆盖全部共同分量 | pp03、pp04 |
| pp06 | 计算标准小类型核的精确能量 | — |
| pp07 | 余类帽约束控制卷积核的傅里叶能量 | — |
| pp08 | 转回题面的左余类约束与右侧投影 | pp06、pp07 |
| pp09 | 分量覆盖推出全算子的能量覆盖 | pp05 |
| pp10 | 合成交换子群的小维数转移界 | pp05、pp08、pp09 |
| pp11 | 将截断维数和转成倒数维数和 | — |
| pp12 | 得到完整倒数维数转移公式 | pp10、pp11 |
| pp13 | 块子群的维数和等于对称群的维数和 | — |
| pp14 | 将所有对称群不可约类型接到 tableaux | — |
| pp15 | 证明 tableaux 和对全部阶数一致有界 | — |
| pp16 | 使 C(u) 成为可用的统一常数 | pp14、pp15 |
| pp17 | 合成任意有限 X 的 Hilbert–Schmidt 界 | pp01、pp12、pp13、pp16 |
| pp18 | 算子范数平方由 Hilbert–Schmidt 能量控制 | — |
| pp19 | 完成题面两种范数界 | pp17、pp18 |

### pp01 · 不交块的置换子群逐元素可交换

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限 X 与不交集合 M,N⊆X，证明每个 g∈blockSubgroup M 与 k∈blockSubgroup N 可交换。

**允许的前提**

- 原题块两两不交；blockSubgroup 表示固定块外每一点的置换。

**验收条件**

验收逐元素 Commute，包含支撑边界上的情形；只说明子群集合不交或只证明某两个选定置换可交换不通过。

**参考声明**

- [OAI.PartialPermutation.blockSubgroup_commute](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/BlockSubgroups.lean#L19)

### pp02 · 交换因子产生带乘积维数界的共同核

类型：数学结果。上游：pp01。

**完整结论**

在由互相可交换子群 H_i 生成的有限群的非零等型酉模上，构造正整数 d_i 与核 k_i：∏d_i≤模维数，Σ|k_i|²=d_i²/|H_i|，核满足逆元共轭对称，并对整个模作用为恒等。

**允许的前提**

- isotypic_joint_kernels 中有限群、非零有限维等型酉模、子群生成性和逐元素可交换性；主问题的可交换性由 pp01 提供。

**验收条件**

同一组 d_i,k_i 必须满足维数乘积、能量、共轭对称及恒等作用；分别找到小维数类型和不相关的恒等核不通过。

**参考声明**

- [OAI.PartialPermutation.isotypic_joint_kernels](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/JointKernels.lean#L27)

### pp03 · 每个共同等型分量选到一个小核

类型：衔接推理。上游：pp02。

**完整结论**

对 J=⨆H_i 上任一等型分量 c，选择某个 i 和核 k:H_i→ℂ，其维数参数 d≤D^(1/b)，能量 d²/|H_i|，逆元共轭对称，且 Fourier(k) 在 c 上恒等。

**允许的前提**

- b>0、D>0、酉表示、交换子群及任意 J 等型分量；pp02。

**验收条件**

i,d,k 与分量 c 绑定；需证明根号型维数界并把 J 内的子群核正确搬回 H_i，不能让每个向量使用不同 i。

**参考声明**

- [OAI.PartialPermutation.component_kernel](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/JointKernels.lean#L80)

### pp04 · 把低能量恒等核替换为标准小类型投影

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限群酉表示，若核 k 的能量为 d²/|G|、Fourier(k)=1 且 d≤R，则 Fourier(smallTypeKernel G R)=1。

**允许的前提**

- 源码任意有限群酉表示、d≤R、核能量等式及恒等作用，作为明确条件输入。

**验收条件**

需推出标准 smallTypeKernel 在整个表示上恒等；不能只保留原来依赖分量的 k，也不能只验证一个向量。

**参考声明**

- [OAI.PartialPermutation.smallTypeKernel_identity_of_kernel](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/SmallKernels.lean#L77)
- [OAI.PartialPermutation.complexFourier_smallTypeKernel](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/SmallKernels.lean#L29)

### pp05 · 标准小类型投影覆盖全部共同分量

类型：衔接推理。上游：pp03、pp04。

**完整结论**

取 R=D^(1/b)、P_i=Fourier(ρ|H_i,smallTypeKernel H_i R)，证明每个 J 等型分量都存在一个 i，使 P_i 在整个分量上恒等。

**允许的前提**

- pp03 的分量核与 pp04 的替换定理；同一个 ρ、H_i、D,b。

**验收条件**

需获得对所有分量的统一标准投影族 P_i；存在很多分别有效但不能组成该投影族的核不通过。

**参考声明**

- [OAI.PartialPermutation.joint_small_type_cover](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/DegreeTransfer.lean#L24)

### pp06 · 计算标准小类型核的精确能量

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限群 G 和 R，证明 |G|·Σ_g|smallTypeKernel G R(g)|²=smallDegreeSum G R，其中右端是所有不可约维数≤R 的维数平方之和。

**允许的前提**

- 任意有限群 G、实阈值 R；源码不可约表示、smallTypeKernel、smallDegreeSum 与 Fourier 的定义。Plancherel 等未在固定 Mathlib 提供的辅助事实，仍需有完整证明依赖。

**验收条件**

需精确识别频域的 0/1 作用并得到完整等式；遗漏维数权重或改变 Fourier 归一化不通过。

**参考声明**

- [OAI.PartialPermutation.smallTypeKernel_energy](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ProjectionCovers.lean#L22)
- [OAI.PartialPermutation.complexFourier_smallTypeKernel](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/SmallKernels.lean#L29)

### pp07 · 余类帽约束控制卷积核的傅里叶能量

类型：数学结果。上游：无表内上游项。

**完整结论**

对不可约酉 ρ、子群 H、核 k 和非负 f，在 RightCosetCap f H B 下证明 D·hsNormSq(Fourier_H(k)·Fourier_ρ(f))≤B·mass(f)·|H|·Σ|k|²。

**允许的前提**

- ProjectionCovers.kernel_hs_energy 的有限群、不可约酉表示、非负 f、右余类约束和任意 k。

**验收条件**

需把余类 L² 界和 Fourier Bessel 界接起来，保留子群指数与群大小的正确归一化；不能把结论作为新的能量假设。

**参考声明**

- [OAI.PartialPermutation.kernel_hs_energy](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ProjectionCovers.lean#L31)

### pp08 · 转回题面的左余类约束与右侧投影

类型：衔接推理。上游：pp06、pp07。

**完整结论**

在 LeftCosetCap f H B 下，证明 D·hsNormSq(Fourier_ρ(f)·P_H)≤B·mass(f)·smallDegreeSum H R，其中 P_H=Fourier(ρ|H,smallTypeKernel H R)。

**允许的前提**

- 非负 f、左余类约束、不可约酉表示；pp06、pp07；同一标准小类型核。

**验收条件**

需通过 f(g⁻¹)、伴随和核自伴性正确交换左右位置；只证明右余类版本不满足本项。

**参考声明**

- [OAI.PartialPermutation.small_type_hs_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ProjectionCovers.lean#L49)

### pp09 · 分量覆盖推出全算子的能量覆盖

类型：数学结果。上游：pp05。

**完整结论**

若一族自伴 P_i 对每个等型分量至少有一个恒等作用，则对任意算子 A 证明 hsNormSq A≤Σ_i hsNormSq(A·P_i)。

**允许的前提**

- 同一酉表示的等型分解；P_i 自伴；pp05 形式的分量覆盖输入。

**验收条件**

先验收覆盖对任意向量/算子的全局不等式。只说每个分量被某投影覆盖，而未控制 A 的总能量，不通过。

**参考声明**

- [OAI.PartialPermutation.component_projection_cover_norm](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ProjectionCovers.lean#L79)
- [OAI.PartialPermutation.component_projection_cover_hs](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ProjectionCovers.lean#L101)

### pp10 · 合成交换子群的小维数转移界

类型：衔接推理。上游：pp05、pp08、pp09。

**完整结论**

对任意不可约酉 ρ、b>0 个逐元素可交换子群和满足全部左余类帽的非负 f，证明 D·hsNormSq(Fourier_ρ(f))≤B·mass(f)·Σ_i smallDegreeSum H_i D^(1/b)。

**允许的前提**

- pp05 的标准覆盖族及其自伴性；pp08 的每子群能量界；pp09 的全算子覆盖。

**验收条件**

必须让同一投影族同时满足覆盖和能量约束，并把全体分量合并到同一 Fourier(f)。分别正确的局部投影界不自动通过。

**参考声明**

- [OAI.PartialPermutation.small_degree_sum_transfer](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/DegreeTransfer.lean#L51)

### pp11 · 将截断维数和转成倒数维数和

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限群 G、u>0、R>0，证明 smallDegreeSum G R≤R^(u+2)·inverseDegreeSum G u。

**允许的前提**

- 不可约维数为正；u>0、R>0；两种维数和的源码定义。

**验收条件**

需对全部不可约类型求和并保留 u+2 次幂；只给一个类型或一个阈值实例不通过。

**参考声明**

- [OAI.PartialPermutation.smallDegreeSum_le_inverseDegreeSum](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ReciprocalTransfer.lean#L24)

### pp12 · 得到完整倒数维数转移公式

类型：衔接推理。上游：pp10、pp11。

**完整结论**

由上述结果证明 hsNormSq(Fourier_ρ(f))≤B·mass(f)·D^(−1+(u+2)/b)·Σ_i inverseDegreeSum H_i u。

**允许的前提**

- pp10 的全部原始条件；u>0；pp11。

**验收条件**

需导出 D>0、B≥0 并合法消去 D，给出精确指数；不能新增 B≥0 或把 mass(f)≤1 提前用于这个一般转移定理。

**参考声明**

- [OAI.PartialPermutation.inverse_degree_sum_transfer](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ReciprocalTransfer.lean#L49)

### pp13 · 块子群的维数和等于对称群的维数和

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限 X 和任意块 M，构造 blockSubgroup M≃*Sym(Fin|M|)，证明 inverseDegreeSum 相等，并对全部块求和得到对应的 symmetricInverseDegreeSum 之和。

**允许的前提**

- 有限 X、任意块及源码不可约维数和定义；群同构下维数和不变的使用必须有完整证明依赖。

**验收条件**

不能仅比较群阶；需转移不可约维数和并使用每个块自己的 |M_i|，覆盖任意有限 X。

**参考声明**

- [OAI.PartialPermutation.blockSubgroupSnEquiv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/SymmetricTransfer.lean#L27)
- [OAI.PartialPermutation.inverseDegreeSum_block](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/SymmetricTransfer.lean#L31)
- [OAI.PartialPermutation.inverseDegreeSum_block_sum](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/SymmetricTransfer.lean#L57)

### pp14 · 将所有对称群不可约类型接到 tableaux

类型：数学结果。上游：无表内上游项。

**完整结论**

对每个 n 建立 Shape n 与 Sym(n) 不可约类型的双射及 standardCount≤对应不可约维数，因而对每个 u>0 有 symmetricInverseDegreeSum n u≤TableauZeta.fullSum n u。

**允许的前提**

- 源码 Young diagram、Specht 表示、Tableau.standardCount 与不可约类型定义；n 任意、u>0。

**验收条件**

需要覆盖全部不可约类型，不能只构造一族 Specht 表示；负幂不等式方向必须正确。

**参考声明**

- [OAI.PartialPermutation.SpechtActual.index_bijective](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/SpechtClassification.lean#L62)
- [OAI.PartialPermutation.SpechtActual.standardCount_le_degree](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/SpechtClassification.lean#L71)
- [OAI.PartialPermutation.symmetricInverseDegreeSum_le_tableaux](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ReciprocalBounds.lean#L12)

### pp15 · 证明 tableaux 和对全部阶数一致有界

类型：数学结果。上游：无表内上游项。

**完整结论**

对每个 u>0，证明 nontrivialSum n u 随 n→∞ 趋于 0，再结合零亏损部分的统一界，证明 {fullSum n u:n∈ℕ} 有上界。

**允许的前提**

- TableauLimits 中 deficitTerm、nontrivialSum、fullSum 定义；u>0。可求和主控项与逐项极限属于本项证明所需内容，不能作为免费假设。

**验收条件**

需证明可求和主控及逐项极限足以控制整个和，得到对所有 n 的统一上界；每个固定 n 有限或有限多项的数值界均不通过。

**参考声明**

- [OAI.PartialPermutation.TableauZeta.nontrivialSum_tendsto_zero](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/TableauLimits.lean#L65)
- [OAI.PartialPermutation.TableauZeta.fullSum_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/TableauLimits.lean#L72)
- [OAI.PartialPermutation.TableauZeta.fullSum_bddAbove](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/TableauLimits.lean#L97)

### pp16 · 使 C(u) 成为可用的统一常数

类型：衔接推理。上游：pp14、pp15。

**完整结论**

证明 {symmetricInverseDegreeSum n u:n≥1} 有上界，因此题面定义的 C(u)=sSup 该集合满足每个 n≥1 的 symmetricInverseDegreeSum n u≤C(u)。

**允许的前提**

- u>0；pp14 的逐阶比较；pp15 的统一上界。

**验收条件**

需先证明 BddAbove 再使用上确界性质；把 C(u) 的定义本身当作自动提供所有上界不通过。

**参考声明**

- [OAI.PartialPermutation.symmetricReciprocalDegreeBounded](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ReciprocalBounds.lean#L24)
- [OAI.PartialPermutation.symmetricInverseDegreeSum_le_constant](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/ReciprocalBounds.lean#L31)

### pp17 · 合成任意有限 X 的 Hilbert–Schmidt 界

类型：衔接推理。上游：pp01、pp12、pp13、pp16。

**完整结论**

在原题全部条件下证明 hsNormSq(Fourier_ρ(f))≤b·B·C(u)·D^(−1+(u+2)/b)。

**允许的前提**

- 原题有限 X、b>0、非空且两两不交覆盖 X 的块、不可约酉 ρ、非负 f、mass(f)≤1、u>0 和全部左余类帽；pp01、pp12、pp13、pp16。

**验收条件**

需将同一 blockSubgroup 族送入一般转移式，使用各块非空性控制其阶数，并完成 Σ_i≤bC(u) 和 mass(f)≤1 的组合。只有 Fin n 版本或新增 B≥0 假设不通过。

**参考声明**

- [OAI.PartialPermutation.complementaryCosets_finite](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/Main.lean#L11)

### pp18 · 算子范数平方由 Hilbert–Schmidt 能量控制

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限维复 Hilbert 空间上的线性算子 A，证明 ‖A‖op²≤hsNormSq A。

**允许的前提**

- 题面的有限维复 Hilbert 结构；同一定义的 hsNormSq 和连续算子范数。

**验收条件**

对所有 A 证明，包含退化维数情形；不得只对本题特定一组向量估计，或混用归一化 trace。

**参考声明**

- [OAI.PartialPermutation.norm_apply_sq_le_hsNormSq](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/OperatorNorm.lean#L11)
- [OAI.PartialPermutation.opNorm_sq_le_hsNormSq](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/OperatorNorm.lean#L25)

### pp19 · 完成题面两种范数界

类型：汇合结论。上游：pp17、pp18。

**完整结论**

对原题任意有限 X，交付 Hilbert–Schmidt 范数平方和算子范数平方均不超过 b·B·C(u)·D^(−1+(u+2)/b) 的合取。

**允许的前提**

- 原题全部假设；pp17、pp18，使用同一个 Fourier_ρ(f)。

**验收条件**

交付精确 OAI.PartialPermutation.complementaryCosets_finite；两个不等式都需要，且恢复全部量词和题面 C(u)。

**参考声明**

- [OAI.PartialPermutation.complementaryCosets_finite](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/RepresentationTheory/PartialPermutation/Main.lean#L11)
