# OneWayLiveness 的论文形式化验收表

配置根为 `OAI.OneWayLiveness.main_theorem`。共 12 个等权项。[统一协议](README.md) · [结构化表](OneWayLiveness.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/main.pdf)

论文匹配图表示、关系幺半群商、共同支撑放大链路线。 独立核验题面原根的同一 h+3 状态 NFA 及全部 DMachine 下界；最后一项为根组装且计入分母；任意路线根通过则整题记 1，不另加第 N+1 项。 将 v1 巨大的 RankLossAt 拆为同一链的支撑上界及较小关系角逐步下界，保留强归纳闭合。

这是按正文构建的评估端命题草案，尚未逐条 Lean 编译或候选盲标。 OWL03 合并同一匹配代数工具包，OWL08 合并强归纳闭合与解除提升假设；两项内部难度仍不均衡，不能把比例解释为剩余工作时间。 正文行号锚定上游固定稿；符号 D_m、R_H、R_e 的表示适配须保持全部数学性质。

## OWL01 · 后继汇点分支与树巡游

有限偏函数 σ 的无后继点 t 所在无向多重图分支恰由有限次 σ 迭代到达 t 的点组成，且为树。任意非空有限树上由各顶点循环次序定义的有向边巡游只有一个循环，剪开两个不同叶端连接后得到两条各自连接这两个叶端的路径。

**允许前提**　有限顶点集、任意偏函数及无后继点 t；巡游子结论的输入为任意非空有限树及每个顶点的循环次序。

**依赖**　无

**验收**　须证明两个通用图论结论及全部循环次序的量词；不得假设输入机器停机或所有分支都为树。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/machines.tex#L56-L165)

## OWL02 · 逐字母局部匹配图表示

任意 s 状态题面确定机 D 及接受约定 positive，存在同一字母图映射 η 到 degree k 的匹配幺半群，k=4(s+1)^2（允许零步）或 4(s+2)^2（正步）。对每个输入 w，D 接受 w 当且仅当 η(左标记)η(w)η(右标记) 将一个左测试端口连接一个右测试端口。

**允许前提**　题面 DMachine 的局部转移、边界限制与接受定义。 OWL01 的完整结论。

**依赖**　OWL01

**验收**　η 只能依赖 D、positive 和当前符号；须覆盖空字、stay、未定义转移、无限拒绝运行、初始接受及两个约定，端口数须为所列精确界。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/machines.tex#L21-L39)

## OWL03 · 匹配幺半群的秩、支撑与角缩减

匹配图乘法结合并有单位元；rank(ab)≤min(rank a,rank b)，m-rank a≤|supp a|，单位恰为满秩图，固定支撑构成子幺半群。对任意幂等 e∈D_m、r=rank e，存在保秩的有单位单射 R_e:eD_me→D_r，|supp e|≤2(m-r)，且对每个 J⊆[m] 存在同一个 J′⊆[r]、|J′|≤|J|，使所有 supp a⊆J 的 a 同时满足 supp R_e(eae)⊆J′。

**允许前提**　按论文定义的完全匹配图、端口粘合乘法、横截秩及固定横边支撑。

**依赖**　无

**验收**　共同 J′ 的选择必须先于 a；角缩减必须保绝对秩及单位。仅为各 a 单独给支持集不足以验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/matching.tex#L11-L125)

## OWL04 · 最小秩角提供置换提升

S⊆D_m 非空乘法封闭、φ:S→M 为满乘法映射、q∈M 幂等，则存在幂等 e∈S、φ(e)=q，且 R_e(eSe)→qMq 为有单位满同态。若 e 在 q 的全部幂等原像中秩最小，qMq 的每个单位均有该缩减角内的置换图提升。

**允许前提**　S、φ、q 满足所列条件；OWL03 的角缩减。

**依赖**　OWL03

**验收**　须覆盖原 S 不含环境单位的情形，最小秩取自整个原像集合；提升应属于同一个缩减角。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/matching.tex#L235-L252)

## OWL05 · 关系角的显式同构

P∈R_H 幂等，F⊆H，i=Id_F 且 iPi=i，令 Q=PiP。则 Q²=Q、PQ=QP=Q，Z↦iZi 为 Q R_H Q→R_F 的有单位同构，逆为 A↦PAP=QAQ。

**允许前提**　有限 H、关系按路径次序相乘及所列 P,F 条件。

**依赖**　无

**验收**　证明双射、乘法与单位，不能只给关系集合间的双射。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/matching.tex#L286-L299)

## OWL06 · 同一放大链的共同支撑预算

在秩损失定理的输入下，h≥33，令 c=m-rank a。存在互不相交的 16 元集 U,V 和点 z、32 个 a 的置换共轭、同一 b₀ 角中的 256 个生成元以及嵌套幂等 b₀,…,b₂₅₆，其关系像依次为 Id_(H\{z}) 加上 U×V 的前 ℓ 对。令 Δℓ=rank b_(ℓ−1)−rank bℓ≥0，则同一缩减坐标系下全部生成元支撑于一个 |J₀|≤64c 的集合，并且 ΣΔℓ≤64c。

**允许前提**　h≥33；S⊆D_m 含单位，φ:S→R_H 为有单位满射，所有 H 置换可提升为 S 的置换图；a 幂等且 φ(a)=Id_H∪{(x,y)}、x≠y。 OWL03–OWL04 的完整结论。

**依赖**　OWL03、OWL04

**验收**　必须提交同一 b 链、共同 J₀、全部关系像与总预算的证明。各生成元独立的小支撑或另一条链的预算不能验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/rank.tex#L58-L167)

## OWL07 · 逐次秩损失的较小关系角

沿 OWL06 的同一链，若秩损失定理已对每个 2≤h′<h 成立，则每个 1≤ℓ≤256 满足 2Δℓ≥2^floor((h−33)/31)。为每步构造 |F|=h−31 的完整关系幺半群满射角及置换提升，单关系添加的幂等提升 v 满足 |supp v|≤2Δℓ。

**允许前提**　OWL06 的完整兼容构造；h≥33。 OWL03–OWL05 的完整结论。 仅允许对所有较小 h′ 的秩损失归纳假设，原定理在 h 本身不得作假设。

**依赖**　OWL03、OWL04、OWL05、OWL06

**验收**　缩减到整个 R_F，须证明满射、单位、最小秩提升及 F 大小；针对部分生成关系的满射不足以应用归纳。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/rank.tex#L170-L280)

## OWL08 · 闭合强归纳的指数秩损失及除子度数下界

任意 h≥2、含单位 S⊆D_m、有单位满射 φ:S→R_H 且所有 H 置换有置换图提升时，若 a 幂等且 φ(a)=Id_H∪{(x,y)}、x≠y，则 m-rank a≥2^floor((h−2)/31)。进一步，任何含单位 S⊆D_k 到 R_H 的有单位满射都满足 k≥2^floor((h−2)/31)，无需另假设置换提升。

**允许前提**　OWL03–OWL07 的完整结论。

**依赖**　OWL03、OWL04、OWL05、OWL06、OWL07

**验收**　须证明 2≤h<33 的基例、h→h−31 的递推算术和无条件强归纳闭合；再用最小秩角解除提升假设，不能只交付归纳步。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/rank.tex#L25-L353)

## OWL09 · 同一小型单向非确定机识别全部输入

对每个 h≥2，构造同一 NMachine(Alphabet h)(h+3)，没有左移动，且对每个 positive:Bool 和每个有限字 w，N 接受 w 当且仅当关系积非空。

**允许前提**　题面关系乘法、OWL h、NMachine 运行及接受定义。

**依赖**　无

**验收**　同一 N 同时满足两种接受约定；证明所有字的正反向识别、边界条件、空字及精确状态数。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/separation.tex#L10-L33)

## OWL10 · 识别图给出整个关系幺半群的商

对识别 OWL_H 的确定机及 OWL02 的表示，体字母图生成的含单位子幺半群 S⊆D_k 存在有单位满射 φ:S→R_H，满足 φ(η(w))=w 的关系积。

**允许前提**　H 非空；机器对全部字正确识别；OWL02 的同一个 η 及固定端标记。

**依赖**　OWL02

**验收**　证明 η(u)=η(v)⇒关系积相同，使用单点选择关系分离不同条目；须覆盖空字、单位保持、乘法与满射。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/separation.tex#L37-L47)

## OWL11 · 机器状态的最终指数下界

对全部 h≥2、positive、s 及识别 OWL h 的题面 DMachine，2^((h−2)/31)≤4*(s+(if positive then 2 else 1))²，其中除法为自然数整除。

**允许前提**　OWL02、OWL08、OWL10 的完整结论及同一机器表示。

**依赖**　OWL02、OWL08、OWL10

**验收**　将同一 k 的图表示、商映射、除子度数界组合，保留两个接受约定及 h 的完整量词。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/separation.tex#L79-L93)

## OWL12 · 组装原配置根

对每个 h≥2，存在同一 h+3 状态无左移动 NFA，同时满足两种接受约定的 OWL h 识别；且任意 positive、s 和识别该语言的 DMachine 满足 OWL11 的状态下界，合为原 main_theorem。

**允许前提**　OWL09 与 OWL11 的完整结论。

**依赖**　OWL09、OWL11

**验收**　组合两个分支，NFA 见证在 positive 前选择；由原题 checker 独立验收根。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/An-exponential-two-way-deterministic-state-lower-bound-for-one-way-liveness-September-25-2026/build/sections/separation.tex#L79-L93)
