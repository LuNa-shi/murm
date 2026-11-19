# StronglyRayleighDPP：强 Rayleigh 分布的有限维响应

**16 个固定评分项 · 适合**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](StronglyRayleighDPP.json)

## 目标与适用性

- 题目 ID：`oai_strongly_rayleigh_dpp`。
- 唯一计分根：`OAI.Problem336AdditiveD139.finite_strongly_rayleigh_response`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/StronglyRayleighDPP.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 配置根的证明路线清楚：两类协方差符号分别由稳定多项式得到，再推出导数与全局响应界。可以把中间数学缺口固定下来逐项验收。

**需要留意：** 这些是所选参考证明的义务，不声称所有可能证明都必须使用 Pick 函数或同一种切片。采用另一条路线的实验需先映射到同等强度的义务。

**下一步：** 先用这 16 项进行人工事后标注；冻结此版本后比较同一根、同一预算的实验。

## 参考证明主线

先建立倾斜矩与响应导数。二元稳定性给出非对角协方差非正；单坐标切片、Pick 导数界和 Wronskian 不等式给出协方差行和非负。两者合成绝对行和界，再沿连接两外场的直线积分，完成 configured root。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| SR01 | 倾斜分布有严格正的归一化常数 | — |
| SR02 | 均值范围与对角协方差 | SR01 |
| SR03 | 坐标方向的响应导数 | SR01 |
| SR04 | 任意直线方向的响应导数 | SR01 |
| SR05 | 把双坐标协方差写成四格质量行列式 | SR01 |
| SR06 | 稳定双线性多项式在边界满足 Rayleigh 不等式 | — |
| SR07 | 强 Rayleigh 性推出所有非对角协方差非正 | SR05、SR06 |
| SR08 | 单坐标生成切片保留稳定性 | — |
| SR09 | 协方差行和等于切片的 Wronskian 表达式 | SR01 |
| SR10 | 稳定仿射切片的非零斜率在上半平面无根 | — |
| SR11 | Pick 型函数的导数上界 | — |
| SR12 | 由稳定性得到切片 Wronskian 上界 | SR10、SR11 |
| SR13 | 切片不等式推出协方差行和非负 | SR08、SR09、SR12 |
| SR14 | 正负号合并成绝对行和界 | SR02、SR07、SR13 |
| SR15 | 行和界控制沿线方向导数并积分 | SR04、SR14 |
| SR16 | 组装原题有限响应结论 | SR03、SR04、SR14、SR15 |

### SR01 · 倾斜分布有严格正的归一化常数

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意 h，Z(h)>0；因此后续矩和导数中的除法都有定义。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。

**验收条件**

证明全部实外场的正性，包括原测度有零质量原子的情况；只在 h=0 的归一化等式不能验收。

**参考声明**

- [OAI.Problem336AdditiveD139.tiltPartition_pos](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/TiltPartition.lean#L32)

### SR02 · 均值范围与对角协方差

类型：数学结果。上游：SR01。

**完整结论**

对每个 i,h，0≤mᵢ≤1、Cᵢᵢ=mᵢ(1−mᵢ)≥0，并有 2mᵢ(1−mᵢ)≤1/2。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- SR01 的完整结论。

**验收条件**

同时给出矩恒等式和统一方差上界；不能把二值变量方差公式直接当成未声明前提。

**参考声明**

- [OAI.Problem336AdditiveD139.tiltMean_nonneg](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/ElementaryResponse.lean#L17)
- [OAI.Problem336AdditiveD139.tiltMean_le_one](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/ElementaryResponse.lean#L27)
- [OAI.Problem336AdditiveD139.tiltCovariance_self](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/ElementaryResponse.lean#L44)
- [OAI.Problem336AdditiveD139.twice_tilt_variance_le_half](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/ElementaryResponse.lean#L56)

### SR03 · 坐标方向的响应导数

类型：数学结果。上游：SR01。

**完整结论**

对任意 i,j,h，r↦tiltMean μ (coordinatePerturb h j r) i 在 r=0 可导，导数为 Cᵢⱼ(h)。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- SR01 的完整结论。

**验收条件**

验收 HasDerivAt 的完整量词；需要从有限指数和及商法则导出，单独求出 Z 的导数不算完成。

**参考声明**

- [OAI.Problem336AdditiveD139.tiltMean_hasDerivAt_coordinate](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/ResponseDerivative.lean#L65)

### SR04 · 任意直线方向的响应导数

类型：数学结果。上游：SR01。

**完整结论**

对任意 h,v,t,i，s↦mᵢ(h+s v) 在 t 的导数为 Σⱼ Cᵢⱼ(h+t v)vⱼ。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- SR01 的完整结论。

**验收条件**

v 可任意取值且 t 为任意实数；只证明坐标导数、未证明沿路径的可导性时本项不得分。

**参考声明**

- [OAI.Problem336AdditiveD139.tiltMean_hasDerivAt_affine](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/ResponseDirectional.lean#L72)

### SR05 · 把双坐标协方差写成四格质量行列式

类型：数学结果。上游：SR01。

**完整结论**

i≠j 时，令 a,b,c,d 分别为倾斜后未归一化的 (0,0),(1,0),(0,1),(1,1) 质量，证明 Cᵢⱼ=(ad−bc)/Z²。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- SR01 的完整结论。

**验收条件**

四个质量必须来自同一 μ,h,i,j；分母是同一个 Z，不能分别归一化边缘分布。

**参考声明**

- [OAI.Problem336AdditiveD139.tiltCovariance_pairMass](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/PairCoefficients.lean#L82)

### SR06 · 稳定双线性多项式在边界满足 Rayleigh 不等式

类型：数学结果。上游：无表内上游项。

**完整结论**

若连续复系数 A(t),B(t),C(t),D(t) 在 t↓0 收敛到实数 a,b,c,d，且 t>0 时 A+Bz+Cw+Dzw 在两个上半平面变量上非零，则 ad≤bc。

**允许的前提**

- 源声明 bivariate_continuous_limit_rayleigh 的连续性、实极限及上半平面非零前提。

**验收条件**

证明完整的边界传递；只证明系数已为实数时的二元情形不足以完成此项。

**参考声明**

- [OAI.Problem336AdditiveD139.bivariate_continuous_limit_rayleigh](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/BivariateStability.lean#L93)

### SR07 · 强 Rayleigh 性推出所有非对角协方差非正

类型：衔接推理。上游：SR05、SR06。

**完整结论**

对任意 h 和 i≠j，用 exp(hₖ) 正缩放以及其余变量 1+it 的稳定双坐标切片，推出 Cᵢⱼ(h)≤0。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- 原题 StronglyRayleighFinite μ；不得增加齐次性、满支撑或非退化假设。
- SR05、SR06 的完整结论；生成多项式和 tiltPairMass 的固定定义。

**验收条件**

必须把原题稳定性接到 SR06 的四个系数，并证明其 t→0 极限就是 SR05 的四格质量；不能直接假设负关联。

**参考声明**

- [OAI.Problem336AdditiveD139.StronglyRayleighFinite.tiltCovariance_nonpos](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/RayleighOffDiagonal.lean#L16)
- [OAI.Problem336AdditiveD139.generating_monomial_rescale](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/TiltScaling.lean#L24)
- [OAI.Problem336AdditiveD139.weighted_generating_two_coordinates](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/TwoCoordinateCoefficients.lean#L61)

### SR08 · 单坐标生成切片保留稳定性

类型：数学结果。上游：无表内上游项。

**完整结论**

固定 i，令 p(z)、q(z) 分别为 xᵢ=false、true 的倾斜质量按其余真坐标数生成的多项式。证明 p,q 系数非负，且 Im z,Im s>0 时 p(z)+s q(z)≠0。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- 原题 StronglyRayleighFinite μ；不得增加齐次性、满支撑或非退化假设。
- GeneratingSlice.slice、weight 的固定定义。

**验收条件**

需要把切片与原生成多项式的正缩放逐项对应；两项切片必须来自同一 i,h，不能额外假设 q≠0。

**参考声明**

- [OAI.Problem336AdditiveD139.GeneratingSlice.slice_coeff_nonneg](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/GeneratingSlice.lean#L103)
- [OAI.Problem336AdditiveD139.GeneratingSlice.slice_generating_identity](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/GeneratingSlice.lean#L122)
- [OAI.Problem336AdditiveD139.GeneratingSlice.slice_stable](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/GeneratingSlice.lean#L134)

### SR09 · 协方差行和等于切片的 Wronskian 表达式

类型：数学结果。上游：SR01。

**完整结论**

对 SR08 定义的 p,q，证明 ΣⱼCᵢⱼ=[p(1)q(1)+p(1)q′(1)−q(1)p′(1)]/Z²。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- SR01 的完整结论；SR08 中 p,q 的定义，不假设其稳定性结论。

**验收条件**

必须覆盖全部 j，包括对角项；只对非对角和建立公式不能验收。

**参考声明**

- [OAI.Problem336AdditiveD139.GeneratingSlice.covariance_row_eq_slice](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/GeneratingSlice.lean#L223)

### SR10 · 稳定仿射切片的非零斜率在上半平面无根

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意实多项式 p,q，若 p(z)+wq(z) 对 Im z,Im w>0 非零且 q≠0，则 q 在整个上半平面无根。

**允许的前提**

- 源声明 polynomial_slope_stable_of_affine_stable 中的仿射稳定性和 q≠0；p,q 任意实多项式。

**验收条件**

需要消除 q 可能在上半平面孤立为零的情况；不能把分母无根当作稳定性定义中的已知条件。

**参考声明**

- [OAI.Problem336AdditiveD139.polynomial_slope_stable_of_affine_stable](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/AffineSlopeStability.lean#L104)

### SR11 · Pick 型函数的导数上界

类型：数学结果。上游：无表内上游项。

**完整结论**

若复函数 f 在 slitPlane 上可微、把上半平面送入闭上半平面、与共轭相容、正实轴上实部非负，并在 1 有导数 f′，则 Re f′≤Re f(1)。

**允许的前提**

- 源声明 reflectedPick_derivative_re_le 的完整解析性、符号、共轭和 HasDerivAt 前提。

**验收条件**

验收一般函数的导数界及边界非严格符号；只验证某个常函数或只陈述 Schwarz–Pick 名称不能验收。

**参考声明**

- [OAI.Problem336AdditiveD139.reflectedPick_derivative_re_le](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/PickSquareRoot.lean#L126)

### SR12 · 由稳定性得到切片 Wronskian 上界

类型：衔接推理。上游：SR10、SR11。

**完整结论**

对系数非负的实多项式 p,q，只假设 p(z)+wq(z) 在上半平面稳定，证明 q(1)p′(1)−p(1)q′(1)≤p(1)q(1)。

**允许的前提**

- p,q 的非负系数与仿射稳定性。
- SR10、SR11 的完整结论；多项式比值的固定定义。

**验收条件**

把 f=p/q 的解析域、共轭性、半平面像和正实轴符号逐一接到 SR11；p=0 或 q=0 也必须覆盖，不能在最终前提中保留 q≠0。

**参考声明**

- [OAI.Problem336AdditiveD139.stable_affine_wronskian_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/StableWronskian.lean#L51)
- [OAI.Problem336AdditiveD139.stable_wronskian_of_denominator_stable](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/StableWronskian.lean#L14)
- [OAI.Problem336AdditiveD139.polynomial_ratio_analyticOnNhd_slitPlane](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/PolynomialPick.lean#L42)
- [OAI.Problem336AdditiveD139.polynomial_ratio_im_nonneg_of_affine_stable](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/PolynomialPick.lean#L12)

### SR13 · 切片不等式推出协方差行和非负

类型：衔接推理。上游：SR08、SR09、SR12。

**完整结论**

把 SR08 的同一 p,q 代入 SR12，再通过 SR09 证明每个 i,h 都有 ΣⱼCᵢⱼ≥0。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- 原题 StronglyRayleighFinite μ；不得增加齐次性、满支撑或非退化假设。
- SR08、SR09、SR12 的完整结论。

**验收条件**

给出从多项式分子符号到整行协方差符号的桥接；不得用独立于 μ,h 的另一对切片替换。

**参考声明**

- [OAI.Problem336AdditiveD139.GeneratingSlice.covariance_row_nonneg_of_slice_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/GeneratingSlice.lean#L238)
- [OAI.Problem336AdditiveD139.StronglyRayleighFinite.tiltCovariance_row_nonneg](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/RayleighResponse.lean#L16)

### SR14 · 正负号合并成绝对行和界

类型：衔接推理。上游：SR02、SR07、SR13。

**完整结论**

由对角非负、非对角非正和整行和非负，证明 Σⱼ|Cᵢⱼ|≤2mᵢ(1−mᵢ)≤1/2，对全部 i,h 成立。

**允许的前提**

- 任意有限类型 F、F→Bool 上的概率测度 μ、任意实外场 h；记 Z=tiltPartition μ h、mᵢ=tiltMean μ h i、Cᵢⱼ=tiltCovariance μ h i j。
- 原题 StronglyRayleighFinite μ；不得增加齐次性、满支撑或非退化假设。
- SR02、SR07、SR13 的完整结论。

**验收条件**

必须计算绝对值行和并同时保留精确的 2mᵢ(1−mᵢ) 上界；单独知道每个非对角项≤0不能验收。

**参考声明**

- [OAI.Problem336AdditiveD139.sum_abs_row_le_twice_diag](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/CovarianceRow.lean#L28)
- [OAI.Problem336AdditiveD139.finite_response_of_covariance_signs](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/FiniteResponseAssembly.lean#L16)

### SR15 · 行和界控制沿线方向导数并积分

类型：衔接推理。上游：SR04、SR14。

**完整结论**

对任意 f,c，若所有直线方向导数都为 Σⱼcⱼ(h+t v)vⱼ 且 Σⱼ|cⱼ(h)|≤C，则 |hⱼ−h′ⱼ|≤D、D≥0 蕴含 |f(h)−f(h′)|≤CD。

**允许的前提**

- 源声明 finite_response_lipschitz_of_directional_deriv 的全局方向导数和统一绝对行和前提。
- SR04 的任意方向导数和 SR14 的绝对行和完整结论，用于同一 μ,i 的具体应用。

**验收条件**

需要证明整条连接线段上的导数界并应用均值估计；只证明某一点的局部微分估计不足。 最后代入同一 μ,i 的倾斜均值与协方差，取 C=1/2，得出任意外场之间的 D/2 响应界。

**参考声明**

- [OAI.Problem336AdditiveD139.covariance_direction_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/ResponseLipschitz.lean#L13)
- [OAI.Problem336AdditiveD139.finite_response_lipschitz_of_directional_deriv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/ResponseLipschitz.lean#L26)
- [OAI.Problem336AdditiveD139.finite_response_of_covariance_signs](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/FiniteResponseAssembly.lean#L16)

### SR16 · 组装原题有限响应结论

类型：汇合结论。上游：SR03、SR04、SR14、SR15。

**完整结论**

证明配置根 finite_strongly_rayleigh_response：所有有限非空 F 和强 Rayleigh 概率 μ 同时满足坐标导数、绝对行和的两级界、全局 D/2 响应界。

**允许的前提**

- 原题 F 的有限、非空条件和 StronglyRayleighFinite μ。
- SR03、SR04、SR14、SR15 的完整结论。

**验收条件**

精确恢复 configured root 的完整合取和量词；本题另外五个 DPP/group 声明不计入此分母。

**参考声明**

- [OAI.Problem336AdditiveD139.finite_strongly_rayleigh_response](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Probability/StrongRayleigh/Main.lean#L21)
