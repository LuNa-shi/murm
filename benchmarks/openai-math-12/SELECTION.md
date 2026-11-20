# OpenAI Math 12 题选择与审核

这个目录是 SwarmEnv 内部维护的 self-contained benchmark fixture。题目、Comparator challenge、Lean 依赖项目、参考证明源码和选择记录都在本目录内。运行时不需要另一个 OpenAI Math checkout。

## 选择标准

候选题按以下条件筛选。

1. challenge 文件必须保留明确的 `sorry` 目标，并且声明可以在固定 Lean 4.34.1 与 Mathlib revision 下加载。
2. 对应的参考 solution module 必须在同一个固定工程中存在，且其传递 import closure 可以构建。
3. 题目需要覆盖不同数学方向和不同依赖形状，避免 12 题都只测一个短 tactic proof。
4. 依赖面应当比 Q20 的完整 FLT proof DAG 小，仍然保留可观察的定义展开、辅助引理、结构性推理和最终 checker 验证。
5. 题目按 theorem-hole 数量、source closure 大小、核心数学对象和预期调试路径分层，便于先做 smoke，再做三题一组。

## 固定环境

| 项目 | 固定值 |
|---|---|
| 上游源版本 | `4eaee87548250b2682affda7d05d947c05554bae` |
| Lean | `leanprover/lean4:v4.34.1` |
| Mathlib | `d13f23b723b8a846827a245b89c10fc7d3f11612` |
| 本地 fixture | `benchmarks/openai-math-12/lean` |
| 参考证明索引 | `reference-solutions.json` |

## 12 个候选题

下表的 source 行数和传递 closure 行数来自固定版本的只读依赖审计。所有 12 个 challenge 都通过 source-only Lean 检查，所有 12 个参考 solution module 都完成构建。`holes` 是 challenge 中的 theorem placeholder 数量。较大的 closure 适合后续组运行，不作为第一轮 smoke。

| ID | 方向 | 目标 theorem | source | closure | holes | 运行层级 |
|---|---|---|---:|---:|---:|---|
| `oai_seymour_second_neighborhood` | 组合图论 | `OAI.SeymourSecondNeighborhood.exists_goodVertex` | 40 | 4,901 | 1 | 单题 4h 已测 |
| `oai_one_way_liveness` | 自动机与组合 | `OAI.OneWayLiveness.main_theorem` | 105 | 4,159 | 1 | 第一组 |
| `oai_partial_permutation` | 表示论 | `OAI.PartialPermutation.complementaryCosets_finite` | 116 | 6,083 | 1 | 第一组 |
| `oai_short_egyptian_fractions` | 数论 | `OAI.ShortEgyptian.main` | 27 | 8,167 | 1 | 第一组 |
| `oai_power_free_values` | 丢番图/数论 | `OAI.QuarticPowerFree.allDegrees` | 46 | 23,315 | 1 | 第二组 |
| `oai_second_kahn_kalai` | 概率组合 | `OAI.LeanBlast.SecondKahnKalai.secondKahnKalaiBounds` | 74 | 6,827 | 1 | 第一组 |
| `oai_euclidean_ramsey` | 欧氏 Ramsey 理论 | `OAI.EuclideanRamsey.classification` | 52 | 6,610 | 1 | 第一组 |
| `oai_entropy_photon_number` | 信息论 | `OAI.EntropyPhotonNumber.entropy_photon_number_inequality` | 112 | 27,950 | 1 | 第二组 |
| `oai_strongly_rayleigh_dpp` | 概率/随机矩阵 | `OAI.Problem336AdditiveD139.*` | 185 | 12,295 | 6 | 第三组 |
| `oai_kmedian_refined_recovery` | 度量算法 | `OAI.MetricKMedianRecovery.RefinedRecovery.refined_recovery` | 167 | 57,127 | 1 | 第三组 |
| `oai_matching_fpras` | 计数复杂度 | `OAI.MatchingFPRAS.thm_main` | 110 | 66,356 | 1 | 第三组 |
| `oai_egyptian_fractions` | 数论/渐近 | `OAI.Problem337.*` | 124 | 36,185 | 9 | 第三组 |

## 审核结论

- 12 个 challenge 文件、Comparator JSON、目标声明和参考 solution module 均存在。
- 12 个 challenge 在固定 Lean/Mathlib 工程中通过 source-only 检查，输出只有预期的 `sorry` 警告。
- 12 个参考 solution module 的传递源码树均可构建，未发现 `sorry` 或 `admit`。
- `StronglyRayleighDPP` 与 `EgyptianFractions` 的多个 theorem hole 会增加任务分解和最终整合难度。
- `KMedianRefinedRecovery` 与 `MatchingFPRAS` 的 closure 最大，适合在 smoke 和较小三题组稳定后运行。
- 额外的 `PlaneColoring` 只作为流程 smoke 题，不计入上述 12 题。它的目标是 `OAI.Problem160.properColoring_seven`，文件和参考答案同样已经嵌入本目录。

Seymour 的 challenge 只有 40 行、一个证明空缺，但参考证明的传递依赖有 4,901 行。首题四小时实验验证了最小出度为 5 等特殊情形，一般定理仍未完成。因此将其保留为运行顺序的第一题，求解难度仍待更多观测。[四 Core 单题报告](../../docs/experiments/EXP-20261120-02-seymour-single-4h.md)

## PlaneColoring 四 Core 验证记录

使用本目录的 smoke 题 `PlaneColoring` 做了两次真实四 Core 运行。

- 第一次使用 180 秒总 timebox。初始化和独立服务部署消耗了约 116 秒，调度阶段只剩约 63 秒，四个首次 turn 在 `agent_settled` 前被 deadline cleanup 关闭。该运行的 `protocol_valid` 为 `true`，但没有 take、Workspace 写入或 checker 请求。
- 第二次使用 600 秒总 timebox，实验目录为 `experiments/openai-math-coloring-4core-1795088580255/`。四个 Core 都完成了多次 turn 并 take 了 Task，产生 6 个动态 Task、7 个 Material、3 个 checker 请求和 2 个 Workspace 写入，`made_progress=true`、`protocol_valid=true`。
- 第二次运行先暴露并修复了独立 Judge peer 使用默认 `mvp-1` checker identity 的接入问题。修复后 checker 正确使用 `openai-math-v1`，并对真实候选进行了 source-level 反馈。
- 运行最终 `solved=false`。已执行的数学检查中，候选被 Lean 报告为 `aesop failed, made no progress`，另一个 Core 的初始 project check 因保留 `sorry` 被拒绝。它们是可审计的模型/候选失败，尚未形成 Coloring 证明结论。
