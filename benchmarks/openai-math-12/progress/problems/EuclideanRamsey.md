# EuclideanRamsey：欧氏 Ramsey 构形的张量判别

**20 个固定评分项 · 需进一步确认**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](EuclideanRamsey.json)

## 目标与适用性

- 题目 ID：`oai_euclidean_ramsey`。
- 唯一计分根：`OAI.EuclideanRamsey.classification`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/EuclideanRamsey.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 参考证明两方向及其连接很清楚，能拆出 20 项。必要方向经分离函数和有限着色障碍；充分方向经格点矩、平滑、坐标置换、路径修正和有限维紧性。

**需要留意：** 有限格点恒等式、平滑定理和一般群平均在源码中都是泛化的工具定理；一个只针对当前构形的有效证明可能不产出这些更广的接口。若直接按通用定理的声明匹配，会漏记这种实质推进。

**下一步：** 先在沿本参考接口工作的实验中试用；正式横向比较前，为 ER08、ER09、ER15 写清可接受的实例化接口：须够后续使用，但不必额外证明对未使用数据的泛化版本。保持本版分母固定，不因实验的写法临时增减项。

## 参考证明主线

固定评分对象为 classification；它已经假设点互异、s≥2、d≥1、仿射张成全空间，后面的 full_affine_representative 和 classification_nonempty 不计分。η、δ 和路径比例是证明内部辅助量：各项要求对其完整量词成立，不按参数大小阶梯计分。最关键的拼接是同一有符号测度同时满足矩和消去条件，以及两条路径拥有完全相同的端点。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| ER01 | 全仿射张成的全等副本来自同一个等距仿射映射 | — |
| ER02 | 实张量判别失败给出分离函数 | — |
| ER03 | 任何仿射等距副本上分离函数总和固定为负一 | ER01、ER02 |
| ER04 | 有限取整着色排除负一总和 | — |
| ER05 | Ramsey 性迫使实张量判别成立 | ER01、ER02、ER03、ER04 |
| ER06 | 实系数与坐标域上的判别双向兼容 | — |
| ER07 | 张量证书转成共同的有理矩阵和格子数据 | ER06 |
| ER08 | 共同商张量消失得到有限支撑的格点矩证书 | ER07 |
| ER09 | 构造负二阶质量任意小的紧支撑平滑函数 | — |
| ER10 | 平滑后仍严格保持所有代数约束 | ER08、ER09 |
| ER11 | 有符号权重转成可配对的两组有限行 | ER10 |
| ER12 | 补齐 Gram 矩阵得到两个精确尺度 | ER11 |
| ER13 | 判别证书产生具有坐标置换关系的双尺度构形 | ER07、ER08、ER10、ER11、ER12 |
| ER14 | 导出子群的误差可以逐坐标修正为路径分式 | — |
| ER15 | 有限群平均把同轨道误差同时压低 | — |
| ER16 | 把双尺度构形修正为完全相同的路径端点 | ER13、ER14、ER15 |
| ER17 | 同一端点支持全部所需倒数尺度 | ER16 |
| ER18 | 由路径得到任意有限着色的单色全等副本 | ER17 |
| ER19 | 将无限坐标空间结果统一降为有限维 | ER18 |
| ER20 | 闭合原题的双向分类 | ER05、ER06、ER13、ER16、ER18、ER19 |

### ER01 · 全仿射张成的全等副本来自同一个等距仿射映射

类型：数学结果。上游：无表内上游项。

**完整结论**

对 a:Fin s→ℝ^d、b:Fin s→ℝ^D，选定 i₀:Fin s；若 a 的仿射张成是全空间且所有两点距离相同，则存在线性等距嵌入 Q 和平移 t，使每个 i 都有 bᵢ=t+Q(aᵢ)。

**允许的前提**

- 全仿射张成；原题 Congruent；一个点 i₀。

**验收条件**

输出同一个 Q,t 对所有点成立。分别为每一对点选择等距映射不能通过。

**参考声明**

- [OAI.EuclideanRamsey.congruent_linearIsometry](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/Congruence.lean#L74)

### ER02 · 实张量判别失败给出分离函数

类型：数学结果。上游：无表内上游项。

**完整结论**

若 ¬RealCriterion(a)，则存在 f_i:ℝ→ℝ 和 ℚ 线性映射 L:Mat_d(ℝ)→ℝ，L(I)=1；对所有 v∈ℝ、u∈ℝ^d，有 ∑_i f_i(v+∑_j aᵢ,j u_j)+L(u uᵀ)=0；并且对所有 x，∑_i f_i(x)=0。

**允许的前提**

- ¬RealCriterion(a)；实张量阵列及 arrayMap 的定义。

**验收条件**

先将目标 (0,I) 与 arrayMap 的像分离，再得到同一 f,L 的两类恒等式；不能把分离函数存在当作额外假设。

**参考声明**

- [OAI.EuclideanRamsey.separate_arrayMap](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorNecessity.lean#L101)
- [OAI.EuclideanRamsey.exists_separated_functions](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorNecessity.lean#L157)

### ER03 · 任何仿射等距副本上分离函数总和固定为负一

类型：衔接推理。上游：ER01、ER02。

**完整结论**

若 f,L 满足 ER02 的 L(I)=1 和全部仿射线性恒等式，则对任意线性等距嵌入 Q:ℝ^d→ℝ^D、任意平移 t，∑_i∑_j f_i((t+Q(aᵢ))_j)=−1。

**允许的前提**

- ER02 的明确恒等式；任意 Q,t；无需另外假设副本单色。

**验收条件**

用同一个 Q 的行向量 Gram 矩阵之和为 I 合并所有坐标，不可只处理某一种坐标放置。

**参考声明**

- [OAI.EuclideanRamsey.separated_copy_sum](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorNecessity.lean#L206)
- [OAI.EuclideanRamsey.isometryRows_gram](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorNecessity.lean#L198)

### ER04 · 有限取整着色排除负一总和

类型：数学结果。上游：无表内上游项。

**完整结论**

对 s>0、任意集合 X 和函数 H_i:X→ℝ，若 ∀z,∑_iH_i(z)=0，则按向量 (⌊(2s+1)H_j(z)/2⌋ mod (2s+1))_j 着色时，任何同色点族 b_i 都满足 ∑_iH_i(b_i)≠−1。

**允许的前提**

- s>0；逐点相消恒等式；全部 b_i 的上述颜色向量相同。

**验收条件**

取整误差与模 2s+1 的整除矛盾必须完整；只说存在阻碍着色或只比较一个颜色坐标不通过。

**参考声明**

- [OAI.EuclideanRamsey.floor_coloring_obstruction](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorNecessity.lean#L26)

### ER05 · Ramsey 性迫使实张量判别成立

类型：衔接推理。上游：ER01、ER02、ER03、ER04。

**完整结论**

对 s>0、仿射张成全空间的 a，Ramsey(a)⇒RealCriterion(a)。

**允许的前提**

- 原题 Ramsey 定义；s>0 和全仿射张成。

**验收条件**

以 H_i(z)=∑_j f_i(z_j) 构造有限颜色，调用 Ramsey 得同色副本，再用 ER01–ER04 产生矛盾；颜色数必须是合法有限数且≥2。

**参考声明**

- [OAI.EuclideanRamsey.ramsey_realCriterion](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorNecessity.lean#L227)

### ER06 · 实系数与坐标域上的判别双向兼容

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限构形 a，RealCriterion(a)⇔FieldCriterion(a)。从实张量降到 coordinateField(a)⊗ℚcoordinateField(a) 时，同时保留每个点的增广二次式为 0 和空间块乘积为单位阵；反方向沿域嵌入提升。

**允许的前提**

- 题面的 coordinateField、augmented、multiply 和两个判别定义。

**验收条件**

两个方向都要提供实际张量矩阵并保持所有约束。只证明空间块单位阵或只把坐标系数包含关系写出不通过。

**参考声明**

- [OAI.EuclideanRamsey.realCriterion_fieldCriterion](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorDescent.lean#L94)
- [OAI.EuclideanRamsey.fieldCriterion_realCriterion](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorDescent.lean#L131)

### ER07 · 张量证书转成共同的有理矩阵和格子数据

类型：衔接推理。上游：ER06。

**完整结论**

对 d≥1 且 RealCriterion(a)，存在 k≥1、仿射向量 w₁,…,w_k 和同一个对称有理矩阵 C。令 U 的列为 w 的空间部分，则 U C Uᵀ=I；每个点 a_i 的评价映射在整数格上的核 Λ_i 都满足 quotientTensor(Λ_i,matrixTensor C)=0。

**允许的前提**

- RealCriterion(a) 的完整证书；d≥1。

**验收条件**

同一 w,C 同时适用于所有 i；明确 Λ_i 是评价映射之核。逐点选择不同 C 或遗漏空间 Gram 等式不通过。

**参考声明**

- [OAI.EuclideanRamsey.realCriterion_lattice](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorPresentation.lean#L224)

### ER08 · 共同商张量消失得到有限支撑的格点矩证书

类型：衔接推理。上游：ER07。

**完整结论**

对 k,s≥1、格子子群 Λ_i 和对称有理矩阵 C，若每个 quotientTensor(Λ_i,matrixTensor C)=0，则存在同一个有限支撑有理格点元 ν：全部 cosetPushforward(Λ_i,ν)=0、mass(ν)=0、一阶矩全为 0、二阶矩恰为 C。

**允许的前提**

- 完整商张量消失条件；k,s≥1；C 对称。

**验收条件**

构造一个 ν 同时满足所有余类消去和矩约束。分别为各 i 找到 ν_i 不通过；若只对 ER07 实际产生的 Λ,C 证明，须事先冻结该实例接口并验证足够供 ER10 使用。

**参考声明**

- [OAI.EuclideanRamsey.FiniteLatticeIdentity](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/LatticeMoments.lean#L51)
- [OAI.EuclideanRamsey.finite_lattice_identity](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/AdicLifting.lean#L422)

### ER09 · 构造负二阶质量任意小的紧支撑平滑函数

类型：数学结果。上游：无表内上游项。

**完整结论**

对 d≥1、任意对称实矩阵 C 和 U 满足 U C Uᵀ=I，任意 η>0，存在光滑紧支撑 b≥0，∫b>0，且 ∫max(−stencilDifferential(C,b),0)·gradientWeight(U)<η∫b。

**允许的前提**

- C 对称；U C Uᵀ=I；η>0、d≥1。

**验收条件**

必须处理不定的 C，不能增加 C 正定的假设；同一个 b 满足正质量、紧支撑和负部加权界。量词覆盖任意 η>0，不逐个 η 给分。

**参考声明**

- [OAI.EuclideanRamsey.CompactSmoothing](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/SmoothingMatrix.lean#L160)
- [OAI.EuclideanRamsey.compact_smoothing](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/SmoothingMatrix.lean#L173)

### ER10 · 平滑后仍严格保持所有代数约束

类型：衔接推理。上游：ER08、ER09。

**完整结论**

给定 ER08 的 ν、C、Λ_i，及 d≥1、U C Uᵀ=I，任意 η>0，构造 n≥1、有限支撑有理格点元 μ、ζ>0。所有余类消去、零质量、零一阶矩仍精确成立；二阶矩除以 n² 等于 ζC；负系数加权的 ∑max(−μ_δ,0)·gradientWeight(U,δ/n)<ηζ。

**允许的前提**

- ν 的全部消去和矩条件；U C Uᵀ=I；C 对称；η>0。

**验收条件**

离散化和有理化后，等式必须精确而非近似；所有 i 使用同一个 μ,n,ζ。只控制负质量却破坏余类消去不通过。

**参考声明**

- [OAI.EuclideanRamsey.rational_smoothing](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/StencilConvolution.lean#L266)

### ER11 · 有符号权重转成可配对的两组有限行

类型：衔接推理。上游：ER10。

**完整结论**

对 s>0、有限支撑有理权 f、仿射评价 v(x)+a_i·g(x)，若每个评价的推前为 0、二阶矩为 ζI（ζ>0）、负部加权平方范数<ηζ，则存在同一有限行指标 τ、U,V 及偏移 vp,vn：UUᵀ−VVᵀ=I、trace(VVᵀ)<η；对每个 i，有一个行置换 σ_i，使两组仿射评价逐项相等。

**允许的前提**

- 上述精确评价消去、矩等式和负部界；s>0、ζ>0。

**验收条件**

完成有理权的整数量化、正负重数配对和统一归一化。不能为不同点改变两组行本身；允许各点有自己的置换。

**参考声明**

- [OAI.EuclideanRamsey.normalized_signed_rows](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/SignedRows.lean#L158)

### ER12 · 补齐 Gram 矩阵得到两个精确尺度

类型：衔接推理。上游：ER11。

**完整结论**

若 UUᵀ−VVᵀ=I、trace(VVᵀ)<η、η>0，则存在同一个补充矩阵 R，令 c=(√(1+η))⁻¹，有 Gram(c[U,R])=I、Gram(c[V,R])=(η/(1+η))I。

**允许的前提**

- 同一个 U,V 的 Gram 差与 trace 界；η>0。

**验收条件**

两个矩阵添加相同的 R，并给出精确 Gram 等式；近似等距、各自不同的补充矩阵均不通过。

**参考声明**

- [OAI.EuclideanRamsey.complete_gram_pair](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/GramCompletion.lean#L63)

### ER13 · 判别证书产生具有坐标置换关系的双尺度构形

类型：衔接推理。上游：ER07、ER08、ER10、ER11、ER12。

**完整结论**

对 d,s≥1 且 RealCriterion(a)，任意 η>0，存在 ℓ≥1 和 f,g:Fin s→ℝ^ℓ，使所有平方距离分别等于 a 的平方距离及其 η/(1+η) 倍；对每个 i，g_i 的坐标经某个置换后逐项等于 f_i。

**允许的前提**

- RealCriterion(a)；d,s≥1；η>0。

**验收条件**

从同一 μ,w,C 计算评价消去、二阶矩和负部界，再应用行配对与共同 Gram 补齐。两套各自全等但没有逐点坐标置换联系的构形不通过。

**参考声明**

- [OAI.EuclideanRamsey.two_scale_of_signed_rows](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/GramCompletion.lean#L123)
- [OAI.EuclideanRamsey.realCriterion_two_scale](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/GramCompletion.lean#L251)

### ER14 · 导出子群的误差可以逐坐标修正为路径分式

类型：数学结果。上游：无表内上游项。

**完整结论**

一般接口：有限指标集 ι、子幺半群 M⊆G^ι 有对角元、PairInverse 和 PairCoverage(M,N)，N 为正规子群，且 |ι|≤r+2，则 Derived(N,r) 包含于每个坐标的 singleFractions(M)。对单射构形 a 的单位路径系统，证明 pair 条件确实成立，从而可取 N=AugKernel、r=|ι|−2。

**允许的前提**

- 一般接口的完整对角、两坐标逆元和覆盖条件；专门应用中 a 单射。

**验收条件**

既证明导出子群到单坐标分式的连接，也验证单位路径的覆盖条件；不能把可修正误差当成额外群假设。

**参考声明**

- [OAI.EuclideanRamsey.derived_subset_single](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/DerivedFractions.lean#L124)
- [OAI.EuclideanRamsey.unit_pair_inverse](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/PathWords.lean#L74)
- [OAI.EuclideanRamsey.unit_pair_coverage](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/PathWords.lean#L142)

### ER15 · 有限群平均把同轨道误差同时压低

类型：数学结果。上游：无表内上游项。

**完整结论**

有限群 H 作用在有限 X 上，G 为群、N 正规，给定 Derived(N,r) 上的 NormalCost c。若所有 letter(x)letter(y)⁻¹∈N，则任意 δ>0 都存在同一个 OrbitWords 族 w 与长度 m>0，使所有同轨道 x,y 的差 w(x)w(y)⁻¹ 均落在 Derived(N,r)，且成本≤δm。

**允许的前提**

- 完整 NormalCost 的非负、逆元/共轭不变及乘积次可加条件；有限 H,X；字母差在 N 中；δ>0。

**验收条件**

同一个 w,m 同时控制所有轨道，不得逐点独立选择平均结果；需要成本随长度的相对界而非仅有绝对有限性。

**参考声明**

- [OAI.EuclideanRamsey.finite_group_averaging](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/OrbitAveraging.lean#L289)

### ER16 · 把双尺度构形修正为完全相同的路径端点

类型：衔接推理。上游：ER13、ER14、ER15。

**完整结论**

对单射 a、f,g:Fin s→ℝ^ℓ，若 f 的平方距离等于 a，g 的平方距离是 a 的 q 倍（q>0），且逐点坐标由置换联系，则任意 δ>0 可构造同一端点族 w 和两条 Path(a,w,λ)、Path(a,w,μ)，λ>0、μ≥0、μ/λ≤q+sδ。

**允许的前提**

- 上述两组距离等式、逐点置换、a 单射；q,δ>0。

**验收条件**

把平均误差写成路径分式并控制总修正长度，从 Dp·u=Dm·v 得到真正相等的端点。端点仅接近、同轨道或两个互不相干的 w 均不通过。

**参考声明**

- [OAI.EuclideanRamsey.GradedPaths.correction_cost](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/CorrectionPaths.lean#L86)
- [OAI.EuclideanRamsey.averaged_equal_endpoints](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/CorrectionPaths.lean#L114)
- [OAI.EuclideanRamsey.permutation_equal_endpoints](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/CorrectionPaths.lean#L174)

### ER17 · 同一端点支持全部所需倒数尺度

类型：衔接推理。上游：ER16。

**完整结论**

对 n≥1，若同一 w 有尺度 λ>0、μ 的两条路径且 μ/λ<1/n，则存在同一个 W，使每个 1≤t≤n 都有 Path(a,W,1/t)。

**允许的前提**

- 同一端点的两条路径；λ>0、μ/λ<1/n。

**验收条件**

同步全部 1/t 的端点为一个 W，不允许各 t 独立生成 W_t。此项验收完整 n 的全称接口，不按小 n 给分。

**参考声明**

- [OAI.EuclideanRamsey.synchronize_paths](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/PathSynchronization.lean#L101)

### ER18 · 由路径得到任意有限着色的单色全等副本

类型：衔接推理。上游：ER17。

**完整结论**

若对每个 n≥1 都有同一端点的两条路径 λ>0、μ/λ<1/n，则对 FiniteEuclidean 上任意有限颜色类型及任意着色 c，存在与 a 全等的点族 b，且所有 b_i 同色。

**允许的前提**

- 对所有 n 的路径供给；有限颜色类型。

**验收条件**

将同步路径、组合线和超滤子共同实现连接起来，最终输出实际点族及颜色。仅有超滤子中同色或仅有近似距离不通过。

**参考声明**

- [OAI.EuclideanRamsey.paths_monochromatic](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/ColoringCompactness.lean#L59)

### ER19 · 将无限坐标空间结果统一降为有限维

类型：衔接推理。上游：ER18。

**完整结论**

固定颜色数 r，若 FiniteEuclidean 的每个 r 着色都含 a 的单色全等副本，则存在 D≥1，使 ℝ^D 的每个 r 着色都含这样的副本。D 在选择具体着色前确定。

**允许的前提**

- 固定 r；对 FiniteEuclidean 全部 r 着色的结论。

**验收条件**

核对 ∃D∀color 的量词顺序，并在截断时同时保留有限点族的全部距离与颜色。对每个着色各选一个维度不通过。

**参考声明**

- [OAI.EuclideanRamsey.finite_coloring_compactness](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/ColoringCompactness.lean#L150)

### ER20 · 闭合原题的双向分类

类型：汇合结论。上游：ER05、ER06、ER13、ER16、ER18、ER19。

**完整结论**

对 s≥2、d≥1、单射且仿射张成全空间的 a，证明 OAI.EuclideanRamsey.classification：Ramsey(a)⇔FieldCriterion(a)。必要方向用 ER05、ER06；充分方向对每个 n 取 η=1/(4n)、δ=1/(4ns)，用 ER13、ER16 得 μ/λ<1/n，再经 ER18、ER19 得原题 Ramsey。

**允许的前提**

- 原题的 s,d、单射和仿射张成条件；前述完整接口。

**验收条件**

两个方向都回到 coordinateField(a) 的题面矩阵和有限维着色定义，所有辅助平滑、平均和路径条件均已消去。full_affine_representative 与 classification_nonempty 不计分。

**参考声明**

- [OAI.EuclideanRamsey.ramsey_fieldCriterion](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/TensorDescent.lean#L121)
- [OAI.EuclideanRamsey.fieldCriterion_ramsey](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/Main.lean#L28)
- [OAI.EuclideanRamsey.classification](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/EuclideanRamsey/Main.lean#L69)
