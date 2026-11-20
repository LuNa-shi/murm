# EgyptianFractions 的论文形式化验收表

配置根为 `OAI.Problem337.main_double_log_order`。共 15 个等权项。[统一协议](README.md) · [结构化表](EgyptianFractions.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/Short-Egyptian-fractions-September-25-2026.pdf)

OAI.Problem337.main_double_log_order；仅论文主定理，不计表示1的计数和指定分母推论。

所有证明依赖须在固定 Lean/Mathlib 背景中核验；表内上游结论可作为显式条件参数，应用到原题时须补齐。允许等价表示和更强结论；参考证明使用的证明技术不作强制要求。 两道题对应同一论文主定理，各有形式接口；在多题平均中属于同一个数学任务家族，选取及权重须预先固定。 清理引理需保留恰好 k 项。联合见证项允许任何能交付同一组分母的证明。本表尚未用候选 Lean 片段做盲评校准。

## EF01 · 合法展开与最短长度语义

对每个1≤a<b存在严格递增、分母至少2的有限单位分数展开；最短长度由某个展开取得且不超过任意合法展开长度。

**允许前提**　a,b为自然数；配置根中的展开、最短长度和最大值定义。

**依赖**　无

**验收**　恢复本题各自的List或Fin元组定义；不能把sInf默认值当作存在性。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/introduction.tex#L3-L14)

## EF02 · 重复分母的等长清理

若0<x<1是恰好k≥1个正整数分母的单位分数之和，则有恰好k个两两不同、均≥2的分母且和仍为x。

**允许前提**　x为有理数，k为自然数。

**依赖**　无

**验收**　必须保持恰好k项；只得到长度≤k不能验收本项。允许任何正确的清理证明。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/elementary.tex#L33-L61)

## EF03 · 和为一的分母界与最坏分子下界

正整数d₁≤…≤d_s满足Σ1/d_i=1时，d_j≤s^(2^(j−1))；因此(b−1)/b的任意k项展开满足b≤(k+1)^(2^k)，进而log log b≤2k；得到b≥2时(1/2)log log b≤N(b)。

**允许前提**　有序正整数分母；N采用本题的最短长度最大值定义。 EF01。

**依赖**　EF01

**验收**　包含追加1/b、排序、最短值及最大值的连接；不得限于有限长度或分母样例。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/elementary.tex#L150-L170)

## EF04 · 共同分母和列表的构造接口

对每个允许的S,C，先有互异素数p₁,…,p_m∈[S^K,2S^K]；对任意R块各2m个该区间素数样本，可在同一个M中容纳T₀的全部子集积及T_i的全部二选一乘积，列表均有2^m个索引，所有条目t|M、1≤t≤e^((K+1)S)，e^S<M≤e^(D_M S)，且最小的≥S^D₀的2幂整除M。

**允许前提**　K=100、R=1000、D₀=100000、η=10⁻⁴、D_M=(2R+2)(K+2)、D_X=D_M+2、D_C=4D_X；S充分大，m=⌊S/log S⌋，ρ=e^(−ηm)，X_j=e^(D_X S)ρ^j，d为X_d≤e^m的最小索引；e^(D_C S)≤C≤e^(2D_C S)，C_j=C当X_j>e^S，否则1。 素数池基数至少S^(K−1)需证明；允许素数重复采样。

**依赖**　无

**验收**　同一M满足全部列表和二进制条件；阈值与C无关；分开构造各自分母不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/residues.tex#L99-L136)

## EF05 · Fourier小量推出足够多小余数

对充分大w、正整数u,Q、非空正整数列表T，若每个1≤ℓ≤⌊e^(4ηw)⌋满足|Σ_t e(ℓQt/u)/|T||≤e^(−3ηw)，则至少e^(−ηw)|T|/2个索引满足0≤u⌈Qt/u⌉−Qt<e^(−ηw)u。

**允许前提**　e(x)=exp(2πix)，η=10⁻⁴；按索引计重复值。

**依赖**　无

**验收**　交付完整量词、全部结论及可核验依赖；等价或更强结论可验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/residues.tex#L207-L236)

## EF06 · 高层确定性列表的统一均方界

对EF04的T₀，任意j<d且X_j>e^S、任意1≤ℓ≤⌊e^(4ηm)⌋，有X_j⁻¹Σ_(X_(j+1)<u≤X_j)|2^(−m)Σ_(t∈T₀)e(ℓCt/u)|²≤e^(−0.01m)。

**允许前提**　K=100、R=1000、D₀=100000、η=10⁻⁴、D_M=(2R+2)(K+2)、D_X=D_M+2、D_C=4D_X；S充分大，m=⌊S/log S⌋，ρ=e^(−ηm)，X_j=e^(D_X S)ρ^j，d为X_d≤e^m的最小索引；e^(D_C S)≤C≤e^(2D_C S)，C_j=C当X_j>e^S，否则1。 EF04的同一互异素数列表；所有阈值对允许C统一。

**依赖**　EF04

**验收**　验收此均方结论；任何正确证明技术均可。不能额外将所需抵消界当作假设。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/residues.tex#L360-L373)

## EF07 · 单块随机乘积的统一均方界

独立均匀从至少S^(K−1)个[S^K,2S^K]内素数中抽取p_(j,ε)，置t_I=∏p_(j,I_j)。若D₀log S≤log u≤S、w=min(m,log u)、1≤ℓ≤e^(0.005w)，则E|2^(−m)Σ_I e(ℓt_I/u)|²≤e^(−0.01w)。

**允许前提**　K=100、R=1000、D₀=100000、η=10⁻⁴、D_M=(2R+2)(K+2)、D_X=D_M+2、D_C=4D_X；S充分大，m=⌊S/log S⌋，ρ=e^(−ηm)，X_j=e^(D_X S)ρ^j，d为X_d≤e^m的最小索引；e^(D_C S)≤C≤e^(2D_C S)，C_j=C当X_j>e^S，否则1。 同一块全部2m个样本独立均匀；不要求t_I彼此独立。

**依赖**　无

**验收**　须覆盖全部允许u,ℓ及素数池；均方是明确的局部接口，不能只证某一模数。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/random.tex#L8-L32)

## EF08 · 一个共同见证同时满足所有层与终端

存在同一个M,T₀,…,T_R，满足EF04，并使每个j<d除至多X_j e^(−0.001m)个u∈(X_(j+1),X_j]外，至少ρ2^m/2个选定列表索引t满足u⌈C_jt/u⌉−C_jt≤X_(j+1)；选定列表为高层T₀、其余T₁。同时每个S^D₀<u≤e^m都有某i∈{1,…,R}及t∈T_i使u⌈t/u⌉−t≤u^(1−η)。

**允许前提**　K=100、R=1000、D₀=100000、η=10⁻⁴、D_M=(2R+2)(K+2)、D_X=D_M+2、D_C=4D_X；S充分大，m=⌊S/log S⌋，ρ=e^(−ηm)，X_j=e^(D_X S)ρ^j，d为X_d≤e^m的最小索引；e^(D_C S)≤C≤e^(2D_C S)，C_j=C当X_j>e^S，否则1。 EF04–07可作显式输入。

**依赖**　EF04、EF05、EF06、EF07

**验收**　验收完整联合存在命题；允许确定性构造、概率法或其他证明。分别存在中层好样本与终端好样本不通过；不强制使用独立块和union bound。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/residues.tex#L67-L97)

## EF09 · 移位截断除数矩的统一界

对任意固定实数D,r≥1存在S₀(D,r)，当S≥S₀且S/(2log S)≤log X≤DS、√X≤Y≤X、0≤N≤e^(DS)为整数时，Σ_(1≤h≤Y)d_X(N+h)^r≤Y exp(S^(1/4))；d_X(n)=#{1≤a≤X:a|n}。

**允许前提**　固定D,r先于S趋于无穷；Y,X为实数。

**依赖**　无

**验收**　必须对全部允许移位N统一，不能用仅从0开始的平均除数界替代。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/divisors.tex#L3-L35)

## EF10 · 终端短展开与层间真实恢复

对EF08的同一M，存在绝对B₀使所有1≤u≤X_d都有u/M的≤B₀log S项展开。递归定义G_d=[1,⌊X_d⌋]及G_j=G_(j+1)∪{1≤u≤X_j:某选定t的余数∈G_(j+1)∪{0}}，则每个u∈G_j有u/(MC_j)的≤B₀log S+d−j项展开。

**允许前提**　K=100、R=1000、D₀=100000、η=10⁻⁴、D_M=(2R+2)(K+2)、D_X=D_M+2、D_C=4D_X；S充分大，m=⌊S/log S⌋，ρ=e^(−ηm)，X_j=e^(D_X S)ρ^j，d为X_d≤e^m的最小索引；e^(D_C S)≤C≤e^(2D_C S)，C_j=C当X_j>e^S，否则1。 EF08；原始展开允许重复，分母均≥2。

**依赖**　EF08

**验收**　包含二进制终端、u→u^(1−η)收缩及C切换时的整数缩放zC_j/C_(j+1)；真实展开与G_j必须使用同一余数见证。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/descent.tex#L38-L109)

## EF11 · 坏集的一步递推

固定r≥max(2,8K_d)，K_d=3D_X/η、α=1−1/r。对EF10的同一G_j，令H_j=[1,⌊X_j⌋]\G_j、δ_j=|H_j|/X_j，则δ_d=0且每个j<d满足δ_j≤e^(−0.001m)+e^(2S^(1/4))δ_(j+1)^α。

**允许前提**　K=100、R=1000、D₀=100000、η=10⁻⁴、D_M=(2R+2)(K+2)、D_X=D_M+2、D_C=4D_X；S充分大，m=⌊S/log S⌋，ρ=e^(−ηm)，X_j=e^(D_X S)ρ^j，d为X_d≤e^m的最小索引；e^(D_C S)≤C≤e^(2D_C S)，C_j=C当X_j>e^S，否则1。 EF08–10；r固定且不随S增长。

**依赖**　EF08、EF09、EF10

**验收**　实际核对所有移位C_jt、X_j,X_(j+1)满足除数矩前提，并计入重复索引；仅陈述抽象递推不能验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/descent.tex#L115-L219)

## EF12 · 递推得到同一稠密短展开族

在同一M,G₀上证明δ₀≤d exp(2rS^(1/4)−0.001mS^(−1/4))→0。因此存在绝对L,S₀，对于所有S≥S₀及允许C，|[1,⌊e^(D_XS)⌋]\G₀|≤e^(D_XS)/8，且每个u∈G₀有u/(MC)的≤Llog S项展开。

**允许前提**　K=100、R=1000、D₀=100000、η=10⁻⁴、D_M=(2R+2)(K+2)、D_X=D_M+2、D_C=4D_X；S充分大，m=⌊S/log S⌋，ρ=e^(−ηm)，X_j=e^(D_X S)ρ^j，d为X_d≤e^m的最小索引；e^(D_C S)≤C≤e^(2D_C S)，C_j=C当X_j>e^S，否则1。 EF10–11；d≤K_dlog S及α^d≥S^(−1/4)需证明。

**依赖**　EF10、EF11

**验收**　常数L,S₀不能依赖C，稠密性与展开必须指向同一G₀,M。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/descent.tex#L221-L256)

## EF13 · 贪心预处理保持分子并控制长度

对整数1≤a<b及实T>b，最多1+⌈log₂(log T/log2)⌉步后，或展开结束，或余项为A/C且1≤A≤a、T≤C<T²；前缀分母均≥2。

**允许前提**　a/b无需约分；自然贪心步A′=A⌈C/A⌉−C、C′=C⌈C/A⌉。

**依赖**　无

**验收**　验收整个统一结论；单步严格降分子及平方压缩需闭合到步数上界。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/elementary.tex#L63-L112)

## EF14 · 从稠密集合恢复每个原分数

令S=log b，取T=e^(D_CS)。对EF13的余项A/C及EF12的同一M,G，找到正整数g及u,v∈G使u+v=gAM、X/2≤gAM≤X。合并u/(MC),v/(MC)的展开并将所有分母乘g，恢复A/C；接回前缀、清理重复，得到每个1≤a<b都有≤c₂log log b项严格展开，c₂、阈值与a无关。

**允许前提**　K=100、R=1000、D₀=100000、η=10⁻⁴、D_M=(2R+2)(K+2)、D_X=D_M+2、D_C=4D_X；S充分大，m=⌊S/log S⌋，ρ=e^(−ηm)，X_j=e^(D_X S)ρ^j，d为X_d≤e^m的最小索引；e^(D_C S)≤C≤e^(2D_C S)，C_j=C当X_j>e^S，否则1。 EF02、12、13；b充分大，X=e^(D_XS)。

**依赖**　EF02、EF12、EF13

**验收**　整数g、u,v与同一G,M绑定；不能只证明对大多数分子成立。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/elementary.tex#L114-L148)

## EF15 · 恢复配置根的完整量词

交付OAI.Problem337.main_double_log_order：存在正c₁,c₂及自然b₀，对每个b≥b₀，c₁log log b≤maxEgyptianLength(b)≤c₂log log b；EgyptianLength使用Fin元组严格展开，须建立与论文N(a,b)的对应。

**允许前提**　原题定义；EF01、03、14。

**依赖**　EF01、EF03、EF14

**验收**　原配置checker验收，全部上游依赖无sorry、无新增公理。完整根可由其他路线完成并直接满分。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Short-Egyptian-fractions-September-25-2026/build/introduction.tex#L3-L24)
