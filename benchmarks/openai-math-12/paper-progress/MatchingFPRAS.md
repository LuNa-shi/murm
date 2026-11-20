# MatchingFPRAS 的论文形式化验收表

配置根为 `OAI.MatchingFPRAS.thm_main`。共 18 个等权项。[统一协议](README.md) · [结构化表](MatchingFPRAS.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/main.pdf)

只评 thm_main/MainStatement。有限简单无向图、0<ε<1和0<δ<1/2均为有理精度参数。采用论文 logical holes→tree bags→pair energy→replica sampler→adaptive cooling→bounded-bit machine 的同一路线。

自由更换算法可绕过中间义务，正式比较需冻结此路线。 Pair energy 只能直接控制 f₁(A)+f₂(B)，完整产品链 Poincaré 必须另外证明。 论文 bit-cost 到配置 RandomMachine 单带逐步语义的桥接单独验收。

## MF01 · 逻辑孔洞的配对容量界

对偶数n≥2的正完全图活动λ，若每行最大二孔比r_i∈[1/4,1]，令B为瓶颈相似度、D₀=10⁸(n+1)⁴，则对每个偶数孔集U，g_λ(U)Φ_B(U)≤2D₀^{|U|/2}。

**允许前提**　g_λ(U)=Z_λ(−U)/Z_λ，Φ_B为最大配对B权乘积；λ balanced。

**依赖**　无

**验收**　任意偶数U统一成立，二孔/四孔特例不足验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L447-L484)

## MF02 · 细分图的权重双射

对论文同一正活动λ与路径profile构造，real图完美匹配与logical完美匹配双射，Z′=C₀Z_λ；非中心边的B′等于活动，中心边等于B_uv，邻接有效高度比≤2。

**允许前提**　路径长度4p+1、匹配权重和C₀按正文构造。

**依赖**　无

**验收**　双射、权重常数、height兼容属于同一细分图。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L752-L774)

## MF03 · 同一 marked bag law 的可观测恒等式

对同一bag匹配律及real/virtual/probe揭示，all-real概率1/I且条件解码law为π_λ；sole-probe uv概率g_λ(uv)/(DI)，其条件残余law为删uv的λ权匹配law。

**允许前提**　正λ、I=Z_bag/Z′、与 MF02 同一细分和probe构造。

**依赖**　MF02

**验收**　两个事件及解码来自同一marked sample，不能分别引入不相容分布。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L922-L958)

## MF04 · 删除孔洞的兼容记账与提升

对任意有real completion的偶数扩大孔集U，同一R,F(U),forbidden-edges满足R偶数、|R|≤|U|、Z′(−U)=C₀F(U)Z_λ(−R;E_br(U) forbidden)，并有F(U)Φ_B′(U)≤Φ_B(R)。因此 balanced λ 时任意偶数U有g′(U)Φ_B′(U)≤2D₀^{|U|/2}。

**允许前提**　MF01,MF02；阈值树及neutral-pair/consumed-terminal的正文定义。

**依赖**　MF01、MF02

**验收**　R与F来自同次删除记账，提升不允许改动底层阈值分区。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L1022-L1153)

## MF05 · bag inflation 受控

对 balanced λ 与 D=100N²D₀ 的同一bag构造，证明1≤I≤2。

**允许前提**　MF04 的孔洞容量界与正文虚边活动。

**依赖**　MF04

**验收**　须按虚边集合累加质量并与real partition比较，允许使用 MF04 全结论。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L964-L975)

## MF06 · 带标签的共同四边形剖分

对正文 label-tree 合法偶cycle C，每个admissible odd arc采用同一端点共同label，构造四边形剖分，每cell有一组对边good，若某组对边均long则另一组均good；cell数(m−2)/2、内对角数(m−4)/2，多项式可计算。

**允许前提**　tree bags 的邻接标签与cycle条件，固定每条内部对角共同label。

**依赖**　无

**验收**　两次出现的同一对角label必须一致，不能只给任意几何剖分。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L1373-L1390)

## MF07 · cell 恒等式与内对角抵消

对同一剖分及任意 f₁，逐cell有D_C=Δ+Σ_{J∈P}g_J−Σ_{J∈Q}g_J+E_P−E_Q，求和后D_C=Σ_cells(Δ+E_P−E_Q)。

**允许前提**　正文转换matching、canonical gain、context error定义。

**依赖**　MF06

**验收**　证明 complementary arcs 产生相同转换matching并抵消，不能假设context误差为0。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L1807-L1847)

## MF08 · demand 编码的权重与拥塞界

对每个switch/error demand，构造正文两matching编码，使ρ(d)≤A₀⁴π(A)π(B)，每种encoding和输出pair至多𝒯=(10N)³⁰个preimages；error的两个guide都包含C_X。

**允许前提**　同一MF06剖分、common-interval-clamped正活动，A₀=1000D。

**依赖**　MF06

**验收**　同时给可恢复编码、权重比较和全元数据计数，不能分别选择不同编码满足三性质。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L1859-L1874)

## MF09 · cycle swap 对context误差的控制

对正文Metropolis pair kernel、F(A,B)=f₁(A)+f₂(B)及误差demand定义，Σ_swap≤12N²𝓔(F)。

**允许前提**　tree-bag图存在colored matching；pair proposals为正文三类。

**依赖**　MF06、MF08

**验收**　证明每个long arc对应完整discrepancy cycle且固定fresh pair/cycle至多2N种closing-chord编码；不能仅对cycle子段做不合法swap。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2045-L2073)

## MF10 · 闭合加性pair能量不等式

对同一tree-bag图、参考活动或任意common-interval clamp及任意实函数f₁,f₂，Var_π(f₁)≤L𝓔((A,B)↦f₁(A)+f₂(B))，L=(10⁴ND)¹⁰⁰。

**允许前提**　tree-bag图存在colored matching；pair proposals为正文三类。

**依赖**　MF07、MF08、MF09

**验收**　组合cell cancellation、demand拥塞、swap sum与switch/color能量，保留任意f₂；全product Poincaré留待复制链证明。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2075-L2135)

## MF11 · 复制tier链的真正谱隙

对N≥2、D≥1、最大level≤2K、D⁻¹≤W_e≤3·4^K的同一tree-bag图，按正文T tiers、q=32L copies与更新数M构造lazy product chain，证明gap≥3/(8M)≥1/(20LM)。

**允许前提**　MF10 在相邻tier unequal pairs上的能量推论；bottom-tier exact refresh。

**依赖**　MF10

**验收**　以正交martingale/residual预算控制所有product函数，需同一product stationary law ν。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2319-L2418)

## MF12 · 显式有限步采样与理想计算

令Λ=10Nq(T+1)(K+ceil(log₂(ND+2))+1)，s(ξ)=ceil(20LM(Λ+ceil(log₂(1/ξ))+1))。从任一同colored matching初始化，s(ξ)步后product law距ν的TV≤ξ，top-tier边缘亦≤ξ；理想rational tables与transition多项式可计算。

**允许前提**　MF11 的同一chain；0<ξ<1；reference positive rationals。

**依赖**　MF11

**验收**　给初始最小概率与谱收敛，不能仅给渐近存在混合。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2422-L2447)

## MF13 · 冷却端点与缩放不改ratio

空图输出1，不可覆盖或无完美匹配输入输出0。其余n偶≥2，b=1+1/n，K=min{k≥1:n^{n/2}b^(−k)≤ε/32}。证明K多项式界、Z₀=(n−1)!!、Z_K=Z₀∏Z_{j+1}/Z_j，及λ_ij=w_ij^(j)s_is_j时Z_λ=Z_j∏s_i、g_λ(ij)=g_w(ij)/(s_is_j)，初始化balanced。

**允许前提**　显式稀疏输入和固定冷却/初始scales。

**依赖**　无

**验收**　覆盖二进制巨大孤立顶点数，零测试须为实际确定性程序。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2537-L2590)

## MF14 · 共同样本同时估ratio和二孔量

同一marked sample上a,d,z_ij∈[0,1]满足Ea=1/I、Ed=Z_λ+/(IZ_λ)、Ez_ij=Z_λ+(−ij)/(DIZ_λ)；因此R=Ed/Ea、g_λ+(ij)=DEz_ij/Ed。

**允许前提**　MF03，固定当前scales，u(P)=b^(−非边数)∈(1/2,1]。

**依赖**　MF03、MF13

**验收**　使用同一λ和同一sample law，下一stage仅变raw weights。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2592-L2640)

## MF15 · 成功stage保持balance并控制ratio

令α=10⁻⁵、σ=min(α/(100D),ε/(1000K))。若当前balanced且全部经验均值误差≤σ，正文截断G和one-pass v-update给下一stage balanced且|Rhat/R−1|≤10σ≤ε/(100K)；任何历史中update均定义、0<v_i≤2。

**允许前提**　MF05 inflation界、MF14观测恒等式；固定同批均值及零分母默认值。

**依赖**　MF05、MF14

**验收**　先验条件用于准确性，执行定义和界必须覆盖失败样本历史。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2639-L2771)

## MF16 · 自适应冷却的联合成功与放大

令S=ceil(10σ⁻²(n+K+1))、ξ=1/(1000KS)。每stage用S独立fresh样本各TV≤3ξ，则条件于此前全成功，当前失败概率≤13/(1000K)。整trial概率>0.9，Y=(n−1)!!∏Rhat为(1±ε)Z(G)近似。r=10(ceil(log₂(1/δ))+1)+1个独立trial中位数失败≤δ，零分支恒输出0。

**允许前提**　MF12 的有限位版本误差预算、MF13–MF15；同一自适应历史。

**依赖**　MF12、MF13、MF15

**验收**　需要首次失败条件联合界、末端padding偏差、独立trial，不能逐stage孤立成功代替。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2773-L2842)

## MF17 · 固定随机位实现和所有路径bit成本

有理categorical p₁,…,p_r 用恰k公平bits的网格采样，TV误差≤2r·2^(−k)，零概率类从不输出。将全部proposal/acceptance/refresh实现为有限位程序并分配整体TV≤3ξ预算；所有历史的整数位长、循环与存储固定多项式有界，总cost为poly(inputBits,ε⁻¹,logδ⁻¹)。

**允许前提**　正文有理权、无条件caps及有限输入；同一MF12 sampler和MF16 trial。

**依赖**　MF12、MF16

**验收**　任何拒绝/失败历史也按时终止，精确rational随机choice不能作为无限期oracle。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L2967-L3079)

## MF18 · 独立核验配置机器根

构造一个统一 RandomMachine A及全局常数C,d∈ℕ,C>0，对任意GraphInput及有理ε∈(0,1),δ∈(0,1/2)，t=timeBound C d：所有Fin t→Bool均在t内Outputs某非负rational；Z=0时所有tapes Outputs 0；goodTapes.card/2^t≥1−δ。

**允许前提**　配置原始encodeInput/encodeRat/tick/run/Outputs，及已实现有限位程序。

**依赖**　MF13、MF16、MF17

**验收**　直接核验 MainStatement 原目标，单一有限transition table、原输出编码与固定t；闭合所有依赖。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-Fully-Polynomial-Randomized-Approximation-Scheme-for-Perfect-Matchings-in-General-Graphs-September-23-2026/build/main.tex#L132-L144)
