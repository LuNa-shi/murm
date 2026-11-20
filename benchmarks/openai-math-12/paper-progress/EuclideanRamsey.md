# EuclideanRamsey 的论文形式化验收表

配置根为 `OAI.EuclideanRamsey.classification`。共 13 个等权项。[统一协议](README.md) · [结构化表](EuclideanRamsey.json) · [固定论文](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/paper.pdf)

论文张量障碍、有限格点消去、平滑有理化、双尺度构形、自由群修正与同端点路径路线。 原题原 checker 独立核验 Ramsey(a)↔FieldCriterion(a)，ER13 为原根组装并计入分母，任意路线 root 通过置 1，不另加第 N+1 项。 工具项明确限定为当前构形及当前证书的全部必要实例，避免将推广到任意抽象对象作为给分条件；合并仅为同一接口服务的机械步骤。

这是命题草案，尚无逐条 Lean 检查和人工评分一致性验证。 路径判据内超滤子/Hales–Jewett 仍是较大证明单元；启用前须固定实际基础事实，不能把尚未提供的背景结论免费算作输入。 不同证明路线可独立获得 root 满分；中间覆盖只在当前论文路线内解释，未证明路线无关。 ER13 与 root 数学结论相同，是原根组装项并计入固定分母；所有项通过仍须原 checker 对根验收。

## ER01 · 坐标域矩阵与实对称张量的等价

对当前构形 a，题面 FieldCriterion(a) 等价于存在对称 T∈W⊗ℚW，W=ℝ×ℝ^d，满足每个 i 的 (e_i⊗e_i)T=0∈ℝ⊗ℚℝ 以及梯度块 G(T)=I_d，其中 e_i(v,u)=v+a_i·u。

**允许前提**　题面 s≥2,d≥1、a 单射且仿射张成全空间；坐标域 F 由 a 的全部坐标生成。

**依赖**　无

**验收**　双向证明，实系数下降至 F⊗ℚF 时须同时保存所有张量零评价和同一个单位空间块；乘法后零不足以代替张量零。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/02-tensors.tex#L9-L102)

## ER02 · 张量失败给出统一分离障碍

若当前 a 的 ER01 张量条件失败，则存在 h_i:ℝ→ℝ 与 ℚ 线性 L:Sym_d(ℝ)→ℝ，L(I_d)=1，对全部 v,u 有 Σ_i h_i(v+a_i·u)+L(uuᵀ)=0 且全部 x 有 Σ_i h_i(x)=0。对任意 D 与全等副本 b，令 H_i(z)=Σ_(j≤D)h_i(z_j)，有 Σ_iH_i(b_i)=−1。

**允许前提**　当前构形的题面条件与张量条件失败；允许 ℚ 向量空间基选择，不允许额外正则性假设。

**依赖**　无

**验收**　证明分离泛函、同一组函数的两个恒等式及每个全等副本的 −1 障碍；全等到同一仿射等距映射须实际证明。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/02-tensors.tex#L151-L202)

## ER03 · 统一有限着色排除全部维度并得必要方向

ER02 条件下，令 K=2s+1，按 (H_i(z) mod 2) 所在的 K 个半开区间编号组成颜色，得到每个 D 都适用的至多 K^s 色着色，且无 a 的单色全等副本。因此 Ramsey(a)⇒FieldCriterion(a)。

**允许前提**　ER01–ER02 的完整结论；当前 a 与同一 h_i,L。

**依赖**　ER01、ER02

**验收**　颜色上界先于 D 固定；每个颜色与任意同色点族须排除总和 −1；对每个 D 构造一个遵守同一色数上界的着色，并对所有全等副本证明非单色。此着色无需可测。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/02-tensors.tex#L203-L224)

## ER04 · 张量证书的有限有理格点矩表示

当前 a 的 ER01 张量证书可写为有限个仿射向量 w_j=(v_j,u_j) 和同一个对称有理 C，U 的列为 u_j，UCUᵀ=I_d。令 Γ=ℤ^k，Λ_i={γ:e_i(Σγ_jw_j)=0}，则存在同一有限支撑 ν:Γ→ℚ，在每个 Γ/Λ_i 上推前为零，且 Σν=0、Σνγ=0、Σνγγᵀ=C。

**允许前提**　ER01 的实际 T；允许先取其因子的有限 ℚ 基，k≥1。

**依赖**　ER01

**验收**　同时保留全部评价余类的消去和精确二阶矩；只给乘法后的实数零或单个 i 的 ν 不通过。该项只要求当前证书的实例，无需推广至任意格子。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/03-stencil.tex#L9-L67)

## ER05 · 小负二阶质量的紧支撑平滑

对 ER04 的同一 C,U 及任意 η>0，存在 b∈C_c^∞(ℝ^k)、b≥0、∫b>0，使 ∫(D_C b)_−(x)||Ux||² dx<η∫b，其中 D_C=1/2ΣC_jl∂_j∂_l。

**允许前提**　C 对称，UCUᵀ=I_d，d≥1；ER04 的固定 C,U。

**依赖**　ER04

**验收**　须交付当前 C,U 下所有 η>0 的函数及积分界；高斯函数须完成截断到紧支撑的误差控制。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/04-pairs.tex#L34-L52)

## ER06 · 有限有理权重保持精确消去并压低负部

给定 ER04 的同一 ν,Γ,Λ_i,C,U，对任意 η>0 存在 n≥1、有限支撑 μ:Γ→ℚ、ζ∈ℚ>0，使所有 Λ_i 的推前同时为零，Σμ(λ)(λ/n)(λ/n)ᵀ=ζC，且 Σμ(λ)_−||Uλ/n||²<ηζ。

**允许前提**　ER04–ER05 的完整结论。

**依赖**　ER04、ER05

**验收**　有理近似须保持全部精确线性等式及同一 μ；只提供实权重、近似消去或分别存在的 μ 不通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/04-pairs.tex#L151-L174)

## ER07 · 同一精确双尺度构形与逐点坐标置换

在当前 a 的张量证书下，对每个 η>0 存在同一 ℓ≥1、f_i,g_i∈ℝ^ℓ，使每对 i,j 有 ||f_i−f_j||²=||a_i−a_j||²、||g_i−g_j||²=q||a_i−a_j||²，q=η/(1+η)，且每个 g_i 是对应 f_i 的坐标置换。

**允许前提**　ER04–ER06 的完整结论；当前 a 的张量条件。

**依赖**　ER04、ER05、ER06

**验收**　用同一有限权重恢复两组行及共同 Gram 补齐；精确距离、相同 ℓ 和每个标签的坐标多重集相同必须同时成立。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/04-pairs.tex#L8-L25)

## ER08 · 当前构形的单坐标右分式修正

令 E=ℝ^(ℕ) 有限支撑，K 为以 ξ_z(z∈E) 为生成元的自由群，M⊆K^s 由对角元和当前 a 的单位尺度副本元生成，degree 数副本因子。N=ker(K→ℤ,ξ_z↦1)。其导出列定义为 N^{(0)}=N，N^{(r+1)}=[N^{(r)},N^{(r)}]。令 L_i={g:g^[i]=uv^(−1),u,v∈M}，c_i 为最小 degree(u)+degree(v)。则 L_i 为正规子群、c_i 对逆与共轭不变且次可加，N^{(s−2)}⊆L_i；任意 g_i∈L_i 的元组有成本≤Σ_i c_i(g_i) 的同一右分式。

**允许前提**　当前 a 单射且 s≥2；题面距离定义；degree 依赖选择的表达式。

**依赖**　无

**验收**　须在当前构形的 M 内证明两坐标投影含 N×N 及所有构造；不能假设全部 MM^(−1) 自动成群，不能用抽象 pair 条件而未验证其实例。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/06-groups.tex#L13-L108)

## ER09 · 有限坐标群平均的共同轨道误差界

令 L=N^{(s−2)}、c(g)=max_i c_i(g)（g∈L）。对当前构形对应自由群和任意有限坐标置换群 H、有限 H 不变集 Z⊆E、δ>0，存在同一元组 w∈K^Z 及对角/轨道生成元的表达式，degree=m>0，使全部同轨道 x,y 满足 w_xw_y^(−1)∈L 且 c(w_xw_y^(−1))≤δm。

**允许前提**　ER08 的完整群与成本结论；H 有限，Z 有限 H 不变。

**依赖**　ER08

**验收**　w、m、表达式须同时控制所有同轨道对；degree 必须来自同一表达式，不能对每对另选有利元组。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/06-groups.tex#L175-L209)

## ER10 · 精确双尺度配置转为同端点路径

给定同一 f,g、q>0，满足 ER07 所述全部距离和逐点置换条件，对每个 δ>0 存在两条 K^s 路径，端点完全相同，权重 λ>0、μ≥0 且 μ/λ≤q+sδ。路径因子只能为权重零的对角元或权重为其平方距离缩放的副本元。

**允许前提**　ER08–ER09 的完整结论；给定 f,g,q 的全部条件。

**依赖**　ER08、ER09

**验收**　在 f,g 全部轨道的同一平均表达式中修正各坐标误差，交付实际右分式 u,v、共同端点及成本界；仅近似端点不足。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/06-groups.tex#L295-L342)

## ER11 · 同端点两路径同步全部倒数权重

若当前 a 的同端点两路径权重 λ>0、μ≥0、ρ=μ/λ<1/n，n≥1，则存在同一端点 W∈K^s，使每个整数 1≤t≤n 都有权重恰为 1/t 的路径到 W。

**允许前提**　所列实际路径及其表达式；路径权重按副本因子的平方距离尺度相加。

**依赖**　无

**验收**　W 在选择 t 前固定；须覆盖 t=n、μ=0 以及保持实际端点相等，不能对每个 t 另给端点。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/05-paths.tex#L69-L104)

## ER12 · 同端点路径判据推出任意着色的有限维 Ramsey 性

若对每个 n≥1 存在同端点路径，权重 λ>0、μ≥0、μ/λ<1/n，则对每个 r≥2 存在 D≥1，使每个任意 r 色着色 ℝ^D 都有当前 a 的单色全等副本。

**允许前提**　当前 a 的全部 n 同端点小权重比假设；ER11 的完整同步结论；Hales–Jewett 仅在固定背景白名单明确已提供时可用，否则也须交付证明。

**依赖**　ER11

**验收**　须证明超滤子群角及同时实现引理，证明自由群路径可同时实现为同色有限字串、变位置数 t 后可取权重 1/t，并通过紧致性得到先于具体着色固定的 D；单独援引待证 path criterion 不能通过。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/05-paths.tex#L29-L66)

## ER13 · 充分方向与原分类闭合

FieldCriterion(a)⇒Ramsey(a)。对每个 n≥1 在 ER07 取 η=1/(4n)，在 ER10 取 δ=1/(4ns)，得到同端点权重比≤η/(1+η)+sδ<1/n，再应用 ER12。与 ER03 合成 Ramsey(a)↔FieldCriterion(a)。

**允许前提**　ER01、ER03、ER07、ER10、ER12 的完整结论；题面 s≥2,d≥1、单射与满仿射张成。

**依赖**　ER01、ER03、ER07、ER10、ER12

**验收**　保留原题坐标域、张量乘法和所有维度/颜色量词；充分方向须对每个 n 使用兼容的一组构形及路径，根定理仍独立由原 checker 验收。

[论文论证](https://github.com/openai/math/blob/4eaee87548250b2682affda7d05d947c05554bae/preprints/A-classification-of-finite-Euclidean-Ramsey-configurations-September-23-2026/build/sections/06-groups.tex#L346-L358)
