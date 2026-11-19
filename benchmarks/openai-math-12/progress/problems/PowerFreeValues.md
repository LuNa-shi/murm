# PowerFreeValues：不可约多项式的高次幂自由值密度

**19 个固定评分项 · 需进一步确认**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](PowerFreeValues.json)

## 目标与适用性

- 题目 ID：`oai_power_free_values`。
- 唯一计分根：`OAI.QuarticPowerFree.allDegrees`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/PowerFreeValues.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 参考证明的主因果链清楚：局部根数和有限筛法把目标归约到大素数尾项；数域分解与代数点计数控制尾项。已能列出 19 项精确接口。

**需要留意：** allDegrees 的证明包含直接曲面计数、一般范数盒计数和四次径向纤维三套相当不同的技术；PF10、PF12、PF16 内仍包着大的代数几何计数核心。当前等权分数对这些核心和接口拼接给相同一票，是否会让实验主要靠外围接口涨分需要实证核对。

**下一步：** 先做本路线试评分，重点审查 PF10、PF12、PF16 的可独立验收粒度。若出现外围项目高分而三个计数核心均未触及，再按真实计数定理的依赖拆分并冻结新版本；不要事后改本版本分母。

## 参考证明主线

目标始终是所有次数 d≥4 的 k=d−2 次幂自由值密度。d=4、5≤d≤8、d≥9 是参考证明覆盖全部量词的三个技术分支，每项要求整个分支的统一定理，不奖励单个多项式、有限测试或逐个次数。共同筛法部分和同一算术见证的几何转换各自验收，最后回到原多项式与原 Euler 乘积。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| PF01 | 把原多项式正规化而保留次数与不可约性 | — |
| PF02 | 良素数的幂模根数有次数界 | — |
| PF03 | Euler 乘积收敛且严格为正 | PF02 |
| PF04 | 有限素数筛的精确主项和周期误差 | — |
| PF05 | 控制有限截断以外的中间素数 | PF02 |
| PF06 | 把密度定理归约为大素数尾项消失 | PF02、PF03、PF04、PF05 |
| PF07 | 局部二倍区间界足以控制原多项式的全局尾项 | PF01 |
| PF08 | 大素数整除产生统一的平衡数域分解 | — |
| PF09 | 固定左因子的算术纤维有统一大小界 | — |
| PF10 | 一般范数盒中的带索引整数点计数 | PF09 |
| PF11 | 一般范数盒分支的大素数尾项界 | PF08、PF10 |
| PF12 | 高次数直接曲面的选择点计数 | — |
| PF13 | 高次数分支的大素数尾项界 | PF12 |
| PF14 | 四次分解的坐标化和全部素数区间覆盖 | PF08 |
| PF15 | 四次径向纤维不会积聚过多点 | PF09 |
| PF16 | 四次盒系统的整数点计数核心 | — |
| PF17 | 将算术见证接入四次点计数 | PF09、PF14、PF15、PF16 |
| PF18 | 覆盖全部大素数的四次尾项界 | PF08、PF14、PF17 |
| PF19 | 回到原多项式并闭合所有次数的密度 | PF01、PF03、PF06、PF07、PF11、PF13、PF18 |

### PF01 · 把原多项式正规化而保留次数与不可约性

类型：数学结果。上游：无表内上游项。

**完整结论**

任意整数多项式 f，其有理数像不可约，则存在非零整数 a 和整数多项式 g，f=C(a)g，g 本原、首项系数为正、natDegree(g)=natDegree(f)，且 g 的有理数像不可约。

**允许的前提**

- f.map(ℤ→ℚ) 不可约。

**验收条件**

同一个 a,g 同时满足全部性质，不能额外要求原 f 本原或首项系数为正。

**参考声明**

- [OAI.QuarticPowerFree.exists_primitive_positive_normalization](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L849)

### PF02 · 良素数的幂模根数有次数界

类型：数学结果。上游：无表内上游项。

**完整结论**

对 natDegree(f)≠0、素数 p、k≠0，若 p 不整除 resultant(f,f′)，则 ρ_f(p^k)≤natDegree(f)；对有理不可约 f 和 k>1，推出 ∑_{p prime}ρ_f(p^k)/p^k 收敛。

**允许的前提**

- 各结论分别使用上述非零次数、非坏素数、不可约和 k 的条件。

**验收条件**

包括由模 p 根到模 p^k 的唯一提升及有限个坏素数的处理。只在 k=1 或只给好素数密度直觉不通过。

**参考声明**

- [OAI.QuarticPowerFree.rho_prime_pow_le_degree](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L84)
- [OAI.QuarticPowerFree.summable_local_proportion](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L146)

### PF03 · Euler 乘积收敛且严格为正

类型：衔接推理。上游：PF02。

**完整结论**

对有理不可约、次数非零的 f、k>1，若 LocallyAdmissible(f,k)，则 localFactor(f,k) 可乘，且 c_f,k=∏_p(1−ρ_f(p^k)/p^k)>0。

**允许的前提**

- 原定义的逐素数局部可容许性；PF02 的局部比例级数收敛。

**验收条件**

保留每个因子的严格正性以及无穷乘积不退化为 0 的论证，不能只证明有限乘积为正。

**参考声明**

- [OAI.QuarticPowerFree.densityConstant_converges_pos](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L168)

### PF04 · 有限素数筛的精确主项和周期误差

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意 f,k、有限素数集 P 和 N∈ℕ，避免所有 p∈P 的 p^k∣f(n) 的 Nat.count 满足 |count−N∏_{p∈P}(1−ρ_f(p^k)/p^k)|≤∏_{p∈P}p^k。

**允许的前提**

- 有限 P；源码 Nat.count 的半开区间定义。

**验收条件**

从中国剩余定理得到一个完整周期内的合法剩余类数，并控制末尾不完整周期。仅有渐近口头说明不通过。

**参考声明**

- [OAI.QuarticPowerFree.finite_sieve_full_period](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L304)
- [OAI.QuarticPowerFree.finite_sieve_error](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L350)

### PF05 · 控制有限截断以外的中间素数

类型：衔接推理。上游：PF02。

**完整结论**

对次数非零的 f、k>0，若 Y 包含所有整除 resultant(f,f′) 的素数，则 Y<p≤N 导致 p^k∣f(n) 的计数和≤N∑_{Y<p≤N}ρ_f(p^k)/p^k+deg(f)·π(N)。

**允许的前提**

- Y 大于等于全部坏素数；k>0；源码计数区间。

**验收条件**

给出对所有 Y,N 的统一误差，并说明坏素数为何能放入有限截断。不可把未计的 p>N 项遗漏。

**参考声明**

- [OAI.QuarticPowerFree.intermediate_sieve_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L516)
- [OAI.QuarticPowerFree.exists_bad_prime_cutoff](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L570)

### PF06 · 把密度定理归约为大素数尾项消失

类型：衔接推理。上游：PF02、PF03、PF04、PF05。

**完整结论**

对原 f 有理不可约、次数非零、k>1、LocallyAdmissible(f,k)，若 tailCount(f,k,N)/N→0，其中 tailCount 数 n<N 且存在 p>N、p^k∣f(n)，则 DensityStatement(f,k)：Euler 乘积可乘、常数正，且 count(f,k,X)−c_f,k X=o(X)。

**允许的前提**

- 上述原题条件；大素数尾项趋于 0 是本条件引理的唯一待供给算术结论。

**验收条件**

正确交换有限筛截断和 N→∞ 的控制，最后回到题面 1≤n≤⌊X⌋ 的实变量 count，处理端点差。

**参考声明**

- [OAI.QuarticPowerFree.nat_density_from_large_prime_tail](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L603)
- [OAI.QuarticPowerFree.real_asymptotic_from_nat_ratio](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L691)
- [OAI.QuarticPowerFree.densityStatement_from_large_prime_tail](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L730)

### PF07 · 局部二倍区间界足以控制原多项式的全局尾项

类型：衔接推理。上游：PF01。

**完整结论**

若 dyadicTailCount(g,k,M)≤C M^(1−δ) 对充分大 M 成立、δ>0，则其与 M 的比值趋于 0，进一步 tailCount(g,k,N)/N→0。若 f=C(a)g、a≠0，则 f 与 g 的全局尾项趋零等价。

**允许的前提**

- 任意固定 δ>0、C；题面 tailCount/dyadicTailCount 定义；非零标量 a。

**验收条件**

同时完成二倍区间到全区间的递归控制和标量坏素数的有限排除；不要求 g 与 f 具有相同的密度常数。

**参考声明**

- [OAI.QuarticPowerFree.dyadic_tail_limit_of_power_saving](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L909)
- [OAI.QuarticPowerFree.global_tail_of_dyadic_tail](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L832)
- [OAI.QuarticPowerFree.global_tail_scalar_iff](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L902)

### PF08 · 大素数整除产生统一的平衡数域分解

类型：数学结果。上游：无表内上游项。

**完整结论**

对有理不可约、正首项系数、次数 d≥1 的 f 和 k>0，存在固定 ArithmeticModel M、μ>0、有限非零理想集 Q、C≥1、X₀>0；对每个 X≥X₀、X<n≤2X、素数 p>X 且 p^k∣f(n)，有同一组 J∈Q、α≠0、β 满足 α^kβ=μ(n−M.root)、|Norm(α)|=p·Norm(J)。每个无穷位 w 同时满足 C⁻¹p^(1/d)≤w(α)≤Cp^(1/d)，以及 (2C^k)⁻¹X/p^(k/d)≤w(β/μ)≤3C^kX/p^(k/d)。

**允许的前提**

- 上述 f,k 条件；完整 ArithmeticModel 定义。

**验收条件**

有限理想集合、μ、常数和阈值先于 n,p 选择；等式、范数和无穷位界必须属于同一 α,β,J。只获得某个因子分解或各自的界不通过。

**参考声明**

- [OAI.QuarticPowerFree.balanced_arithmetic](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/UnitBalancing.lean#L436)

### PF09 · 固定左因子的算术纤维有统一大小界

类型：数学结果。上游：无表内上游项。

**完整结论**

对本原 f、有限索引集 S、在 S 上单射的 aᵢ∈(X,2X]，若 Pᵢ 为大于 X 的素数并整除 f(aᵢ)，Jᵢ 属于固定非零理想集 Q，且 |Norm(Aᵢ)|=Pᵢ·Norm(Jᵢ)，则任意 α 的纤维 #{i∈S:Aᵢ=α}≤|Q|·deg(f)。

**允许的前提**

- 上述单射性、素数整除、理想与范数条件；f 本原。

**验收条件**

必须用范数相等把素数固定，并保留 a 的单射性，防止同一个整数见证被重复计数。

**参考声明**

- [OAI.QuarticPowerFree.norm_left_fibre_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/EmbeddingCharts.lean#L293)

### PF10 · 一般范数盒中的带索引整数点计数

类型：衔接推理。上游：PF09。

**完整结论**

对本原 f、5≤d=deg(f)≤8，固定数域的 d 维 IntegralEmbeddingChart、互异的 θ 嵌入、μ>0、有限非零理想集 Q、Cbox≥1。存在 C>0、X₀，统一对全部有限索引族：a 单射、X<aᵢ≤2X、Pᵢ prime>X 且 Pᵢ∣f(aᵢ)、Jᵢ∈Q、Aᵢ≠0、Aᵢ^(d−2)Bᵢ=μ(aᵢ−θ)、|Norm(Aᵢ)|=PᵢNorm(Jᵢ)，以及每个坐标 |Aᵢ,j|≤Cbox X^(1/3)、|Bᵢ,j|≤Cbox X^(2/5)，都有 |ι|≤C X^(997/1000)。

**允许的前提**

- 上述完整图表、范数方程、坐标盒与有限族条件。

**验收条件**

完成到代数点集的单射及范数盒计数，不能把所需 norm_box_count 当作未证明的新公理；若引用冻结背景，需事先列明这一定理是否在其中。

**参考声明**

- [OAI.QuarticPowerFree.norm_indexed_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/MediumDegree.lean#L11)
- [OAI.QuarticPowerFree.norm_box_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/NormBoxes.lean#L117)

### PF11 · 一般范数盒分支的大素数尾项界

类型：衔接推理。上游：PF08、PF10。

**完整结论**

对本原、正首项系数、有理不可约且 5≤deg(f)≤8 的每个 f，存在 C>0，使充分大 N 的 dyadicTailCount(f,deg(f)−2,N)≤C N^(1−3/1000)。

**允许的前提**

- f 的上述条件；PF08、PF10 的统一接口。

**验收条件**

从每个坏整数选大素数见证，证明平衡坐标落入同一个盒，保留整数到索引族的单射后再计数；整段次数范围的定理才通过。

**参考声明**

- [OAI.QuarticPowerFree.balanced_coordinates_onebox](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/MediumDegree.lean#L142)
- [OAI.QuarticPowerFree.medium_degree_dyadic_tail](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/MediumDegree.lean#L200)

### PF12 · 高次数直接曲面的选择点计数

类型：数学结果。上游：无表内上游项。

**完整结论**

对本原、有理不可约且 d=deg(f)≥9 的每个 f，存在 C>0、X₀：任意 X>X₀ 及有限整数三元组集 S，若第一坐标 n 单射、X<n≤2X、第三坐标是素数 p>X、f(n)=y p^(d−2)，则 |S|≤C X^(1−1/2000)。

**允许的前提**

- 上述 f 和 S 条件；不额外假设首项系数为正。

**验收条件**

用两组坐标盒覆盖所有选择点，并完成直接曲面的计数界。只覆盖小素数盒、只证明曲面方程或只处理某个固定 d 不通过。

**参考声明**

- [OAI.QuarticPowerFree.high_degree_selected_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/HighDegree.lean#L113)
- [OAI.QuarticPowerFree.high_degree_two_boxes](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/HighDegree.lean#L64)
- [OAI.QuarticPowerFree.direct_surface_selected_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/SurfaceCounting.lean#L203)

### PF13 · 高次数分支的大素数尾项界

类型：衔接推理。上游：PF12。

**完整结论**

对本原、有理不可约且 deg(f)≥9 的每个 f，存在 C>0，使充分大 N 有 dyadicTailCount(f,deg(f)−2,N)≤C N^(1−1/2000)。

**允许的前提**

- PF12 的全族计数界；每个被计整数确有 p^k∣f(n) 见证。

**验收条件**

把坏整数映入 (n,y,p) 并证明第一坐标单射，且无需同时计入同一 n 的所有素数。

**参考声明**

- [OAI.QuarticPowerFree.high_degree_dyadic_tail](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/HighDegree.lean#L227)

### PF14 · 四次分解的坐标化和全部素数区间覆盖

类型：衔接推理。上游：PF08。

**完整结论**

对四次数域图表 T、互异 θ 嵌入、μ>0，α²β=μ(n−θ) 产生整数点 z，满足 quarticBoxOfChart 的全部方程及 q(z)=n。对所有 X≥1、F≥1、X<p≤FX²，可选 j:Fin 100 使 X^quarticLowerEta(j)<p≤F X^quarticUpperEta(j)，从 PF08 的同一 α,β 无穷位界推出各坐标 |α_l|≤Cbox X^quarticU(j)、|β_l|≤Cbox X^quarticV(j)。

**允许的前提**

- 四次图表及嵌入条件；同一 α,β 的因子方程和无穷位界；p 的完整大小范围。

**验收条件**

保留 q(z)=n 来防止坐标化丢失计数对象，给出全部 p 的有限覆盖和每个盒的统一 Cbox。100 个盒合为这一项，不逐盒或按素数参数给分。

**参考声明**

- [OAI.QuarticPowerFree.quarticIntegralPoint_equation](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/QuarticBoxes.lean#L227)
- [OAI.QuarticPowerFree.quartic_prime_bin](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/RadialFibres.lean#L198)
- [OAI.QuarticPowerFree.balanced_coordinates_quarticbox](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/RadialFibres.lean#L250)

### PF15 · 四次径向纤维不会积聚过多点

类型：衔接推理。上游：PF09。

**完整结论**

在四次数域图表中，有限族 Aᵢ≠0、Pᵢ prime、Jᵢ∈Q 且 |Norm(Aᵢ)|=PᵢNorm(Jᵢ)。若每个固定 A 值的纤维≤F，则对任意 α，满足所有嵌入 σ_l(Aᵢ)=c σ_l(α)（某个共同复数 c）的索引至多 2|Q|F。

**允许的前提**

- 四次数域；Q 中理想非零；上述范数与固定左因子纤维界。

**验收条件**

证明同一理想下的比例只能给出正负两种左因子，并汇总 Q；不能把径向非退化性直接当作额外假设。

**参考声明**

- [OAI.QuarticPowerFree.quartic_radial_fibre_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/RadialFibres.lean#L11)
- [OAI.QuarticPowerFree.prime_norm_proportional_sign](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/QuarticBoxes.lean#L323)

### PF16 · 四次盒系统的整数点计数核心

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意 j:Fin 100、完整 QuarticBoxSystem M、正次数上界 D、0<ω_i≤1/2、整数权 w_i=400ω_i≠0、Cbox≥1、固定 F,R，存在 C>0、X₀。任意 X>X₀ 和 M 的整数点集 S，若坐标≤Cbox X^ω、q 的每个值纤维≤F、四个左坐标的每个纤维≤F、每条左嵌入径向纤维≤R、各左嵌入非零，则 |S|≤C X^(997/1000)。

**允许的前提**

- QuarticBoxSystem 的完整独立性、生成性、次数与权条件；上述三类纤维界和非零条件。

**验收条件**

从盒系统的代数几何结构和三类纤维界证明计数，不可仅重述一个未经证明的 power saving。此项覆盖全部 j，不能分成 100 个便宜分数。

**参考声明**

- [OAI.QuarticPowerFree.quartic_box_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/QuarticBoxes.lean#L121)

### PF17 · 将算术见证接入四次点计数

类型：衔接推理。上游：PF09、PF14、PF15、PF16。

**完整结论**

对每个固定 j、本原次数为 4 的 f 和固定四次数域图表、θ、μ,Q,Cbox，任意满足 PF10 同类算术条件但 k=2、坐标指数改为 quarticU(j)、quarticV(j) 的有限索引族，均有 |ι|≤C X^(997/1000)，其中 C,X₀ 在选择有限族前固定。

**允许的前提**

- a 的单射性；A²B=μ(a−θ)；|Norm A|=P Norm J；同一个 j 的坐标盒；所有图表、素数、非零条件。

**验收条件**

逐项补齐 PF16 的 q 纤维、固定左坐标纤维、径向纤维和非零字段，且同一整数点表示同时满足这些字段。零散的各类界不能自动代替这一连接。

**参考声明**

- [OAI.QuarticPowerFree.quartic_indexed_count](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/RadialFibres.lean#L74)

### PF18 · 覆盖全部大素数的四次尾项界

类型：衔接推理。上游：PF08、PF14、PF17。

**完整结论**

对每个本原、正首项系数、有理不可约的四次 f，存在 C>0，使充分大 N 的 dyadicTailCount(f,2,N)≤C N^(1−3/1000)。

**允许的前提**

- 上述四次 f 条件；统一算术分解和各盒计数。

**验收条件**

证明所有坏整数的素数见证都落入 100 个盒之一，统一有限多个常数和阈值并合计；只处理一个盒或仅证明坐标约束不通过。

**参考声明**

- [OAI.QuarticPowerFree.quartic_dyadic_tail](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Main.lean#L20)

### PF19 · 回到原多项式并闭合所有次数的密度

类型：汇合结论。上游：PF01、PF03、PF06、PF07、PF11、PF13、PF18。

**完整结论**

对任意 f∈ℤ[x]，若 f 的有理数像不可约、d=natDegree(f)≥4，且 LocallyAdmissible(f,d−2)，证明 OAI.QuarticPowerFree.allDegrees：localFactor 可乘、densityConstant(f,d−2)>0、count(f,d−2,X)−densityConstant(f,d−2)X=o(X)。

**允许的前提**

- 原题条件；三个覆盖分支的全称尾项界；非零标量回传接口。

**验收条件**

三个次数分支合起来覆盖 d≥4，且对正规化 g 的尾项界回传后使用原 f 的局部可容许性与原 f 的 Euler 乘积。只证本原正首项系数版本、上界次数≤8 的额外 density theorem，或遗漏乘积正性均不通过。

**参考声明**

- [OAI.QuarticPowerFree.densityStatement_from_normalized_dyadic_tail](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Sieve.lean#L926)
- [OAI.QuarticPowerFree.density_ge_five](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/MediumDegree.lean#L251)
- [OAI.QuarticPowerFree.density_ge_four](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Main.lean#L123)
- [OAI.QuarticPowerFree.allDegrees](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/NumberTheory/PowerFree/Main.lean#L144)
