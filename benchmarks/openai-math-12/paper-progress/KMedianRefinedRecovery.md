# KMedianRefinedRecovery 的论文形式化验收表

配置根为 `OAI.MetricKMedianRecovery.RefinedRecovery.refined_recovery`。共 10 个等权项。[统一协议](README.md) · [结构化表](KMedianRefinedRecovery.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/paper.pdf)

只评 refined_recovery。固定 bound、ε>0、L₀>0、0<μ≤min(1/4,ε/12)，输入为不交客户/设施、正整数且由 bound(N) 有界的距离、大小h的 anchor S。Certificate 仅供证明，算法不接收 O、P、good/bad 或 proxy。按论文 refinement 的双阶段采样和 completion 路线。

此表测论文专门证书恢复路线；配置根允许其他算法绕过部分里程碑。 论文算法到 BinaryRandomizedAlgorithm 的统一机器、有限工作字母表和实际编码桥接仍需实现验收。

## KM01 · 可计算半径和共同盲采样实验

对 m>0、整数成本猜测 P>0，构造只依赖可见输入的 r⁰(w)=min{z≥0:z·|D∩B(w,z)|≥P/m} 和有限半径菜单。对正确近客户 leader w_i，可选半径 r_i≤R_i≤(1+κ)r_i+κr⁰(w_i)，其中κ=μ³；所有前缀保留。

**允许前提**　输入度量、正确 m,P 分支；固定 tie order。

**依赖**　无

**验收**　给可执行菜单与完整采样分布，菜单选择不能访问隐藏 comparison。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/sampling.tex#L55-L176)

## KM02 · 整条轨迹的半径概率预算

对覆盖互异坏簇、至多2m步的同一引导轨迹，正确半径菜单指标的总代价为 O_μ(m)，且Σ_{i∈A}n_i r⁰(w_i)≤11P/2。因此半径猜测联合概率≥exp(−O_μ(m))。

**允许前提**　leader 属于对应 N_i¹ 或 N_i²，a₁≤a₂=3/2；同一持久叶球轨迹。

**依赖**　KM01

**验收**　需要轨迹整体摊还，逐步多项式概率乘积的较弱界不能替代单指数界。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/refinement.tex#L173-L191)

## KM03 · 首阶段的可见采样质量下界

令a₁=1+μ，q=μ/(1+μ)，T(H)=Σ_{i∈B}Σ_{p∈N_i¹}d(p,H)，I(H)=Σ_{s∈S₀\Q}Σ_{p∈J_s(H)}d(p,H)。证明 W(H)≤6P+T(H)/q，任一未满足停止条件的正确 ball/removal 模式事件概率≥ρ_μ=κ/[2(6+κ/q)]。

**允许前提**　证书 proxy 误差≤μP，κ=μ³，0<μ≤1/4；前缀球保持正确半径。

**依赖**　KM01

**验收**　同时控制同一 H 下全部客户权重和选定事件，包含 W=0 的停止情况。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/refinement.tex#L110-L158)

## KM04 · 双阶段共同终点

盲实验至多2m步，以≥exp(−O_μ(m))概率产生同一较早 H⁰ 与最终 H。H⁰ 后不再删除，Σ_{i∈B⁰}T_i≤κP、Σ_{p∈J⁰}d(p,H⁰)≤κP；第二阶段仅覆盖 f_i=|C_i∩J⁰|/n_i<1/3 的簇且 leader∈N_i²；最终J⊆J⁰、Σ_J d(p,H)≤κP、Σ_{i∈B,f_i<1/3}Σ_{N_i²}d(p,H)≤κP，且保留 KM02 半径总界。

**允许前提**　KM03 的进展事件和 KM02 的半径预算；固定 assignments/tie order；隐藏 guide 用于分析。

**依赖**　KM02、KM03

**验收**　H⁰,H,Q,A¹,A² 必须来自同次实验，分别存在两个成功前缀不能验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/refinement.tex#L65-L108)

## KM05 · 分区子模 completion 的可行实现

对任意合法前缀及 rational θ∈(1/e,1)，存在只用 S,m,Q、球数据的 completion 算法，始终输出≤h个真实设施，工作 exp(O(m))poly(N,1/(θ−1/e))；存在概率≥exp(−O(m))的 colors/labels 事件，条件于每个该事件实现，Ecost(U)≤2I+Σ_{p∈J}c_p+Σ_{p∉J}b_p，其中 c_p 按 good/A/B 分段，b_p=θd(p,H)+(1−θ)min{d(p,H),d(p,X*)}。

**允许前提**　合法前缀及比较中心包含于各自球；c_p、X* 用于分析而非输入。

**依赖**　无

**验收**　输出预算与条件期望必须属于同一算法，需可执行分区优化与 surrogate realization。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/completion.tex#L332-L368)

## KM06 · 覆盖簇的精细收费

对 KM04 同一终点，good 总收费≤P_g+μP。第一阶段覆盖簇收费≤(1+2θa₁)P_i+θκa₁P_i+θκn_i r⁰(w_i)。第二阶段覆盖簇以x_i=|C_i∩J|/n_i≤f_i<1/3 得≤(1+2θ)P_i+θκa₂x_iP_i+θκx_i n_i r⁰(w_i)+T_i/q。

**允许前提**　KM05 客户收费定义，1/e<θ≤1/e+μ，KM04 终点。

**依赖**　KM04、KM05

**验收**　第二阶段需真正使用 J⊆J⁰，全部费用对应同一 comparison 分簇。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/refinement.tex#L234-L282)

## KM07 · 未覆盖簇收费和全局误差只计一次

对 f_i≥1/3 与 f_i<1/3 两组剩余簇，分别得收费≤(1+2a₁/3)P_i+T_i/q+E_i±，两组E总量各≤κP。把 disjoint T_i、半径误差和2I相加，得completion期望≤[1+2θa₁+μ+11κ+κ/q]P≤(1+2/e+6μ)P。

**允许前提**　KM04,KM06；空簇费用为0。

**依赖**　KM04、KM05、KM06

**验收**　各误差按共同分组全局相加，不能为不同构造分别验收局部费用。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/refinement.tex#L284-L348)

## KM08 · 单次恢复的成功概率

在正确 P,m 分支，一次完整 trial 同时取得正确终点与 colors/labels 后，由非负成本和 μ≤ε/12 得目标cost≤(1+2/e+ε)P的条件概率≥ε/[2(1+2/e+ε)]；合成总成功概率≥exp(−O_{μ,ε}(m))。m=0 时直接 S 成本≤(1+μ)P。

**允许前提**　KM04–KM07 的相同 trial 与独立 completion 随机性。

**依赖**　KM04、KM05、KM07

**验收**　须合成实际同一次 trial 的联合成功，不能乘缺乏条件保障的概率。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/refinement.tex#L352-L376)

## KM09 · 枚举隐藏参数并放大

枚举P∈{1,…,|D|Δ}与m≤min(h,floor(L₀log N))，对每个分支保留所有前缀与可行候选，重复 exp(O_{μ,ε}(L₀log N))log(1/ζ)次，取最便宜可行解。对每个给定的有效证书，算法达到该证书成本阈值的成功概率均≥1−ζ，固定参数下每条随机路径耗时poly(N,log(1/ζ))。

**允许前提**　Δ≤bound(N)，0<ζ<1；同一可执行算法与 KM08 概率界。

**依赖**　KM08

**验收**　算法无需识别成功guide或证书，复杂度覆盖错误猜测与所有随机路径。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/refinement.tex#L378-L392)

## KM10 · 独立核验配置根与编码机器

对所有配置 bound,ε,L₀,μ 的原前提，构造同一 BinaryRandomizedAlgorithm A，证明 PolynomialWork A bound；对所有有界 Input 与ζ∈(0,1)，每个 Seed 输出 Feasible，且对每个 Certificate I μ L₀，successProbability A I ζ ((1+2/exp(1)+ε)cost(C.centers))≥1−ζ。

**允许前提**　配置根原始定义；已验收的算法与有限位实现。

**依赖**　KM09

**验收**　在固定环境闭合 refined_recovery，核对 queryBits、seedLength、actual run、有限工作字母表与 workBound；证书不能成为算法额外输入。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/Single-Exponential-Recovery-and-Bounded-Price-Strictness-for-Metric-k-Median-September-24-2026/build/sections/introduction.tex#L47-L74)
