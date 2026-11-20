# EntropyPhotonNumber 的论文形式化验收表

配置根为 `OAI.EntropyPhotonNumber.entropy_photon_number_inequality`。共 20 个等权项。[统一协议](README.md) · [结构化表](EntropyPhotonNumber.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/paper.pdf)

只评 entropy_photon_number_inequality，任意有限 n≥1、两个独立端口上的任意有限能量 n-mode states，各端口内部允许纠缠。按论文固定所有辅助参数、仅ζ↓0的负极小值反证路线。ρ₀指thermal replacement后的辅助输出，原题ρC需最后识别。

一般无限维谱、闭二次型、迹和无界算子的域是实际验收内容，有限矩阵类比不足。 正文 regularization parameters ε,ζ与实验精度没有关系，需保持各步骤同一选择顺序。 此路线含较重的谱与插值模块，等权分数只解释为固定接口覆盖。

## EP01 · 热熵函数及配置下切逆

g(t)=(t+1)log(t+1)−tlogt在[0,∞)连续、严格递增、从0趋于∞。对s,t≥0，配置gInv的sInf下切定义满足gInv(g(t))=t、g(gInv(s))=s且gInv保序。

**允许前提**　连续延拓0log0=0。

**依赖**　无

**验收**　使用配置真正gInv，包括s=0，不允许只引入新抽象inverse。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/00-introduction.tex#L4-L8)

## EP02 · 统一能量集的紧性与熵连续性

对任意有限E≥0，{ρ:TrρN≤E}在trace norm紧，entropy连续且0≤Sρ≤n g(E/n)；每个有限能量ρ的normalized number truncations trace norm收敛、能量统一有界、熵收敛。

**允许前提**　任意n≥1的完整Fock空间states与N。

**依赖**　EP01

**验收**　覆盖任意非对角混态，不能把不同截断各自有限能量当共同上界。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/01-preliminaries.tex#L47-L77)

## EP03 · 被动混合的连续性和热参考输出

任意有限独立ports、λ_s≥0且Σλ_s=1的被动旋转保总number，retained energy≤总输入能量，channel对固定输入及旋转参数trace norm连续。热输入⊗τ_{r_s}的输出为τ_{Σλ_s r_s}，包括r_s=0。

**允许前提**　n-mode Fock、真实number-basis mixing unitary。

**依赖**　无

**验收**　连续性属于实际channel；thermal identity覆盖不同reference means。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/01-preliminaries.tex#L85-L103)

## EP04 · 负见证与辅助参数共同选择

若原EPNI失败，存在finite-number-supported严格违反pair。可依次选择r₁,r₂,r_D>0、λ_D>0、ε>0、κ>0，再得c,ζ₀>0，使所有0<ζ≤ζ₀的同一Jζ在固定witness上≤−c，并有(1+ε)Σ_iλ_i r_i≤r₀、(1+ε)Σ_iλ_i(r_i+1)≤r₀+1，κ还满足EP14的固定上界。

**允许前提**　原式严格违反，Jζ、r₀,w_i、三port/replacement按正文定义。

**依赖**　EP01、EP02、EP03

**验收**　固定witness和全部非ζ参数对所有小ζ共同有效，包含某输入entropy=0。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/03-minimization.tex#L7-L102)

## EP05 · Gibbs 谱正则性

对W=1+N、k>0、有界正B，闭型K=kW⁴+W^(1/2)BW^(1/2)、型域D(W²)定义自伴正算子且inverse compact；ω=e^(−K)/Tr e^(−K) faithful、TrωW⁷<∞，并在有限四阶矩态中唯一极小化TrσK−Sσ。

**允许前提**　完整Fock空间与原定义的型和迹。

**依赖**　无

**验收**　同时验型域、谱构造、Gibbs normalization与七阶矩，不能把这些作为任意谱数据假设。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/03-minimization.tex#L109-L174)

## EP06 · 负极小值存在且能量统一有界

对每个0<ζ≤ζ₀，Jζ在有限四阶矩输入pair上取得≤−c的min；所有这些min的输入能量有共同ζ无关上界。

**允许前提**　EP04同一参数和Jζ、热relative entropy恒等式与非负性。

**依赖**　EP02、EP04

**验收**　要有真实minimum及ζ统一energy界，不要求ζ统一四阶矩。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/03-minimization.tex#L199-L224)

## EP07 · 同一极小值的精确log identity

在EP06每个minimum，所有s=0,1,2,D states faithful、七阶矩有限，0≤H_s=−logρ_s≤C_sW_s⁴且H₀≤CW₀；真实slice T_i满足[(1+ε)w_i/h_i]H_i=[(1−κ)/h₀]T_iH₀+εw_iN_i+ζW_i⁴+c_iI。

**允许前提**　EP05、EP06的相同minimum、thermal replacement；允许C_s随ζ变化。

**依赖**　EP05、EP06

**验收**　以Gibbs minimizer识别原minimum，不能分别选择满足不同identity的谱basis或states。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/03-minimization.tex#L178-L197)

## EP08 · entropy Hessian 的实际slice界

对该minimum i=1,2，centered slice L_i满足||L_iZ||_i²≤(1+ε)/(1−κ)||Z||₀²，并延拓至completed centered spaces，bounded Z上的延拓等于真实slice。

**允许前提**　EP07的精确log identity、正文logarithmic-mean norm和centered test定义。

**依赖**　EP07

**验收**　须由finite-eigenblock二阶变分导出，校验extending map仍是actual observable slice。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/03-minimization.tex#L315-L325)

## EP09 · 插值核的正 Stieltjes 表示

令f(x)=x/sinhx、b(x)=xcothx，B(f(x)²)=b(x)。证明B在正轴和upper half-plane的指定解析延拓且B(1)=1,B′(1)=−1，并存在c≥0和正measureν使−B′(s)=c+∫(s+r)⁻¹dν(r)>0、∫(1+r)⁻¹dν<∞。

**允许前提**　正文B在(0,1)上的初始定义及连续端点。

**依赖**　无

**验收**　给正measure与收敛，形式有理代数或数值验证不足。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/02-interpolation.tex#L149-L162)

## EP10 · 四权重比较的插值闭包

对固定coordinate Hilbert spaces与test space T，若各Z仅涉及有限多(m,x,y)值且T对这些参数函数乘法不变，四个weights mf(x)e^±x、mf(y)e^±y均满足Q₀≥Σ_iw_iQ_i(L_iZ)，则F=mf(x)f(y)/f(x+y)也满足比较。

**允许前提**　m>0、x,y实、w_i>0；同一T与L_i。

**依赖**　EP09

**验收**　允许centered finite matrix带无限identity tail，不能增强为有限coordinate support。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/02-interpolation.tex#L15-L49)

## EP11 · thermal metric 的共同比较与上下界

在同一minimum，R_{s,+},R_{s,−},r_s,r_s+1四families均满足Σ_iw_i||L_iZ||²≤||Z||²。以m=1/h_s,x=h_sv_s/2,y=−h_s/2应用EP10，得F_s(v)=h_s⁻¹ f(h_sv/2)f(−h_s/2)/f(h_s(v−1)/2)，满足comparison且存在只依赖r_s的0<c_s≤F_s≤C_s<∞。

**允许前提**　EP04 slack、EP08 slice bound与跨ports独立；正文modular frequencies。

**依赖**　EP08、EP10

**验收**　四比较与F均用同一minimizer实际slice，覆盖连续奇点v=1。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/04-metric.tex#L19-L88)

## EP12 · dual defect norm 与绝对log sums

在每个minimum，q_s有有限dual norm。令K_{s,lr}=(r_s+1)p_r−r_sp_l，则||q_s||*²=Σ_{j,l,r}(1−v_s(l,r))K_{s,lr}|d′_{s,j;lr}|²；把系数换成|K|或|vK|的和均有限。

**允许前提**　EP07七阶矩、EP11共同metric与实际slice；q为centered thermal defect。

**依赖**　EP07、EP11

**验收**　以同一minimizer谱数据证明绝对收敛与dual表示，给后续无界generator合法换序依据。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/04-metric.tex#L137-L194)

## EP13 · 实际slice 的 weak convolution identity

对任意bounded output observable Z，q₀,j(Z)=Σ_iw_iq_i,j(L_iZ)+κ(1−κ)conj(μγ,j)Tr[(γ−τ_r₀)Z]。

**允许前提**　EP07七阶矩、EP11共同metric与实际slice；q为centered thermal defect。

**依赖**　EP07、EP11

**验收**　使用同一真实passive channel与replacement及弱迹对偶，处理discarded unbounded mode的cutoff，所有bounded Z成立。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/04-metric.tex#L196-L239)

## EP14 · 缺陷的统一dual控制

令A*²=Σ_iw_i||q_i||*²，M*²=Σ_iw_i|μ_i|²，C₀=(h₀ infF₀)^−1/2，则||q₀||*≤A*+sqrt(2κ)C₀M*。当0<κ≤ε²/[4(ε+2)C₀²]时||q₀||*²≤A*²+(ε/2)(A*²+M*²)，统一于ζ与minimum。

**允许前提**　EP07七阶矩、EP11共同metric与实际slice；q为centered thermal defect。

**依赖**　EP11、EP12、EP13

**验收**　由weak convolution与同一metric比较推出，κ上界仅依赖先前固定reference参数和ε，符合负见证选择顺序。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/04-metric.tex#L241-L291)

## EP15 · 无界generator covariance 与精确stationarity

在同一minimum，δ_s=𝓛_sρ_s traceless且W_s²δ_sW_s² trace class，δ₀=(1−κ)Σ_iΦ_iδ_i，log slicing合法。因此σ_s=Trδ_sH_s/h_s满足0=σ₀−(1+ε)Σ_iw_iσ_i+εΣ_iw_iTrδ_iN_i+ζΣ_iTrδ_iW_i⁴。

**允许前提**　EP07七阶矩和log identity；正文thermal relaxation 𝓛_s。

**依赖**　EP07

**验收**　证明weighted cutoff极限和所有迹存在，不能额外假设ρ+tδ两侧保持正。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/05-stationarity.tex#L3-L107)

## EP16 · entropy production 的dual恒等式

对每个s，σ_s=||q_s||*²−(e′_s−nr_s)，e′_s=Trρ_sN_s−|μ_s|²。

**允许前提**　EP12 的绝对 log 求和界、EP15合法generator/log pairings。

**依赖**　EP12、EP15

**验收**　在同一eigenbasis计算并证明creation/annihilation交换带来的n，禁止仅形式迹换序。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/05-stationarity.tex#L109-L153)

## EP17 · 精确能量抵消及缺陷消失

Trδ_iN_i=−(e′_i−nr_i)−|μ_i|²，moment drift sum P≤C且C与ζ无关；e′₀−nr₀=Σ_iw_i(e′_i−nr_i)+κ(1−κ)|μγ|²。代入同一stationarity给0=||q₀||*²−(1+ε)A*²−εM*²−κ(1−κ)|μγ|²+ζP，从而0≤−(ε/2)(A*²+M*²)+Cζ。

**允许前提**　EP14、EP15、EP16及输入ports独立、固定thermal auxiliary。

**依赖**　EP14、EP15、EP16

**验收**　各能量项用同一means和same replacement，保留精确identity再推不等式，得到均值和defects一起趋0。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/05-stationarity.tex#L155-L204)

## EP18 · trace-norm 极限识别为完整热态

由统一energy选ζ_k↓0的共同subsequence，两inputs trace norm趋ρhat_i。对固定finite-number-block测试，EP17使q→0和μ→0，得到(r_i+1)d_jρhat_i=r_iρhat_i d_j的number-matrix recurrence。逐坐标迭代杀掉全部offdiagonal并固定diagonal比例，trace1给ρhat_i=τ_{r_i}。

**允许前提**　EP02、EP06统一能量及EP11对固定测试的统一metric控制。

**依赖**　EP02、EP06、EP11、EP17

**验收**　不额外要求energy或unbounded first moments收敛，排除任意内部correlations，two inputs取同一subsequence。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/05-stationarity.tex#L206-L238)

## EP19 · 仅ζ极限与负min反证闭合

沿EP18共同subsequence，真实raw output及replacement均趋τ_r₀，三entropy用共同energy界收敛，使Jζ的entropy portion趋0；relative entropy与ζ第四矩penalties非负，故liminf Jζ≥0，与Jζ≤−c冲突。得到所有finite-energy inputs的0<η<1原不等式，η=0,1为对应输入等式。

**允许前提**　EP03 thermal mixing、EP04固定非ζ参数、EP18热极限。

**依赖**　EP02、EP03、EP04、EP18

**验收**　只需penalties非负，无需断言penalties趋0；不可将另一个regularization极限替代共同ζ极限。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/05-stationarity.tex#L240-L256)

## EP20 · 独立核验原配置无限维根

对任意n≥1、State n上的ρA,ρB,ρC、FiniteEnergy ρA/ρB、η∈[0,1]及原IsBeamSplitterOutput，证明η*gInv(entropyρA/n)+(1−η)*gInv(entropyρB/n)≤gInv(entropyρC/n)。

**允许前提**　仅配置根原始State、entry/cfc entropy、HasSum partial trace定义与前提。

**依赖**　EP01、EP19

**验收**　固定环境直接核验 entropy_photon_number_inequality，识别实际number-basis channel与任意给定ρC；所有依赖无额外axiom。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/The-entropy-photon-number-inequality-September-24-2026/build/sections/00-introduction.tex#L10-L29)
