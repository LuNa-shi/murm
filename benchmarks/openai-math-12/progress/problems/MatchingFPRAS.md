# MatchingFPRAS：完美匹配计数的 FPRAS

**20 个固定评分项 · 需进一步确认**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](MatchingFPRAS.json)

## 目标与适用性

- 题目 ID：`oai_matching_fpras`。
- 唯一计分根：`OAI.MatchingFPRAS.thm_main`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/MatchingFPRAS.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 参考路线有可验收的采样、冷却、认证、概率放大与机器实现接口，可按这20项比较相同路线的进展。

**需要留意：** 原定理只要求存在一个 FPRAS，并未指定复制链、sourceLaw 或认证器。替换算法会连带更换这些计分对象；固定路线内部的 MF02 混合证明也比多数后续接口重，等权分数不等于工作量比例。

**下一步：** 启用前锁定本参考构造或建立到这些接口的明确映射，复核 MF02 的 Poincaré/能量接口与 MF17 的机器语义接口。若实验允许自由替换整个算法，先暂缓本题并另选路线更固定的题；本次只记录候选结论，不更改配置。

## 参考证明主线

通过复制链采样近似带标记分布，控制每阶段全部观测量；有理缩放保持平衡，冷却比值连乘得到计数估计。认证器确保零计数逐种子正确，中位数重复达到任意失败概率。最后把同一实验实现为随机机器，证明全局统一时限并转换为 goodTapes 比例。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| MF01 | 冷却链首尾的配分函数对应原计数 | — |
| MF02 | 复制链的定量混合界 | — |
| MF03 | 给定误差时有显式的统一采样步数 | MF02 |
| MF04 | 有限公平比特模拟理想链 | — |
| MF05 | 实际带标记采样接近目标 sourceLaw | MF03、MF04 |
| MF06 | 同时控制全部阶段观测量 | — |
| MF07 | 实际有限采样满足每阶段失败预算 | MF05、MF06 |
| MF08 | 好样本同时恢复平衡并估计正确比值 | — |
| MF09 | 自适应多阶段误差不会失控 | MF07、MF08 |
| MF10 | 比值误差合成最终计数界与单轮准确率 | MF01、MF09 |
| MF11 | 不存在完美匹配时认证器绝不误报 | — |
| MF12 | 存在匹配时认证器不会过度拒绝 | MF05 |
| MF13 | 认证后的单轮失败率仍低于1/10 | MF09、MF10、MF12 |
| MF14 | 公平比特带实现多轮认证实验的同一分布 | — |
| MF15 | 中位数放大得到任意 δ 的成功保证 | MF13、MF14 |
| MF16 | 统一程序覆盖全部图并保留零计数语义 | MF11、MF15 |
| MF17 | 实际随机机器实现该程序的输出分布 | — |
| MF18 | 同一机器有对全部输入统一的多项式时限 | — |
| MF19 | 从实验概率转换到截止时刻的好比特带比例 | MF16、MF17 |
| MF20 | 组装全局机器与时限的原定理 | MF18、MF19 |

### MF01 · 冷却链首尾的配分函数对应原计数

类型：数学结果。上游：无表内上游项。

**完整结论**

初始 raw 权重的配分函数等于完全图匹配数；对 scheduleAdmissible 的终点 K 和 Z(G)>0，Z(G)≤partition(raw G K)≤(1+ε/32)Z(G)。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- raw 权重、原图边与非边的补权以及 scheduleAdmissible 的固定定义；终点界假设 Z(G)>0。

**验收条件**

必须把增广/补权系统接回原图的计数；只近似补权图的配分函数而未控制补边贡献不能验收。

**参考声明**

- [OAI.MatchingFPRAS.Trial.initial_raw_partition](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/AdaptiveLaw.lean#L47)
- [OAI.MatchingFPRAS.Trial.final_padding](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/AdaptiveLaw.lean#L51)
- [OAI.MatchingFPRAS.GraphBridge.raw_partition](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/Endpoints.lean#L110)

### MF02 · 复制链的定量混合界

类型：数学结果。上游：无表内上游项。

**完整结论**

对固定 ladderLaw ν、ladderFlow C、q=32(10⁴ND)^100，证明从任意初态 z 出发的 n 步分布满足 (Σs|walk(n,s)−ν(s)|)²≤(1−3/[8(Tq²+q)])^n(ν(z)⁻¹−1)。

**允许的前提**

- 源 finiteLadder/ladderLaw 的有限 BagEdge 模型：bags 在无环图中满足邻接条件，height>0、相邻高度比≤2、D≥1、N≥2，height/D≤w≤3height，D⁻¹≤w≤3·4^K；相关类型与初始匹配按源码量化。
- concrete_ladder_mixing 的全部原有高度与权重前提；同一初始匹配 M₀ 和任意 ladder 初态 z。

**验收条件**

须建立该实际 ladderFlow 的平稳流、惰性和 Poincaré/能量控制并导出衰减；不能把有限状态链存在平稳分布当作定量混合。

**参考声明**

- [OAI.MatchingFPRAS.Transport.concrete_ladder_mixing](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Graphs/Evolve.lean#L172)
- [OAI.MatchingFPRAS.FiniteChain.meeting_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Graphs/Evolve.lean#L102)

### MF03 · 给定误差时有显式的统一采样步数

类型：衔接推理。上游：MF02。

**完整结论**

对所有 ladder 初态 z，证明 log(1/ν(z))≤源码 ladderLambda 的统一界，并由 MF02 得到在 ladderSteps(N,D,K,T,ξ) 步后总变差≤ξ，0<ξ<1。

**允许的前提**

- 源 finiteLadder/ladderLaw 的有限 BagEdge 模型：bags 在无环图中满足邻接条件，height>0、相邻高度比≤2、D≥1、N≥2，height/D≤w≤3height，D⁻¹≤w≤3·4^K；相关类型与初始匹配按源码量化。
- MF02 的完整结论；ladderSteps、ladderLambda 的固定定义。

**验收条件**

步数不能依赖未知 ν(z) 或每条轨迹；需要给最小质量界并把它代入混合式。

**参考声明**

- [OAI.MatchingFPRAS.Transport.ladder_minimum_mass](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/LadderL.lean#L19)
- [OAI.MatchingFPRAS.Transport.ideal_ladder_sampling](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/LadderL.lean#L107)

### MF04 · 有限公平比特模拟理想链

类型：数学结果。上游：无表内上游项。

**完整结论**

在 ranked bags 的有限实现条件下，采用源码 bitPrecision(n·scanErrorNumerator,η) 位精度，证明 ladderBitRun 的输出分布与同一理想 n 步链的总变差≤η。

**允许的前提**

- ladderBitRun_walk_tv 的 bags、rank、parent、正权重、正q和η>0全部前提；有限比特运行、扫描核和精度的固定定义。

**验收条件**

要控制每步离散选择误差的累计，并证明比特分块确实给出所用分布；只说明随机数可近似采样不能验收。

**参考声明**

- [OAI.MatchingFPRAS.Transport.ladderRun_walk_tv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/Sym2Order.lean#L312)
- [OAI.MatchingFPRAS.Transport.ladderBitRun_walk_tv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/Sym2Order.lean#L405)

### MF05 · 实际带标记采样接近目标 sourceLaw

类型：衔接推理。上游：MF03、MF04。

**完整结论**

把 MF03 的理想混合与 MF04 的比特误差合并，再取顶层边缘、添加标记和重新编号，证明 finiteSourceLaw 与 sourceLaw 的总变差≤2η+1/m，m>1。

**允许的前提**

- 源 finiteLadder/ladderLaw 的有限 BagEdge 模型：bags 在无环图中满足邻接条件，height>0、相邻高度比≤2、D≥1、N≥2，height/D≤w≤3height，D⁻¹≤w≤3·4^K；相关类型与初始匹配按源码量化。
- finiteSourceLaw_tv 的正有理权重、BottleneckAlgorithm.edge≤4^K、合法初始匹配等完整前提。
- MF03、MF04 的完整结论。

**验收条件**

边缘和标记必须对应后续 StageGood 使用的同一 sourceLaw；只对未标记的匹配分布给界不能验收。

**参考声明**

- [OAI.MatchingFPRAS.Transport.finiteLadder_tv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/DiscreteLadderSteps.lean#L48)
- [OAI.MatchingFPRAS.RationalSource.topSampler_tv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Graphs/LabelOrder.lean#L479)
- [OAI.MatchingFPRAS.RationalSource.markedSampler_tv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/Marking.lean#L110)
- [OAI.MatchingFPRAS.RationalSource.finiteSourceLaw_tv](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/FiniteStage.lean#L78)

### MF06 · 同时控制全部阶段观测量

类型：数学结果。上游：无表内上游项。

**完整结论**

对理想 sourceLaw 的 S 个独立样本，证明 StageGood 失败概率≤2(N²+2)exp(−2Sσ²)；若 Sσ²≥10(N+T+1)，则失败概率<1/(100T)。

**允许的前提**

- source_ideal_concentration 的正权重、0≤w₁≤w、正配分函数、S>0、σ≥0前提；所有 ObservableIndex 的固定定义。

**验收条件**

所有比值和矩阵估计所需观测量须在同一个样本事件里同时受控；只证明一个观测量的均值集中不能验收。

**参考声明**

- [OAI.MatchingFPRAS.Enlargement.source_ideal_concentration](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/FinitePMF.lean#L287)
- [OAI.MatchingFPRAS.Enlargement.source_ideal_budget](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/FinitePMF.lean#L349)

### MF07 · 实际有限采样满足每阶段失败预算

类型：衔接推理。上游：MF05、MF06。

**完整结论**

把采样误差设为源码 η=1/(1000TS)、m=1000TS，证明实际 S 样本的 StageGood 失败概率<13/(1000T)；在第 j≤K 个冷却阶段得到同一个 13/(1000K) 界。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- finite_source_stage_budget 的正配分函数、下一阶段权重不增和样本量条件。
- MF05、MF06 的完整结论。

**验收条件**

必须从单样本总变差传到 S 个独立样本的乘积分布；不能忽略 S 倍误差或把近似样本直接当成理想样本。

**参考声明**

- [OAI.MatchingFPRAS.RationalSource.finite_source_stage_budget](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/FiniteStage.lean#L96)
- [OAI.MatchingFPRAS.FiniteTrial.ScaleState.sampleLaw_budget](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/FiniteTrialLaw.lean#L45)

### MF08 · 好样本同时恢复平衡并估计正确比值

类型：数学结果。上游：无表内上游项。

**完整结论**

若阶段 j 的同一 ScaleState 已 Balanced 且样本满足 StageGood，则有理更新后的下一状态仍 Balanced，且估计比值相对 partition(raw(j+1))/partition(raw(j)) 的误差≤ε/(100K)。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- successful_update 的 j≤K、Balanced 与 StageGood 前提；同一状态、样本和有理缩放更新。

**验收条件**

两个结论必须由同一次更新获得；缩放后的活动权重比值要证明等于未缩放 raw 配分函数比值。单独得到一个好矩阵或一个好比值不算完成。

**参考声明**

- [OAI.MatchingFPRAS.FiniteTrial.successful_update](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/RationalUpdate.lean#L44)
- [OAI.MatchingFPRAS.Counting.one_pass_restores_balance](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Tapes/RunBits.lean#L339)

### MF09 · 自适应多阶段误差不会失控

类型：衔接推理。上游：MF07、MF08。

**完整结论**

在依赖先前样本而选择下一状态的实际 Layer 链上，证明 j≤K 时 P(¬Layer.good)≤j·13/(1000K)。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- MF07、MF08 的完整结论；第一层 initialScaleState 的固定初始化。

**验收条件**

须使用条件于历史的首个失败事件论证；不能错误地把不同自适应阶段当成无条件独立事件。

**参考声明**

- [OAI.MatchingFPRAS.FiniteTrial.Layer.append_good](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/FiniteTrial.lean#L53)
- [OAI.MatchingFPRAS.FiniteTrial.Layer.append_failure](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/FiniteTrial.lean#L64)
- [OAI.MatchingFPRAS.FiniteTrial.layers_failure](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/FiniteTrial.lean#L79)

### MF10 · 比值误差合成最终计数界与单轮准确率

类型：衔接推理。上游：MF01、MF09。

**完整结论**

若每个阶段比值相对真值的误差≤ε/(100K)，则完全图计数乘估计比值连乘所得 Y 满足 (1−ε)Z(G)≤Y≤(1+ε)Z(G)。 再结合 MF09，得到实际有限采样输出的失败概率≤13/1000。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- Z(G)>0；MF01 的完整结论以及完整的逐阶段相对误差前提。
- MF09 的自适应阶段失败界。

**验收条件**

需要证明配分函数比值望远镜相消、连乘误差界和终点补边误差的合并；逐项误差小不能直接作为本项结论。 同时将 Layer.good 事件对应到实际有理 output，完成单轮失败概率的验收。

**参考声明**

- [OAI.MatchingFPRAS.Counting.stage_product_error](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/Endpoints.lean#L359)
- [OAI.MatchingFPRAS.Counting.positive_telescope](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/Endpoints.lean#L408)
- [OAI.MatchingFPRAS.Trial.final_trial_interval](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/AdaptiveLaw.lean#L86)
- [OAI.MatchingFPRAS.FiniteTrial.good_output](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/FiniteTrial.lean#L105)
- [OAI.MatchingFPRAS.FiniteTrial.actual_finite_trial_failure](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/FiniteTrial.lean#L113)

### MF11 · 不存在完美匹配时认证器绝不误报

类型：数学结果。上游：无表内上游项。

**完整结论**

若 Z(G)=0，每个实际有限比特样本都不能取得正 certificate，guardedBitOutput 和 guardedAmplifiedBitOutput 因而在所有种子上严格输出0。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- Z(G)=0；certificateActivity、certificate、drawGuard 和 guarded 输出的固定定义。

**验收条件**

验收逐条比特带的严格零输出；高概率输出0或仅期望为0不足。要证明采样支持中的证书与原图完美匹配存在性对应。

**参考声明**

- [OAI.MatchingFPRAS.Trial.ScaleState.certificate_zero](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/Guard.lean#L199)
- [OAI.MatchingFPRAS.FiniteTrial.ScaleState.drawOne_certificate_zero](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/GuardProbability.lean#L55)
- [OAI.MatchingFPRAS.FiniteTrial.guardedBitOutput_zero](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Tapes/GuardBits.lean#L57)
- [OAI.MatchingFPRAS.FiniteTrial.guardedAmplifiedBitOutput_zero](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Tapes/GuardBits.lean#L91)

### MF12 · 存在匹配时认证器不会过度拒绝

类型：衔接推理。上游：MF05。

**完整结论**

若末阶段 Balanced 且 Z(G)>0，实际单个认证样本取得正证书的概率≥1/5；独立的16次认证同时失败概率≤1/16。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- 同一个末阶段状态、Balanced、Z(G)>0。
- MF05 的采样分布误差结论。

**验收条件**

要从证书均值与范围界得到正证书事件概率，再计入实际采样误差和16次重复；不能直接假设已有完美匹配见证。

**参考声明**

- [OAI.MatchingFPRAS.FiniteTrial.ScaleState.certificate_mean_lower](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/GuardProbability.lean#L66)
- [OAI.MatchingFPRAS.FiniteTrial.ScaleState.guard_success](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/GuardProbability.lean#L91)
- [OAI.MatchingFPRAS.FiniteTrial.guard_failure](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/GuardProbability.lean#L193)

### MF13 · 认证后的单轮失败率仍低于1/10

类型：衔接推理。上游：MF09、MF10、MF12。

**完整结论**

对 Z(G)>0，将冷却估计和认证器作用于同一最终状态，证明 guardedOutput 不满足相对误差要求的概率≤1/10。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- Z(G)>0；MF09、MF10、MF12 的完整结论。

**验收条件**

认证事件必须条件于该轮产生的状态；不得把另一次独立构造的平衡状态当作当前状态。

**参考声明**

- [OAI.MatchingFPRAS.FiniteTrial.guarded_trial_failure](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/GuardProbability.lean#L212)

### MF14 · 公平比特带实现多轮认证实验的同一分布

类型：数学结果。上游：无表内上游项。

**完整结论**

证明 drawGuarded 的像分布等于 guardedLaw，且 drawGuardedTrials 的像分布等于该 law 的 2·halfRepetitions(δ)+1 次独立乘积。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- 原 drawGuarded、drawGuardedTrials、guardedBits 与 guardedAmplifiedBits 定义。

**验收条件**

必须明确所有阶段、认证和重复实验的比特分块，证明分布一致及独立性；不能仅匹配期望或总比特数量。

**参考声明**

- [OAI.MatchingFPRAS.FiniteTrial.drawGuarded_law](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Tapes/GuardBits.lean#L43)
- [OAI.MatchingFPRAS.FiniteTrial.drawGuardedTrials_law](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Tapes/GuardBits.lean#L68)

### MF15 · 中位数放大得到任意 δ 的成功保证

类型：衔接推理。上游：MF13、MF14。

**完整结论**

对每个 δ>0，将认证输出的奇数次独立重复取中位数，证明好比特带数/2^guardedAmplifiedBits≥1−δ。

**允许的前提**

- 参考 Trial.Parameters G 的完整条件：n≥2、n为偶数、ε∈(0,1)、K及scheduleAdmissible；ScaleState、sourceLaw、Layer.good、output、guardedOutput 按该固定构造定义。
- Z(G)>0、δ>0；MF13、MF14 的完整结论。

**验收条件**

要使用源码同一重复次数、同一比特分布和中位数；不能把成功率数值分成多档独立计分。

**参考声明**

- [OAI.MatchingFPRAS.FiniteTrial.guardedAmplifiedBitOutput_success](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Tapes/GuardBits.lean#L99)

### MF16 · 统一程序覆盖全部图并保留零计数语义

类型：衔接推理。上游：MF11、MF15。

**完整结论**

对所有 GraphInput、0<ε<1、δ>0，LiteralAlgorithm.algorithm 每次输出非负有理数，Z=0 时所有输出严格为0，并以≥1−δ 概率满足相对误差界。

**允许的前提**

- 原题任意 GraphInput G 和有理数 0<ε<1、0<δ<1/2；Z(G) 是原图完美匹配数。机器 A 和时间常数 C,d 必须先于 G,ε,δ 选定。
- MF11、MF15 的完整结论；empty、invalid、compute、count、algorithm 的固定定义。

**验收条件**

必须覆盖空图、奇数顶点、过稀图及正常计算分支；空图计数为1不能误归入零分支。所有分支属于同一个程序。

**参考声明**

- [OAI.MatchingFPRAS.LiteralAlgorithm.algorithm_proper](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/AlgorithmLaw.lean#L73)
- [OAI.MatchingFPRAS.LiteralAlgorithm.algorithm_success](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Algorithm/AlgorithmLaw.lean#L111)
- [OAI.MatchingFPRAS.count_empty_graph](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Sampling/Endpoints2.lean#L44)

### MF17 · 实际随机机器实现该程序的输出分布

类型：数学结果。上游：无表内上游项。

**完整结论**

对同一个 mainProgram.machine，证明它从 encodeInput(G,ε,δ) 在 wrapTime 内实现 LiteralAlgorithm.algorithm 的整个输出带实验；运行后输出分布与该实验一致。

**允许的前提**

- 原题任意 GraphInput G 和有理数 0<ε<1、0<δ<1/2；Z(G) 是原图完美匹配数。机器 A 和时间常数 C,d 必须先于 G,ε,δ 选定。
- LiteralAlgorithm.algorithmRealizer、LiteralPhysical.mainProgram 和标准编码的固定定义；Realizes 的原语义。

**验收条件**

验收 mainProgram_realizes 的完整语义及运行均值传递；不能仅构造一台能模拟某个相近采样器的机器。

**参考声明**

- [OAI.MatchingFPRAS.LiteralPhysical.mainProgram_realizes](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Machines/Wrapper.lean#L93)
- [OAI.MatchingFPRAS.PhysicalPost.Program.Realizes.run_mean](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Machines/PhysicalProgramSeal.lean#L42)

### MF18 · 同一机器有对全部输入统一的多项式时限

类型：数学结果。上游：无表内上游项。

**完整结论**

存在全局 C,d，C>0，使每个合法 G,ε,δ 的 wrapTime(algorithmRealizer,encodeInput)≤timeBound C d G ε δ，时间多项式依赖输入长度、ε⁻¹ 和 log(δ⁻¹)。

**允许的前提**

- 原题任意 GraphInput G 和有理数 0<ε<1、0<δ<1/2；Z(G) 是原图完美匹配数。机器 A 和时间常数 C,d 必须先于 G,ε,δ 选定。
- 固定的同一 algorithmRealizer 与 mainProgram；编码、比特成本、timeBound 的源码定义。

**验收条件**

要计算实际机器的模拟、输出与算术成本；C,d 不得按图或精度重选。只证明随机比特数量多项式不算运行时间界。

**参考声明**

- [OAI.MatchingFPRAS.LiteralAlgorithm.algorithm_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Complexity/OriginalCost.lean#L21)
- [OAI.MatchingFPRAS.LiteralPhysical.mainTime_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Complexity/PhysicalCost.lean#L41)

### MF19 · 从实验概率转换到截止时刻的好比特带比例

类型：衔接推理。上游：MF16、MF17。

**完整结论**

对同一机器及任意 n≥wrapTime，证明每条长度 n 的比特带都停机并输出非负有理数、Z=0时输出0，且 goodTapes.card/2^n≥1−δ。

**允许的前提**

- 原题任意 GraphInput G 和有理数 0<ε<1、0<δ<1/2；Z(G) 是原图完美匹配数。机器 A 和时间常数 C,d 必须先于 G,ε,δ 选定。
- MF16、MF17 的完整结论；n≥同一机器的 wrapTime。

**验收条件**

要处理未用完的随机比特与固定截止时刻，将输出实验的概率精确转换为原题 goodTapes 的基数比；不得改用另一种概率空间。

**参考声明**

- [OAI.MatchingFPRAS.LiteralPhysical.mainProgram_outputs](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/MainLaw.lean#L30)
- [OAI.MatchingFPRAS.LiteralPhysical.average_good](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/MainLaw.lean#L42)
- [OAI.MatchingFPRAS.LiteralPhysical.mainProgram_success](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Probability/MainLaw.lean#L53)

### MF20 · 组装全局机器与时限的原定理

类型：汇合结论。上游：MF18、MF19。

**完整结论**

存在同一个 A,C,d，C>0，对所有 G,0<ε<1,0<δ<1/2，在 t=timeBound C d G ε δ 同时满足全比特带非负输出、Z=0时严格零输出、好比特带比例≥1−δ。

**允许的前提**

- 原题任意 GraphInput G 和有理数 0<ε<1、0<δ<1/2；Z(G) 是原图完美匹配数。机器 A 和时间常数 C,d 必须先于 G,ε,δ 选定。
- MF18、MF19 的完整结论，A=同一 mainProgram.machine，C,d 使用 MF18 的全局见证。

**验收条件**

精确恢复 MainStatement 与 thm_main；不得把一台机器的正确性、另一台机器的效率或每个输入各自选择的机器拼在一起。

**参考声明**

- [OAI.MatchingFPRAS.thm_main](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/MatchingCount/Main.lean#L21)
