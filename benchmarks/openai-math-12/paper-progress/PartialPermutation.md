# PartialPermutation 的论文形式化验收表

配置根为 `OAI.PartialPermutation.complementaryCosets_finite`。共 9 个等权项。[统一协议](README.md) · [结构化表](PartialPermutation.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/main.pdf)

OAI.PartialPermutation.complementaryCosets_finite；论文Complementary cosets control Fourier matrices。

所有证明依赖须在固定 Lean/Mathlib 背景中核验；表内上游结论可作为显式条件参数，应用到原题时须补齐。允许等价表示和更强结论；参考证明使用的证明技术不作强制要求。 论文同时给出orbit与isotypic两种路线。当前中间项选择更强的isotypic全矩阵路线；采用完整orbit路线且只得到op界时不能冒认HS根完成。 经典Specht分类/hook等在论文为输入，在固定形式环境中是否免费取决于实际提供的可信库，须逐项核对。 这些接口颗粒度不相等，需要校准；篇幅与证明难度没有被转换为等权依据。

## PP01 · 对称群不可约表示的维数语义

建立Sym(Fin n)的全部不可约复表示类型与分拆λ⊢n的对应，维数D_λ等于标准Young表数量，满足hook公式D_λ=n!/∏_(x∈λ)h(x)。

**允许前提**　所有n≥1；有限群表示、Young图和标准表的定义。

**依赖**　无

**验收**　论文将这些视为经典输入；固定Mathlib若未提供，必须随候选提交完整证明依赖，不能当作额外公理。覆盖全部不可约类型。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/foundations.tex#L13-L18)

## PP02 · 近行分拆的统一维数与个数界

令j=n−max(λ₁,λ′₁)，1≤j≤n/3时该亏损的形状至多2p(j)种，D_λ≥C(n−j,j)≥2^j；固定j>0时维数下界随n趋于无穷。并有p(j)≤exp(3√j)。

**允许前提**　PP01；λ可转置以最长边作为首行。

**依赖**　PP01

**验收**　维数、分拆个数和固定j极限都要证明；保留n,j范围，任何正确推导可验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/foundations.tex#L16-L27)

## PP03 · 远离行列的统一指数下界

当max(λ₁,λ′₁)<2n/3，存在绝对c>0和阈值，使D_λ≥exp(cn)；证明同时控制最长边≥n/10与<n/10两种情况，或交付等强统一结论。

**允许前提**　PP01；全部分拆λ⊢n。

**依赖**　PP01

**验收**　指数常数与λ,n无关，不能只检查固定分拆。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/foundations.tex#L29-L30)

## PP04 · 所有正幂的倒数维数和一致有界

对每个实u>0，去掉行列两个一维类型后的Z_u(n)=ΣD_λ^(−u)→0，故C_u=sup_(n≥1)Σ_(λ⊢n)D_λ^(−u)<∞，每个n≥1的完整和≤C_u。

**允许前提**　PP01–03；u固定后n趋于无穷。

**依赖**　PP01、PP02、PP03

**验收**　证明可求和主控与尾部趋零，不能只证明各固定n有限；把论文C_u对应到题面sSup不可约维数和。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/foundations.tex#L6-L30)

## PP05 · 全部乘积类型由小维数投影覆盖

对任意有限X的非空不交分块M₁,…,M_b，b>0；H_i为固定块外点的置换群。任意D维酉表示限制到∏H_i时，每个非零乘积等型分量包含某因子类型τ，dimτ≤D^(1/b)。令P_(i,τ)为完整H_i等型正交投影，则I≼Σ_(i,dimτ≤D^(1/b))P_(i,τ)。

**允许前提**　有限维酉表示、D>0；分块覆盖X；有限群张量型分解需有完整证明。

**依赖**　无

**验收**　同一ρ和子群族，包含所有重数。只选一个不可约拷贝不能验收；论文L136–143也给出正算子形式。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/core.tex#L130-L144)

## PP06 · 一个子群类型的完整傅里叶能量界

任意有限群G、H≤G，f≥0、z=Σf≤1且每个gH满足f(gH)≤B/[G:H]；任意不可约H类型τ维数a，其完整等型投影P_(ρ,H,τ)满足Σ_(ρ∈Irr G)D_ρ‖f̂(ρ)P_(ρ,H,τ)‖²_HS≤Bza²。

**允许前提**　有限群酉表示及计数测度Fourier归一化f̂=Σf(g)ρ(g)。

**依赖**　无

**验收**　含所有环境不可约ρ与所有重数；必须核验中心幂等元、卷积或等价能量推导。仅对某向量或某选定拷贝的界不够。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/core.tex#L90-L127)

## PP07 · 小维数截断和与原题常数连接

对每个块H_i≅Sym(M_i)、阈值R=D^(1/b)、u>0，Σ_(τ∈Irr H_i,dimτ≤R)(dimτ)²≤C_uD^((u+2)/b)。

**允许前提**　PP04；每个M_i非空；有限群同构转移表示及维数的证明。

**依赖**　PP04

**验收**　使用每个实际块的阶数，C_u与题面相同；所有群同构与归一化适配需可核验。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/core.tex#L48-L56)

## PP08 · 覆盖与能量汇合为全矩阵界

对同一ρ、f、H_i，D‖f̂(ρ)‖²_HS≤Bz b C_u D^((u+2)/b)，从而‖f̂(ρ)‖²_HS≤bBC_uD^(−1+(u+2)/b)。

**允许前提**　PP05–07；ρ不可约酉，D=dimρ>0；原题全部左余类约束、f≥0及z≤1。

**依赖**　PP05、PP06、PP07

**验收**　证明正算子覆盖对f̂* f̂的trace推论及能量求和；同一投影族同时满足覆盖和能量，不能拼接不兼容表示。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/core.tex#L130-L145)

## PP09 · 恢复配置根中的两种范数界

对原题任意有限X及全部原假设，交付OAI.PartialPermutation.complementaryCosets_finite，Hilbert–Schmidt范数平方及算子范数平方均≤bBC_uD^(−1+(u+2)/b)。

**允许前提**　PP08；‖A‖²_op≤‖A‖²_HS的完整证明或固定Mathlib结果。

**依赖**　PP08

**验收**　保持全部量词、任意有限X、题面sSup常数与左右余类约定；恢复完整合取并由配置checker验收。可通过任何完整路线直接满分。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/From-partial-permutation-information-to-Fourier-bounds-September-26-2026/build/sections/introduction.tex#L18-L37)
