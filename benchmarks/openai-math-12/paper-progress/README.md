# 论文路线的证明进度

实验前固定每题的配置根、论文版本、验收项、允许的公共背景、资源预算和观测时刻。执行者只取得该组配置的输入，评估者保存本目录。这里的局部指标衡量论文证明义务的覆盖率。各项可能相差很多工时；沿其他路线已经证明、尚无法对应清单的成果另列数学结论和证据。

12 个配置目标对应 11 篇论文，共 168 项。每题的链接页给出完整命题、允许前提、依赖、验收条件及固定版本的论文行号。两道埃及分数题分别评分；若比较论文家族，可在实验前选其中一题，或单独报告按家族平均的结果。

| 配置目标 | 论文 | 等权项数 | 评分时要核实的连接 |
|---|---|---:|---|
| [SeymourSecondNeighborhood](SeymourSecondNeighborhood.md) | [PDF](../papers/173/paper.pdf) | 19 | 反例归约、共同秩系数和剪枝；区分两种极小性。 |
| [OneWayLiveness](OneWayLiveness.md) | [PDF](../papers/129/paper.pdf) | 12 | 同一放大链的支撑上界和逐次秩损失须能共同用于机器下界。 |
| [PartialPermutation](PartialPermutation.md) | [PDF](../papers/238/paper.pdf) | 9 | 沿 isotypic 分解交付两种范数界；采用其他分解仍可直接证明原根。 |
| [ShortEgyptianFractions](ShortEgyptianFractions.md) | [PDF](../papers/025/paper.pdf) | 15 | 同一组分母同时覆盖中层和终端，并能恢复原展开。与 EgyptianFractions 共用论文。 |
| [PowerFreeValues](PowerFreeValues.md) | [PDF](../papers/020/paper.pdf) | 18 | 四至八次的计数、数值证书和九次以上的引用各自验收。大项的难度仍需试评。 |
| [SecondKahnKalai](SecondKahnKalai.md) | [PDF](../papers/176/paper.pdf) | 10 | 在同一棵树上验证采样、剪枝成功概率、容量与路径恢复。 |
| [EuclideanRamsey](EuclideanRamsey.md) | [PDF](../papers/172/paper.pdf) | 13 | 工具结论可限定于实际构形，但须覆盖原判据所用的全部实例。 |
| [EntropyPhotonNumber](EntropyPhotonNumber.md) | [PDF](../papers/273/paper.pdf) | 20 | 固定辅助参数，仅令 ζ 趋零。无限维谱和算子域的条件须单独核实。 |
| [StronglyRayleighDPP](StronglyRayleighDPP.md) | [PDF](../papers/231/paper.pdf) | 9 | 只计有限响应定理。按论文用齐次化与总数守恒建立协方差行界。 |
| [KMedianRefinedRecovery](KMedianRefinedRecovery.md) | [PDF](../papers/125/paper.pdf) | 10 | 按论文给定 anchor 的抽样恢复算法验收。证书只能用于分析，实际机器仍须可执行。 |
| [MatchingFPRAS](MatchingFPRAS.md) | [PDF](../papers/113/paper.pdf) | 18 | 对采样、冷却、有限随机位和最终机器逐步验收；更换算法可能绕过部分项目。 |
| [EgyptianFractions](EgyptianFractions.md) | [PDF](../papers/025/paper.pdf) | 15 | 按这一配置根的量词恢复稠密供给、坏集和真实展开。与 ShortEgyptianFractions 属同一题族。 |

## 判分

若原 checker 验收配置根，得 1，标注「整题已解」。否则得已通过项数除以本题固定项数。最后的根组装项已包含在分母中。多题按事先固定题单等权平均；同一论文的重复任务应在发布时说明题族权重。定稿后若修改验收表，换版本并对比较双方重新评分。

每个截止时刻冻结公开 Workspace 版本及 Material。每项记录 ID、状态、允许前提、文件/声明、版本、Lean 检查回执及裁决理由。检查候选声明的精确类型、依赖闭包和允许的公理；含有未证明的洞、新增公理、循环依赖、复用参考答案或者只在文本中复述论文的工作都不通过。相同截止时刻的证据可以通过事先允许的重标号、类型转换和机械组装对齐；评估者不得为候选补证新的数学步骤。

状态为 passed、not_completed 或 unassessed。只有完整验收的项记 1。审完并确认缺失的项记 0。无法恢复或尚未核验的项保留 unassessed，存在未知时不发表可比较总分。表内上游记录证明的接合位置。已证条件引理可以按明确允许的前提独立验收，用到它的下游输出仍要补齐前提。允许直接证明同一结论或更强结论，不强制复刻参考实现。若项本身描述两组输入的连接，则需交付可实际使用的完整连接。

匹配、样本、系数、集合或算法等见证应在同一候选包中相容。多个候选包分开评分，取兼容包的最高分。单个强引理可以交付多个不同项，每项只计一次。全部项若声称通过，须能组装并经原根 checker 核验。正式试评可对相同快照隐藏系统身份，分别核验再记录分歧。拟提供的已证 Lean 引理属于背景，需事先从待证分母扣除并固定新版本；提供自然语言论文仍要求系统交付 Lean 证明。

## Seymour 校准样例

- **ssn01 正例**　参考声明 `exists_minimal_counterexample` 返回同一非空图的全部性质，包含在同顶点类型所有反例中弧数最小。
- **ssn01 边界**　EXP-20261120-02 的 `exists_arcMinimalBad_stronglyConnected_inducedMinimal`只量化当前图的真删边子关系。它提供有价值的归约，尚缺与任意其他反例的弧数比较。单凭该声明不计这一项。
- **ssn07/08 见证**　两侧子式分别在不同赋值上非零，不能交付同一赋值同时满足条件。若构造了同一个赋值并核验两侧性质，变量名或矩阵表示的机械变更可接受。
- **ssn19 整题**　参考根证明或经原 checker 验收的替代整题证明均置 1。仅有最小出度至多五的证明仍有额外假设。
