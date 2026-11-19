# OneWayLiveness：One-way liveness：小型非确定自动机与确定自动机下界

**19 个固定评分项 · 需进一步确认**

[返回总表](../README.md) · [统一评分规则](../PROTOCOL.md) · [结构化规格](OneWayLiveness.json)

## 目标与适用性

- 题目 ID：`oai_one_way_liveness`。
- 唯一计分根：`OAI.OneWayLiveness.main_theorem`。
- [原题文件](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/ComparatorChallenges/OneWayLiveness.lean) · [参考入口](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Main.lean)。
- 来源版本：`7617767a945e263f3fa412255e1a570ccdbfb98c`。

**判断：** 目标明确分成同一个 h+3 状态单向 NFA 的正确性和任意确定自动机的指数下界，参考实现给出了可验收的 19 个接口。下界中配对图表示与秩损失归纳的工作量较集中，需先验证轨迹中这些证明片段能否稳定对应。

**需要留意：** 接受约定、端标记、终止状态和配对图必须指向同一个规范化自动机。只证明运行模拟或抽象秩界却没有连接两者，不算整个下界完成。使用不同配对编码可以经等价映射验收；整体改用另一种下界技术会漏计当前内部义务。

**下一步：** 先对含成功和失败片段的小批轨迹试标，检查 owl05–owl10 的运行语义以及 owl12–owl16 的秩接口。稳定后冻结这 19 项；若大量推进只落在巨大的 owl14 内部，再在新版本中按实际归纳子义务重新拆分。保留旧版记录；采用新版比较时，所有被比较实验都按新版重新验收。

## 参考证明主线

实际根目标由 small_nfa 和 deterministic_lower_bound 合成。前一支证明布尔关系乘积等价于逐字路径，并验证同一台 NFA；后一支把运行规范化为端点可达性，再用配对图识别和关系半群的秩损失给出状态下界。RankLossAt 的归纳步按带明确前提的蕴含式验收，完整强归纳另有义务关闭。Main 中额外的 no_polynomial_simulation 不属于配置根目标，不计分。

## 固定评分项

本题各项等权。先固定清单，再按实验截止时刻已有的证明逐项验收。条件引理可以独立完成；把它用于无条件结论时，仍须补齐前提。所有项必须使用兼容的构造。

| ID | 要完成的工作 | 参考路线中的上游项 |
|---|---|---|
| owl01 | 关系乘积等价于逐字路径 | — |
| owl02 | 路径自动机的接受可靠性 | — |
| owl03 | 每条活路径都能成为正长度接受运行 | owl01 |
| owl04 | 交付同一个 h+3 状态单向 NFA | owl02、owl03 |
| owl05 | 消除正长度约定差异 | — |
| owl06 | 把接受接到统一的右端终点 | — |
| owl07 | 连接局部配对图与整字图 | — |
| owl08 | 可达运行排除分离着色 | — |
| owl09 | 不可达时构造分离着色 | — |
| owl10 | 得到固定字母映射的精确认识测试 | owl07、owl08、owl09 |
| owl11 | 语言上下文能区分所有布尔关系 | — |
| owl12 | 单个关系增广迫使秩下降 | — |
| owl13 | 矩形增广累计秩损失 | owl12 |
| owl14 | 关闭所有大小的指数秩损失归纳 | owl12、owl13 |
| owl15 | 去除单位提升的额外前提 | owl14 |
| owl16 | 把任意识别器接到秩下界 | owl11、owl15 |
| owl17 | 确定机的状态数接到配对端口数 | owl06、owl10、owl16 |
| owl18 | 恢复题面的两种确定机下界 | owl05、owl17 |
| owl19 | 完成小 NFA 与确定机下界的合取 | owl04、owl18 |

### owl01 · 关系乘积等价于逐字路径

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意有限布尔关系字 w 及端点 a,b，证明 w.prod.holds a b 等价于存在 p:ℕ→H，p(0)=a、p(|w|)=b 且每个位置 i 的字母关系连接 p(i) 与 p(i+1)。

**允许的前提**

- 题面的 BRel 乘法和任意字 w；端点 a,b。

**验收条件**

两个方向和空字都需覆盖；只展示某个字的一条路径或只给乘积非空的充分条件不通过。

**参考声明**

- [OAI.OneWayLiveness.PathNFA.product_path](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/PathNFA.lean#L91)

### owl02 · 路径自动机的接受可靠性

类型：数学结果。上游：无表内上游项。

**完整结论**

对源码 PathNFA.machine，证明每个可达配置满足前缀关系积不变量 Good；因此任一接受运行都推出 BRel.live w，适用于两种运行长度约定。

**允许的前提**

- 题面运行语义和 PathNFA 的同一组 rules；任意字及有限运行。

**验收条件**

给出初始不变量、good_step 保持和接受配置导出 live 的完整链。只有单步规则局部正确但未连接接受配置不通过。

**参考声明**

- [OAI.OneWayLiveness.PathNFA.good_step](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/PathNFA.lean#L136)
- [OAI.OneWayLiveness.PathNFA.accepts_iff](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/PathNFA.lean#L192)

### owl03 · 每条活路径都能成为正长度接受运行

类型：衔接推理。上游：owl01。

**完整结论**

由 BRel.live w 构造同一 PathNFA.machine 的接受运行，包含左端标记启动、全部字母的向右转移和右端标记接受；该运行长度严格为正。

**允许的前提**

- owl01 的逐字路径；PathNFA.machine 的原始规则。

**验收条件**

从任意 live 字构造运行，并涵盖空字。不能只证明关系路径存在而省去端标记和实际运行。

**参考声明**

- [OAI.OneWayLiveness.PathNFA.accepts_iff](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/PathNFA.lean#L192)

### owl04 · 交付同一个 h+3 状态单向 NFA

类型：衔接推理。上游：owl02、owl03。

**完整结论**

对每个 h，构造 N:NMachine (Alphabet h) (h+3)，同时证明 NoLeft 和对所有 positive:Bool 的 Recognizes positive (OWL h)。

**允许的前提**

- owl02、owl03；源码 State、rules、relabel 定义。

**验收条件**

两个接受约定必须共用同一 N；状态重标号须保持接受与 NoLeft。为两种约定各造一台机器不满足本义务。

**参考声明**

- [OAI.OneWayLiveness.small_nfa](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/PathNFA.lean#L243)
- [OAI.OneWayLiveness.PathNFA.rules_noLeft](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/PathNFA.lean#L72)
- [OAI.OneWayLiveness.NMachineOn.relabel_accepts](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/PathNFA.lean#L32)
- [OAI.OneWayLiveness.NMachineOn.relabel_noLeft](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/PathNFA.lean#L54)

### owl05 · 消除正长度约定差异

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意确定 Machine M，构造只增加一个 Option 状态的 positiveCopy，并证明对所有 w，positiveCopy.Accepts false w ↔ M.Accepts true w。

**允许的前提**

- 原题的确定运行及 positive/false 两种接受定义；任意 M,w。

**验收条件**

需双向保存接受并解释新初始状态为何排除零步接受；不能新增“原机一定至少走一步”的假设。

**参考声明**

- [OAI.OneWayLiveness.Machine.positiveCopy_accepts](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Normalization.lean#L95)

### owl06 · 把接受接到统一的右端终点

类型：数学结果。上游：无表内上游项。

**完整结论**

对任意 M，构造增加一个状态的 sinkCopy，使原机在 false 约定下接受 w，当且仅当新机可从左端初态到达右端 terminal；该 terminal 在右端无出转移。

**允许的前提**

- 原题 Machine 的转移和接受谓词；任意字 w，包括空字。

**验收条件**

必须证明双向可达等价、终点位置和无出转移。不能额外假定原机总停机，或只覆盖原机已有完整转移的情形。

**参考声明**

- [OAI.OneWayLiveness.Machine.sinkCopy_accepts](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Normalization.lean#L238)
- [OAI.OneWayLiveness.Machine.sinkCopy_terminal](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Normalization.lean#L242)

### owl07 · 连接局部配对图与整字图

类型：数学结果。上游：无表内上游项。

**完整结论**

证明配对图乘积的 Compatible 等价于存在一条一致的边界着色链，并将该链等价地解释为 fullDiagram 的 ColorData，保留左右端边界。

**允许的前提**

- 源码 Pairing 组合、局部 bodyDiagram、ColorData 定义；任意有限状态集、机器与字。

**验收条件**

局部颜色必须在相邻单元共享边界；分别为每个单元找到不相容的着色不通过。

**参考声明**

- [OAI.OneWayLiveness.Pairing.prod_compatible_chain](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Diagrams.lean#L10)
- [OAI.OneWayLiveness.CellNetwork.fullDiagram_compatible](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Diagrams.lean#L68)

### owl08 · 可达运行排除分离着色

类型：数学结果。上游：无表内上游项。

**完整结论**

若指定右端 finish 无出转移，且左端初态可达该终点，则任意全局 ColorData 都不能使左右测试端口 Separated。

**允许的前提**

- 同一 M,w,finish；M.transition finish .right=none；真实运行可达性。

**验收条件**

证明所有合法全局着色都不能分离；只验证一条选定着色或漏掉其他连通分支不通过。

**参考声明**

- [OAI.OneWayLiveness.CellNetwork.reach_excludes_separation](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Diagrams.lean#L139)

### owl09 · 不可达时构造分离着色

类型：数学结果。上游：无表内上游项。

**完整结论**

在同一右端终止条件下，若左端初态不可达 finish，构造全局 ColorData 并证明两端 Separated。

**允许的前提**

- 同一 M,w,finish 的右端无出转移；初态不可达终点。

**验收条件**

需给出合法全局着色的存在性和两端分离，包括运行图中其他环与分支；不能把分离证书直接作为假设。

**参考声明**

- [OAI.OneWayLiveness.CellNetwork.separation_of_not_reach](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Diagrams.lean#L244)

### owl10 · 得到固定字母映射的精确认识测试

类型：衔接推理。上游：owl07、owl08、owl09。

**完整结论**

证明 recognitionTest M finish ((w.map bodyDiagram).prod) 当且仅当左端初态可达右端 finish；端标记由固定左右配对图处理。

**允许的前提**

- owl07–owl09；同一 M,finish 的右端终止条件。

**验收条件**

两边使用同一个字母映射和固定测试谓词，映射不得依赖整个输入字；需处理左右端标记，不只是普通字母单元。

**参考声明**

- [OAI.OneWayLiveness.CellNetwork.diagram_recognizes_reach](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Diagrams.lean#L277)
- [OAI.OneWayLiveness.CellNetwork.fullDiagram_markers](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Recognition.lean#L29)
- [OAI.OneWayLiveness.CellNetwork.recognitionTest_iff](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Recognition.lean#L44)

### owl11 · 语言上下文能区分所有布尔关系

类型：数学结果。上游：无表内上游项。

**完整结论**

若两字 u,v 在每对前后上下文 x,y 中具有相同 live 判定，则 u.prod=v.prod；用单点 restrictedId 上下文恢复每个关系条目。

**允许的前提**

- 布尔关系乘积和题面 live 定义；对所有前后字上下文的等价假设。

**验收条件**

需推出关系逐条相等，不能仅推出是否非空相同；上下文量词必须是任意 x,y。

**参考声明**

- [OAI.OneWayLiveness.BRel.singleton_context](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Syntactic.lean#L10)
- [OAI.OneWayLiveness.BRel.context_separates](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Syntactic.lean#L15)

### owl12 · 单个关系增广迫使秩下降

类型：衔接推理。上游：无表内上游项。

**完整结论**

证明 rank_drop_step 的条件蕴含式：在源码有限半群的单射配对表示、满射关系表示及两次 corner 数据下，若保留集合 F 满足其 RankLossAt 归纳命题，则 rankLoss(|F|)≤2(rank(ρe)−rank(ρb))。

**允许的前提**

- rank_drop_step 明列的有限性、单射/满射、幂等 e,b、restrictedId 与 P/N 兼容关系、不同 x,y、N 在 F 上等于 addEdge 的前提；仅在此蕴含式中假设 RankLossAt |F|。

**验收条件**

验收的是完整带前提的局部推导，不把 RankLossAt 前提视为已证。需完成两次 corner 限制并保存正确的秩差和系数 2。

**参考声明**

- [OAI.OneWayLiveness.rank_drop_step](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/RankLoss.lean#L20)

### owl13 · 矩形增广累计秩损失

类型：衔接推理。上游：owl12。

**完整结论**

在源码 RectangleFrame、公共 support K、各保留集合的 RankLossAt 以及统一 L 前提下，对任意边集 E 构造幂等 b，使其像为 F.rel E、support⊆K，且 |E|·L≤2(rank(ρe)−rank(ρb))。

**允许的前提**

- rectangle_chain 的 frame、共同基底幂等 e、生成元 g 及其像、公共 K；每个保留集合的归纳前提与共同 L；owl12。

**验收条件**

三个结论绑定同一个 b，覆盖任意有限 E；不能只把每条边的局部秩下降相加而省去共同表示和支撑控制。归纳前提仍待 owl14 关闭。

**参考声明**

- [OAI.OneWayLiveness.rectangle_chain](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/RankLoss.lean#L180)

### owl14 · 关闭所有大小的指数秩损失归纳

类型：衔接推理。上游：owl12、owl13。

**完整结论**

证明对每个 h，RankLossAt h：在有单位提升的有限半群表示中，任何映为 addEdge x y 的幂等 a 满足 2^((h−2)/31)≤|A|−rank(ρa)。

**允许的前提**

- RankLossAt 定义中的原始有限性、单射/满射和 HasUnitLifts 前提；owl12、owl13；仅使用严格更小 h 的强归纳假设。

**验收条件**

必须关闭整个强归纳，包括基例、16×16 矩形、保留集大小 h−31 和支撑预算；只有归纳递推式或大 h 情形不通过。

**参考声明**

- [OAI.OneWayLiveness.RankLossAt](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/RankLoss.lean#L10)
- [OAI.OneWayLiveness.rankLoss_all](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/RankLoss.lean#L276)

### owl15 · 去除单位提升的额外前提

类型：衔接推理。上游：owl14。

**完整结论**

对任意有限半群 M 的单射配对表示 ρ 和满射 φ:M→BRel H，只要求 H 中有两个不同点，即推出 rankLoss(|H|)≤|A|，不再假设 HasUnitLifts φ。

**允许的前提**

- 单射 ρ、满射 φ、有限 H/A/M，以及不同 x,y；owl14。

**验收条件**

需构造最小秩 corner 并建立其中的单位提升，不能把 HasUnitLifts 留在公开结论的假设里。

**参考声明**

- [OAI.OneWayLiveness.relation_divisor_degree](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/RankLoss.lean#L365)

### owl16 · 把任意识别器接到秩下界

类型：衔接推理。上游：owl11、owl15。

**完整结论**

给定固定字母映射 η:BRel H→Pairing(A⊕A) 与 test，若 test((w.map η).prod)↔live w 对所有 w 成立，则 rankLoss(|H|)≤|A|。

**允许的前提**

- 上述全称识别等价；有限 H,A；两个不同点；owl11、owl15。

**验收条件**

需构造实际有限子半群并证明投到配对图单射、投到关系满射；只声称语言具有大语法半群不通过。

**参考声明**

- [OAI.OneWayLiveness.matching_recognition_degree](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Syntactic.lean#L25)

### owl17 · 确定机的状态数接到配对端口数

类型：衔接推理。上游：owl06、owl10、owl16。

**完整结论**

若有限状态机器 M 在 false 约定下识别 live，证明 rankLoss(|H|)≤4(|Q|+1)^2：sinkCopy 的字母配对图满足识别测试，端口集大小正好是右端表达式。

**允许的前提**

- 同一个 M 的全称识别假设；owl06、owl10、owl16；H 中两个不同点。

**验收条件**

机器、sinkCopy、finish=none、字母映射、test 和端口集合必须一一对应；只有抽象识别器界或只有端口计数不通过。

**参考声明**

- [OAI.OneWayLiveness.Machine.liveness_rank_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Recognition.lean#L57)

### owl18 · 恢复题面的两种确定机下界

类型：衔接推理。上游：owl05、owl17。

**完整结论**

对所有 h≥2、positive、s 和识别 OWL h 的 DMachine D，证明 2^((h−2)/31)≤4·(s+(if positive then 2 else 1))^2。

**允许的前提**

- 题面全部 h、positive、s,D 及识别假设；owl05 与 owl17。

**验收条件**

需同时处理 false 的一个额外状态和 true 的两个额外状态，保留精确常数与自然数除法；不能只证明渐近阶或一种约定。

**参考声明**

- [OAI.OneWayLiveness.deterministic_lower_bound](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Recognition.lean#L80)

### owl19 · 完成小 NFA 与确定机下界的合取

类型：汇合结论。上游：owl04、owl18。

**完整结论**

对每个 h≥2，交付同一个 h+3 状态 NoLeft NFA 对所有 positive 识别 OWL h，以及对所有 positive、s,D 的题面确定机下界。

**允许的前提**

- 原题 h≥2；owl04 和 owl18，无其他未证机器或表示前提。

**验收条件**

交付精确 OAI.OneWayLiveness.main_theorem。两个分支都完成；同文件额外的 no_polynomial_simulation 不代替、也不增加本项分数。

**参考声明**

- [OAI.OneWayLiveness.main_theorem](https://github.com/LuNa-shi/SwarmEnv/blob/7617767a945e263f3fa412255e1a570ccdbfb98c/benchmarks/openai-math-12/lean/OAI/Combinatorics/Automata/Main.lean#L10)
