# StronglyRayleighDPP 的论文形式化验收表

配置根为 `OAI.Problem336AdditiveD139.finite_strongly_rayleigh_response`。共 9 个等权项。[统一协议](README.md) · [结构化表](StronglyRayleighDPP.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026.pdf)

只评配置根 finite_strongly_rayleigh_response。任意非空有限 F、F→Bool 上强 Rayleigh 概率律 μ、任意实外场 h，μ_h 为指数倾斜，p_i=Eμ_h X_i，C_ij=Covμ_h(X_i,X_j)。采用正文 Lemma sr-response 的对称齐次化证明。

正文援引 Borcea–Brändén–Liggett 的稳定性和 Rayleigh 定理；形式化时需要按实验允许库补齐或引用已验收版本。 本题只计已配置的 finite_strongly_rayleigh_response。原 challenge 同文件另含五个定理占位；最终 checker 对整棵候选树扫描未完成证明，并比对配置根。提交时须移除与根无关的占位声明或一并闭合，原样保留其他 sorry 的树无法取得整题满分。

## SR01 · 正倾斜保持概率律与稳定性

对每个 h，Z(h)>0，μ_h 是概率律，g_{μ_h}(z)=g_μ((e^{h_j}z_j)_j)/g_μ((e^{h_j})_j)，且 μ_h 强 Rayleigh。

**允许前提**　scope 中的 μ,F,h。

**依赖**　无

**验收**　归一化和稳定性属于同一 μ_h，覆盖零概率原子和退化坐标。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L39-L52)

## SR02 · 有限配分和的协方差导数

对每个 h 和 i,j，r↦p_i(h+r e_j) 在0可导，导数 C_ij(h)。

**允许前提**　任意有限概率律及上述倾斜定义，不需额外满支撑假设。

**依赖**　SR01

**验收**　提交完整 HasDerivAt 或等价导数对象，并与配置 coordinatePerturb 对齐。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L22-L30)

## SR03 · 构造同一齐次化概率律

对 η=μ_h，取与 F 不交且大小 n=|F| 的 F′。条件于 A⊆F，均匀占据 F′ 的 n−|A| 个坐标，得到概率律 η̃，其 F 边缘为 η，总占据数恒 n，生成多项式为 Σ_A η(A) z^A e_{n−|A|}(w)/binom(n,|A|)。

**允许前提**　η 为任意 F 上概率律。

**依赖**　SR01

**验收**　三个性质必须来自同一 η̃，证明边缘恢复和端点 |A|=0,n。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L54-L73)

## SR04 · 齐次化的稳定性

对每个强 Rayleigh η，上项 η̃ 的对称齐次化多项式稳定，因此 η̃ 强 Rayleigh。

**允许前提**　η 强 Rayleigh及 SR03 的实际构造。

**依赖**　SR03

**验收**　以允许库中的齐次化定理或完整证明验收，不能额外假设 η 本身固定基数。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L73-L78)

## SR05 · Rayleigh 不等式给协方差符号

对 η̃ 中任意不同坐标 j,k，Covη̃(X_j,X_k)≤0。

**允许前提**　强 Rayleigh 的 η̃；允许使用已证明 Rayleigh 不等式。

**依赖**　SR04

**验收**　在全1向量求值并证明与同一概率律协方差的对应。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L80-L82)

## SR06 · 常数总数导出原坐标行界

对每个 i∈F，Σ_{j∈F}|C_ij(h)|≤2 C_ii(h)，其中 Σ_{j∈F⊔F′}Covη̃(X_i,X_j)=0，原坐标块协方差等于 η 的协方差。

**允许前提**　SR03 的边缘与固定总数，SR05 的符号。

**依赖**　SR03、SR05

**验收**　需显式消除 dummy 协方差，单独非对角非正不足验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L82-L98)

## SR07 · 二值方差的统一上界

对任意 i,h，C_ii=p_i(1−p_i)，0≤p_i≤1，因此2p_i(1−p_i)≤1/2。

**允许前提**　二值概率律 μ_h。

**依赖**　SR01

**验收**　包括 p_i=0,1，并证明统一数值常数。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L97-L100)

## SR08 · 沿同一线段积分得全局响应

对任意 h,h′，|p_i(h)−p_i(h′)|≤(1/2) max_j|h_j−h′_j|。

**允许前提**　SR02 导数、SR06 行界与 SR07 方差上界。

**依赖**　SR02、SR06、SR07

**验收**　在 h+t(h′−h),t∈[0,1] 使用全坐标导数及统一界，不能只验坐标方向。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L99-L102)

## SR09 · 独立核验配置根

对配置中每个 F,μ 及 StronglyRayleighFinite μ，完整证明三个合取：任意坐标方向 HasDerivAt；任意行绝对协方差和≤2p_i(1−p_i)≤1/2；任意 D≥0、逐坐标 |h_j−h′_j|≤D 时 |p_i(h)−p_i(h′)|≤D/2。

**允许前提**　配置根的原始类型、定义与前提。

**依赖**　SR02、SR06、SR07、SR08

**验收**　固定环境直接通过 finite_strongly_rayleigh_response 原目标，闭合所有依赖且无新增公理或未证明假设。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-free-uniform-spanning-forest-is-a-factor-of-IID-September-25-2026/build/sections/strongly-rayleigh.tex#L14-L36)
