# EntropyPhotonNumber：熵光子数不等式

**20 个固定评分项 · 需进一步确认**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](EntropyPhotonNumber.json)

## 目标与适用性

- 题目 ID：`oai_entropy_photon_number`。
- 唯一计分根：`OAI.EntropyPhotonNumber.entropy_photon_number_inequality`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/EntropyPhotonNumber.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 参考路线能拆出明确的变分、热态识别和极限接口。这 20 项可用于同一路线的事后比较，但 EP04 的 Gibbs/谱数据接口仍比其余项目重。

**需要留意：** 各项对应固定的正则化变分证明。换用另一类证明时，可能跳过 GibbsData 和偏差分析；等权分数也不代表各项耗时相同。

**下一步：** 启用前由熟悉该参考证明的人核对 EP04–EP09 的相容谱数据与假设边界，确认把 EP04 作为一个验收单元；随后冻结 20 项。本次保留原题，不直接替换。

## 参考证明主线

正则化目标先取得全局极小值，变分恒等式控制热偏差；偏差消失和能量紧性把极小值逼近热态。利用热态的显式熵得到切线不等式，依次去掉两类正则化，再以保能量截断覆盖全部有限能量态。最后选取与输入熵匹配的参考参数并识别题面的实际输出。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| EP01 | 热熵函数的逆与保序关系 | — |
| EP02 | 统一能量界下的熵连续性 | — |
| EP03 | 正则化目标存在全局极小值 | EP02 |
| EP04 | 极小值产生相容的 Gibbs 数据与变分恒等式 | — |
| EP05 | 输出热偏差由输入偏差控制 | — |
| EP06 | 中心化能量的精确平衡 | — |
| EP07 | 极小态的偏差和均值随正则化消失 | EP04、EP05、EP06 |
| EP08 | 零热偏差确定唯一热态 | — |
| EP09 | 极小态列存在共同的热态收敛子列 | EP07、EP08 |
| EP10 | 热参考态的熵与分束器输出 | EP08 |
| EP11 | 正则化熵目标的基准下界 | EP02、EP03、EP09、EP10 |
| EP12 | 去掉替换正则化得到带热噪声的切线界 | EP02、EP11 |
| EP13 | 去掉附加热噪声得到真实分束器切线界 | EP02、EP12 |
| EP14 | 有限能量态有保能量的有限矩逼近 | — |
| EP15 | 把切线界推广到全部有限能量输入 | EP02、EP13、EP14 |
| EP16 | 零熵参考参数的误差控制 | EP01 |
| EP17 | 选取匹配输入熵的参考态 | EP01、EP15、EP16 |
| EP18 | 把不等式接到闭区间全部透射率 | EP02、EP17 |
| EP19 | 题面输出关系识别唯一的分束器态 | — |
| EP20 | 组装原题熵光子数不等式 | EP01、EP18、EP19 |

### EP01 · 热熵函数的逆与保序关系

类型：数学结果。上游：无表内上游项。

**完整结论**

在非负实数上证明 g 连续、严格递增且满射到非负实数，gInv(g(t))=t、g(gInv(s))=s，并得到 t≤gInv(s)↔g(t)≤s。

**允许的前提**

- 原题 g 与 sInf 形式 gInv 的定义；t,s≥0。

**验收条件**

必须处理 t=0 或 s=0；不得把 gInv 换成未经证明相同的逆函数。

**参考声明**

- [OAI.EntropyPhotonNumber.strictMonoOn_g](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L112)
- [OAI.EntropyPhotonNumber.g_surjective_nonneg](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L151)
- [OAI.EntropyPhotonNumber.gInv_g](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L126)
- [OAI.EntropyPhotonNumber.g_gInv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L165)
- [OAI.EntropyPhotonNumber.le_gInv_iff](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L169)

### EP02 · 统一能量界下的熵连续性

类型：数学结果。上游：无表内上游项。

**完整结论**

若一族有限能量态的算子收敛到有限能量态，且同一 E 控制全部能量，则其熵收敛；同时证明固定有限能量输入的分束器输出熵随 η∈[0,1] 连续。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 源声明 tendsto_entropy 的共同能量上界和算子收敛前提；原分束器定义。

**验收条件**

一般无限维态的连续性及分束器参数连续性都要成立；有限矩阵的连续性不能代替。本项必须展示输出能量仍受同一个界控制。

**参考声明**

- [OAI.EntropyPhotonNumber.tendsto_entropy](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Entropy.lean#L1264)
- [OAI.EntropyPhotonNumber.tendsto_entropy_beamOutput_parameter](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L404)
- [OAI.EntropyPhotonNumber.tendsto_beamOutput_parameter](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L70)

### EP03 · 正则化目标存在全局极小值

类型：数学结果。上游：EP02。

**完整结论**

对任意 Regularization R 和任意四阶矩有限的见证态 ρw,σw，证明存在四阶矩有限的 ρ,σ 全局最小化 R.objective；其 sublevel 能量与四阶矩满足源码给出的显式界。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- Regularization 的全部结构条件，包括正的能量惩罚与四阶矩惩罚系数。
- EP02 的完整结论。

**验收条件**

要对所有四阶矩有限竞争态取全局最小，而非局部驻点；能量界必须能在之后 ζ→0 时保持统一。

**参考声明**

- [OAI.EntropyPhotonNumber.Regularization.sublevel_bounds](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Entropy.lean#L1460)
- [OAI.EntropyPhotonNumber.Regularization.exists_minimum](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Entropy.lean#L1504)

### EP04 · 极小值产生相容的 Gibbs 数据与变分恒等式

类型：数学结果。上游：无表内上游项。

**完整结论**

对满足源码热噪声条件的 R 的全局极小态，构造同一组 G1,G2,G0：输入 GibbsData、输出 SpectralLogData、六阶矩有限性；证明 minimum_spectral_pairing_balance 中的生成元对数配对等式和两个中心化 BKM Hessian 界。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 源声明 minimum_spectral_pairing_balance 的 R、四阶矩、热参考参数及全局极小性前提。

**验收条件**

严格验收该源声明的完整存在量词和三个相容结论；G1,G2,G0 不可在配对等式和 Hessian 界中分别更换。仅证明热态是驻点不能验收。

**参考声明**

- [OAI.EntropyPhotonNumber.Regularization.minimum_spectral_pairing_balance](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Minimum.lean#L1131)
- [OAI.EntropyPhotonNumber.Regularization.minimum_physical_pairing_balance](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/PhysicalMinimum.lean#L648)
- [OAI.EntropyPhotonNumber.Regularization.minimum_centered_gibbs_data](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/PhysicalMinimum.lean#L408)

### EP05 · 输出热偏差由输入偏差控制

类型：衔接推理。上游：无表内上游项。

**完整结论**

固定 ThermalSetup P。设 Qᵢ 为第 i 个谱数据的 defectSquared，Mᵢ 为 meanSquared。由两个中心化 Hessian 界证明 Q0≤w1 Q1+w2 Q2+(ε/2)[w1 Q1+w2 Q2+w1 M1+w2 M2]。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 参考 ThermalSetup 的完整结构条件：η,θ,κ∈(0,1)，r1,r2,d,ε>0，以及 slack_r、slack_s 两个噪声余量约束和 small_κ 约束；r0,w1,w2、reg、defectSquared、meanSquared 按源码定义。
- 源声明 ThermalSetup.physical_estimate 的同一组三个 SpectralLogData、六阶矩和两个 Hessian 不等式。

**验收条件**

要把真实双端口分束器、热噪声和替换通道接到偏差估计；所有权重及 ε/2 系数须与源码一致，不能直接假设目标收缩界。

**参考声明**

- [OAI.EntropyPhotonNumber.ThermalSetup.physical_estimate](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Minimum.lean#L1312)
- [OAI.EntropyPhotonNumber.physical_defect_estimate](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Minimum.lean#L285)

### EP06 · 中心化能量的精确平衡

类型：数学结果。上游：无表内上游项。

**完整结论**

对同一 ThermalSetup 和三个谱数据，证明存在 v≥0 使 E0−n r0=w1(E1−n r1)+w2(E2−n r2)+κ(1−κ)v，其中 Eᵢ 为 centeredEnergy。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 参考 ThermalSetup 的完整结构条件：η,θ,κ∈(0,1)，r1,r2,d,ε>0，以及 slack_r、slack_s 两个噪声余量约束和 small_κ 约束；r0,w1,w2、reg、defectSquared、meanSquared 按源码定义。
- 源声明 ThermalSetup.physical_energy 的同一组谱数据及输入六阶矩条件。

**验收条件**

必须保留额外项非负性，并对应同一个分束器输出；单独证明总能量有界不能验收。

**参考声明**

- [OAI.EntropyPhotonNumber.ThermalSetup.physical_energy](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Minimum.lean#L1373)
- [OAI.EntropyPhotonNumber.physical_centered_energy_identity](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Minimum.lean#L687)

### EP07 · 极小态的偏差和均值随正则化消失

类型：衔接推理。上游：EP04、EP05、EP06。

**完整结论**

对固定 n,P，存在不依赖 ζ、ρ、σ 的 C>0，使每个 ζ>0 的全局极小态都有相容 GibbsData，满足 w1(Q1+M1)+w2(Q2+M2)≤Cζ。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 参考 ThermalSetup 的完整结构条件：η,θ,κ∈(0,1)，r1,r2,d,ε>0，以及 slack_r、slack_s 两个噪声余量约束和 small_κ 约束；r0,w1,w2、reg、defectSquared、meanSquared 按源码定义。
- EP04、EP05、EP06 的完整结论；极小性与四阶矩前提。

**验收条件**

必须证明统一 C 的存在并完成配对项消去；只对固定 ζ 给出有限常数不算完成。

**参考声明**

- [OAI.EntropyPhotonNumber.ThermalSetup.minimum_decay](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Minimum.lean#L1406)
- [OAI.EntropyPhotonNumber.ThermalSetup.uniform_minimum_decay](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Minimum.lean#L1477)
- [OAI.EntropyPhotonNumber.thermalGenerator_fourth_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Minimum.lean#L1098)

### EP08 · 零热偏差确定唯一热态

类型：数学结果。上游：无表内上游项。

**完整结论**

若带 GibbsData 的态列算子收敛到 σ，各模式 annihilationMean 与 defect 范数都趋零，则 σ=thermalState n r；核心是由极限矩阵满足 Balance 递推和迹一推出唯一几何对角矩阵。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- thermal_limit_state 中的正 Gibbs 参数、r>0、算子收敛和逐模式偏差趋零前提；不假设极限态已对角化。

**验收条件**

需要排除非对角矩阵元并确定全部对角元及归一化；只证明极限态某个矩等于热态不够。

**参考声明**

- [OAI.ThermalRecurrence.unique_thermal_matrix](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L239)
- [OAI.EntropyPhotonNumber.thermal_limit_entries](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L317)
- [OAI.EntropyPhotonNumber.thermal_limit_state](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L481)

### EP09 · 极小态列存在共同的热态收敛子列

类型：衔接推理。上游：EP07、EP08。

**完整结论**

对 ζm>0、ζm→0 的全局极小态列，若两输入能量有共同界，证明存在一个严格递增 f，使 ρf(m)、σf(m) 分别趋于 r1、r2 的热态。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 参考 ThermalSetup 的完整结构条件：η,θ,κ∈(0,1)，r1,r2,d,ε>0，以及 slack_r、slack_s 两个噪声余量约束和 small_κ 约束；r0,w1,w2、reg、defectSquared、meanSquared 按源码定义。
- EP07、EP08 的完整结论；源声明 minimum_thermal_subsequence 的四阶矩、全局极小性和共同能量界。

**验收条件**

两输入必须使用同一子列；要从总偏差界推出每个模式趋零，再与能量紧性和热态识别接通。

**参考声明**

- [OAI.EntropyPhotonNumber.pair_energy_subsequence](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L460)
- [OAI.EntropyPhotonNumber.pair_thermal_subsequence](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L542)
- [OAI.EntropyPhotonNumber.ThermalSetup.minimum_thermal_subsequence](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L565)

### EP10 · 热参考态的熵与分束器输出

类型：数学结果。上游：EP08。

**完整结论**

对 r>0，证明 energy(thermalState n r)=nr、entropy(thermalState n r)=n g(r)；两热态输入分束器得到参数 ηa+(1−η)b 的热态，进而 P.out 的热参考输出为 thermalState n P.r0。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 热态正参数和 η∈[0,1]；EP08 中唯一热矩阵递推结论。
- 参考 ThermalSetup 的完整结构条件：η,θ,κ∈(0,1)，r1,r2,d,ε>0，以及 slack_r、slack_s 两个噪声余量约束和 small_κ 约束；r0,w1,w2、reg、defectSquared、meanSquared 按源码定义。

**验收条件**

需识别整个输出态和其熵；只匹配能量、均值或形式上的高斯参数不足。

**参考声明**

- [OAI.EntropyPhotonNumber.thermalState_energy](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L359)
- [OAI.EntropyPhotonNumber.thermalState_entropy](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L366)
- [OAI.EntropyPhotonNumber.thermal_beamOutput](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L388)
- [OAI.EntropyPhotonNumber.ThermalSetup.output_thermal](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L431)

### EP11 · 正则化熵目标的基准下界

类型：衔接推理。上游：EP02、EP03、EP09、EP10。

**完整结论**

对任意四阶矩有限输入，证明 P.entropyPart(ρ,σ)+P.penalty(ρ,σ)≥0；penalty 使用热相对熵，且非负。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 参考 ThermalSetup 的完整结构条件：η,θ,κ∈(0,1)，r1,r2,d,ε>0，以及 slack_r、slack_s 两个噪声余量约束和 small_κ 约束；r0,w1,w2、reg、defectSquared、meanSquared 按源码定义。
- EP02、EP03、EP09、EP10 的完整结论；thermalRelative、entropyPart、penalty 和 objective 的固定定义。

**验收条件**

以任意输入作为竞争态，选全局极小态并取共同热态子列；必须说明惩罚项非负；固定竞争态的 ζ·(M4ρw+M4σw) 趋零，极小态一侧的四阶矩项只用非负性丢弃，不能只验证热参考输入。

**参考声明**

- [OAI.EntropyPhotonNumber.thermalRelative_nonneg](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L601)
- [OAI.EntropyPhotonNumber.ThermalSetup.objective_offset](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L628)
- [OAI.EntropyPhotonNumber.ThermalSetup.base_nonnegative](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/ThermalLimit.lean#L678)

### EP12 · 去掉替换正则化得到带热噪声的切线界

类型：衔接推理。上游：EP02、EP11。

**完整结论**

对任意 ThermalInterior T 及四阶矩有限输入，令 raw 为先以 η 混合、再以 θ 与热噪声混合的输出，证明 (S(raw)−n g(r0))/h(r0)−θη(S(ρ)−n g(r1))/h(r1)−θ(1−η)(S(σ)−n g(r2))/h(r2)≥0。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- ThermalInterior 的完整结构条件；h(r)=log(r+1)−log(r)。
- EP02、EP11 的完整结论。

**验收条件**

构造满足所有 ThermalSetup 约束的 κm,εm→0，控制输出熵极限并消除 penalty；本项验收完整极限结论，不按若干固定参数点计分。

**参考声明**

- [OAI.EntropyPhotonNumber.ThermalInterior.out_entropy_limit](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L279)
- [OAI.EntropyPhotonNumber.ThermalInterior.entropy_tangent](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L301)

### EP13 · 去掉附加热噪声得到真实分束器切线界

类型：衔接推理。上游：EP02、EP12。

**完整结论**

对 0<η<1、r1,r2>0 和任意四阶矩有限输入，令 r=ηr1+(1−η)r2，证明 (S(beamOutput)−n g(r))/h(r)−η(S(ρ)−n g(r1))/h(r1)−(1−η)(S(σ)−n g(r2))/h(r2)≥0。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 上述参数范围和输入四阶矩条件。
- EP02、EP12 的完整结论。

**验收条件**

须通过 θ→1 以及 beamOutput_one 识别极限为原分束器；不能留下附加热噪声或把 θ<1 的结论当作完成。

**参考声明**

- [OAI.EntropyPhotonNumber.beamOutput_one](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L368)
- [OAI.EntropyPhotonNumber.entropy_tangent_beam](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L431)

### EP14 · 有限能量态有保能量的有限矩逼近

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限能量态 ρ，构造 NumberCutoff.state ρ F：任意阶矩有限、能量≤原能量，并且随着有限截断 F 增大其算子趋于 ρ.op。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- ρ 的有限能量；NumberCutoff 的投影压缩加真空补质量定义。

**验收条件**

必须同时证明正性、迹一、有限矩、统一能量界和算子收敛；仅截断矩阵而丢失归一化不算有效逼近。

**参考声明**

- [OAI.EntropyPhotonNumber.NumberCutoff.state](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L495)
- [OAI.EntropyPhotonNumber.NumberCutoff.finiteMoment](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L526)
- [OAI.EntropyPhotonNumber.NumberCutoff.energy_le](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L535)
- [OAI.EntropyPhotonNumber.NumberCutoff.limit](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L555)

### EP15 · 把切线界推广到全部有限能量输入

类型：衔接推理。上游：EP02、EP13、EP14。

**完整结论**

在 EP13 同一参数范围下，去掉四阶矩假设，证明任意有限能量 ρ,σ 的相同切线不等式。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 输入只假设 FiniteEnergy；EP02、EP13、EP14 的完整结论。

**验收条件**

需要输入和真实输出的熵同时收敛，输出能量有统一界；最终声明不得残留有限维、有限支撑或四阶矩前提。

**参考声明**

- [OAI.EntropyPhotonNumber.entropy_tangent_finiteEnergy](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L572)

### EP16 · 零熵参考参数的误差控制

类型：数学结果。上游：EP01。

**完整结论**

对每个 a≥0，令 am=a+1/(m+1)，证明 [g(a)−g(am)]/h(am)→0。

**允许的前提**

- a≥0、g,h 的固定定义；EP01 的 g 连续性和单调性事实。

**验收条件**

必须覆盖 a=0，不能使用 h(0) 的有限连续性；通过统一分母下界或等价正确论证消掉误差。

**参考声明**

- [OAI.EntropyPhotonNumber.reference_error_limit](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L613)
- [OAI.EntropyPhotonNumber.h_antitone](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L138)

### EP17 · 选取匹配输入熵的参考态

类型：衔接推理。上游：EP01、EP15、EP16。

**完整结论**

对 n≥1、0<η<1 和任意有限能量输入，证明 g(η gInv(Sρ/n)+(1−η)gInv(Sσ/n))≤S(beamOutput)/n。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- n≥1、0<η<1；EP01、EP15、EP16 的完整结论。

**验收条件**

使用输入自身的熵选择两个参考参数并消除正近似误差；必须覆盖一个或两个输入熵为零的情况。

**参考声明**

- [OAI.EntropyPhotonNumber.epni_entropy_interior](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L627)

### EP18 · 把不等式接到闭区间全部透射率

类型：衔接推理。上游：EP02、EP17。

**完整结论**

EP17 的熵形式不等式对每个 η∈[0,1] 成立。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- n≥1、η∈[0,1]；EP02、EP17 的完整结论。

**验收条件**

证明从内部参数列到任意闭区间参数的极限传递；η=0 与 η=1 必须包含。此项不是给若干 η 特例分别加分。

**参考声明**

- [OAI.EntropyPhotonNumber.epni_entropy_closed](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L666)

### EP19 · 题面输出关系识别唯一的分束器态

类型：数学结果。上游：无表内上游项。

**完整结论**

若 IsBeamSplitterOutput η ρA ρB ρC 且 η∈[0,1]，证明 ρC=beamOutput η hη ρA ρB。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 原题的 IsBeamSplitterOutput HasSum 偏迹关系。

**验收条件**

证明偏迹关系确定整个态；不能直接将题面任意 ρC 重新定义为构造输出，或只证明对角元相等。

**参考声明**

- [OAI.EntropyPhotonNumber.output_unique](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Continuity.lean#L451)
- [OAI.EntropyPhotonNumber.output_eq](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Continuity.lean#L457)

### EP20 · 组装原题熵光子数不等式

类型：汇合结论。上游：EP01、EP18、EP19。

**完整结论**

对配置根的全部 n≥1、有限能量 ρA,ρB、η∈[0,1] 和满足输出关系的 ρC，证明 η gInv(SρA/n)+(1−η)gInv(SρB/n)≤gInv(SρC/n)。

**允许的前提**

- 原题 n 模 Fock 空间、State、entropy、FiniteEnergy、beamOutput 和 IsBeamSplitterOutput 的固定定义；输入可以是任意混态，不限对角态或热态。
- 原题全部前提；EP01、EP18、EP19 的完整结论。

**验收条件**

精确恢复 entropy_photon_number_inequality 的原量词，不增加热态、对角态、有限矩或严格内部参数假设。

**参考声明**

- [OAI.EntropyPhotonNumber.entropy_photon_number_inequality](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/InformationTheory/PhotonNumber/Inequality.lean#L689)
