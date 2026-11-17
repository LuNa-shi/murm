# EXP-20261117-05: Issue137 local checking and collaboration acceptance

Status: COMPLETED — original-goal acceptance, protocol and physical cleanup PASS; nested maxRecDepth diagnostic repair FAIL. Overall Issue137 repair acceptance INCOMPLETE; this run does not clear the merge gate.
Approved GitHub Issue: [#137](https://github.com/LuNa-shi/SwarmEnv/issues/137), [owner-authorized one-hour acceptance and merge sequence](https://github.com/LuNa-shi/SwarmEnv/issues/137#issuecomment-6946737402), [approved local-check direction](https://github.com/LuNa-shi/SwarmEnv/issues/137#issuecomment-6948363482).
Implementation PR: [#134](https://github.com/LuNa-shi/SwarmEnv/pull/134).
Comparison: [EXP-20261117-03](EXP-20261117-03-q20-subtree-8h.md) supplies the engineering defect baseline; [EXP-20261117-04](EXP-20261117-04-legacy-cleanup-putnam.md) supplies the mature Putnam fixture and a historical complete-loop observation. These are different implementations/resources; no causal speedup comparison is preregistered.

## Setup

The primary acceptance is a fresh natural-Agent run through actual model, pinned worker, CLI/Bridge, independent Services, Workspace/Judge and fixed-target Mission verification. Success requires trusted original-goal acceptance, valid protocol and confirmed cleanup. Task DONE, helper PASS, busy Cores and successful startup do not substitute for acceptance. Natural behavior and controlled public-entry verification are reported separately; untriggered behaviors remain explicitly unobserved in the natural run.

| Item | Fixed value |
|---|---|
| Implementation | `30908fc5d66387287ef3c24b230201fb15945818`, based on origin/main `9a9c3b731d5131dfb35c5cbc35a4f254ee547fb5`; launch will use its clean documentation-only registration descendant. |
| Treatment | Required Task gap/output/completion/priority, direct take/multiple/ACTIVE proposals, UNBOUND versioned revision/cancellation, accurate errors, scoped Lean module checks with verified cache, bounded serial checker admission, shutdown and evidence-analysis repairs. Existing Mission/Task/Bot/Execution/Core architecture retained. |
| Fixture | `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Fresh initial fixture, no historical proof or operator-authored research Tasks supplied to Bots. |
| Toolchain | Lean4.33.1 `819816b2e0a3bf405af45ae5c7af2491d8f5bee6`; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; Comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659`. |
| Checker | Lock `fc33db1862173593f7fc090382c5d31398cb037993e744176c1585dc8d603018`. Local module/dependency diagnostics and validated process-local cache; full combination checks and original final type/axiom/portable-kernel acceptance remain separate. Local results stay mathematically unassessed. |
| Resources | Exactly4 research Cores, one project; maximum3600000ms including setup; initial stagger60000ms; Bot/Execution1800000ms; selection360000ms; turn settling1800000ms. Ordinary source/merge600000ms, final900000ms. Ordinary4 concurrent/8 queued/900000ms queue wait; no cumulative limit. Final4 admissions/1 concurrent. Checker64GiB/no swap/800%CPU/128tasks, Lake jobs4. Bot writable quota96MiB/8192inodes. |
| Model | `gpt_proxy/gpt-6.1-sol`; gateway180000ms per-request cap. Currency cost unknown without trusted rates. |
| Image | `swarmenv-agent:issue137-30908fc`, `sha256:75d9153c25abc11b2f59a8599862c885072b1ed436f886305fb757fced30bf4a`; Pi1.3.0, no local Lean/Lake/elan. Built only from committed image inputs. |
| Prompt/protocol | `swarm-bot-v1-draft.3`; system composition hash `5bb9a191d10fefc19d91f4b2abdcd80a4892de34d37b40788fe151848da4f5ec`; Workspace skill `9f7c8fed6b1f4b1607a0328ffca09a67a2e83b547552a0bf276f48ae8631dcae`; full immutable resource hashes in private launch manifest. CLI SHA256 `84944ada59b2fc0c3bb08867c37ff46ae1f201548eee106e292e94e47671a99d`. |
| Deployment/launch | Configuration SHA256 `7289a960e4b48f08e30df0ede02466eb33157d10cb7dcb0eb9baa5ecd576ebd8`; private command SHA256 `e8e380e44e40ae97eec079a8b1a1f5a518c1e3a38dd27f9b1aaace7ece0406f8`. Canonical `run-putnambench-benchmark.mjs`, one selected B1 project, explicit arguments above; observation server off, local evidence on. |
| Stop rules | Trusted acceptance may stop early; report actual duration. Stop on startup contract violation, unrecoverable service/checker/protocol failure, or the one-hour limit; retain evidence and repair before another registered attempt. No mid-run code/config changes or silent fixture/model substitution. |

Before launch, independent Spec and Standards reviews both PASS for `30908fc`. Full suite at the verified-local implementation:732 total/713PASS/19environment-or-opt-in skips/0FAIL/0cancelled; subsequent deployment/guidance deltas have focused checks. Separate real Lean/Mathlib/final-kernel suite20PASS/no skips; final image contract3PASS plus disk/inode/write-confinement PASS. Independent real module/admission/HTTP-peer suite22PASS/no skips, including output forgery, early exit, old artifacts, invalid safe declarations, cache reuse/invalidation and lifecycle guards. Final feedback repair has31focusedPASS plus independent real Judge and Agent-projection negatives. Production pinned checker accepts the previously accepted five-file B1 tree and rejects the original placeholder, changed target type and a same-original-type axiom bypass. This is operator-only readiness, not research input or a new autonomous solution. Actual public CLI controlled coverage is distinct from autonomous model evidence.

## Results

本轮原始目标获得可信接受，协议和物理清理通过；资源诊断修复仍有实测遗漏，整体修复验收未完成，不能据本轮合并PR。完整逐Bot、Task和Material采用分析见[独立协作分析](EXP-20261117-05-bot-analysis.md)。Setup保留原登记值；实际launch使用其clean注册后继 `8e6d15213aaccccd7f6ed5aeca10d5b639ab4c6c`，没有运行中替换代码、模型、输入或配置。

| 验收层次 | 结果 | 证据与边界 |
|---|---|---|
| 原始数学目标 | PASS | 唯一受理submission `final-main-review-8727b82f`；独立final check `treecheck:3ef31183-8b1d-4122-8529-f7e1a488ba04`。完整树的原目标type、axiom及portable-kernel门禁保持生效。 |
| Runner protocol | PASS | `protocol_valid=true`，未触发一小时上限，`cleanup_errors=[]`。 |
| 物理清理 | PASS | 13:40:41.315658 UTC独立检查：10/10沙箱provider GET返回404；68/68 checker unit为settled且inactive/not-found、cgroup不存在；Context/Judge进程及进程组均不存在；无pending gate/finish/final admission或live Bot。 |
| 嵌套资源诊断修复 | FAIL | `d95bedef-1039-4764-8d86-3636225c7ddd`将嵌套maxRecDepth耗尽标为FAIL/source_failure，而非资源耗尽ERROR/unassessed。位置保留，Bot修正后PASS，没有false PASS；这不消除误分类。 |
| 整体修复验收／合并条件 | INCOMPLETE | 数学成功不补齐repair FAIL；后续修复、回归和评审不得回填本轮历史结果。 |

Mission `mission:putnam_2025_b1:c7e33366-6b42-4ec7-9083-de24570ee962` 接受main `0.29`，commit `d76d90bd7ea3c919fb052990f3f3952a9517732f`，tree `2f7bc16bdcf351a198c3792ba54f6cde7af049b4`。提交者为UNBOUND `bot:8727b82f-739d-4993-92aa-e24e78a35999`，没有Task/Execution，显式选择的Materials为空。研发中的真实源码采用由固定树证明，不由最终Material选择列表代替。6个Execution均SUCCEEDED，7个Task为6DONE/1CANCELLED，10个Bot全部CLOSED；这些是生命周期结果，不能单独表示数学价值。

### 时间与模型用量

所有时间为2026-11-17 UTC。

| 边界 | 时间 | 含义 |
|---|---|---|
| metadata started_at | 13:23:38.104 | 实验入口，含初始化 |
| Mission created_at | 13:26:04.858 | 权威Mission创建 |
| project run.started_at | 13:26:05.697 | report.elapsed_ms计时起点 |
| 首Bot ready／首Execution开始 | 13:26:09.797／13:26:38.938 | 身份就绪／承责开始 |
| 完整目标并main0.29成功回执 | 13:35:16.769 | merge回执口径；revision创建于13:35:16.072，尚非Mission接受 |
| final submission创建 | 13:35:39.099 | 固定树最终验证开始 |
| accepted | 13:37:32.359 | 原目标正式接受 |
| project run结束／metadata结束 | 13:37:33.423／13:37:34.554 | 两个不同closeout边界 |

metadata到接受为 **834.255秒（13m54.255s）**，project run到接受为686.662秒（11m26.662s）。report.elapsed_ms=687726是project run到结束，不是metadata总时长；metadata总时长836.450秒，初始化至project起点147.593秒。最终验证113.260秒，runner单列cleanup1045ms。与历史约13分钟单Agent或18分钟级样本的实现、资源和计时边界不同，不作因果speedup主张。

最终report与model-budget权威记录一致：191次请求均completed/settled且有usage，输入5,638,605 tokens、输出33,929 tokens；unknown/pending请求均0。采用time_bounded policy `26b24fb7ecc366ac756f35c8f90f2fab405d0d76101b686b79ef8056ddd62406`。所有货币cost记录为空，可信费率和币种未知，因此货币成本为unknown，不能记为0。

### 自然覆盖与控制验证

自然运行实际触发gap/output/completion/priority提案、自提自取、UNBOUND重复提案取消、固定revision局部检查、依赖cache命中、跨Bot助手采用、组合main验证、UNBOUND最终提交与提交冲突保护。自然运行没有单Bot多提案、ACTIVE新提案、跨Bot take或UNBOUND contract revision；这些行为的证据来自单独的实际公共CLI控制测试，不应写成本轮自主覆盖。6个Task的completion contract只含空required_capabilities，没有workspace_delivery门禁；局部DONE的交付真实性由源码检查、merge和采用链另行核对。

普通CheckResult共20项：19次lean-module、1次lean-project，9PASS/11FAIL、0ERROR，数学outcome均unassessed；其中1项FAIL是上述误分类。6次main merge分别对组合树全量检查，最终Mission另验完整树；不得把module回执当full或Mission回执。完整analyzer成功重建6个Execution，warnings=0；这只表示采集／重建完整性，没有覆盖诊断语义缺陷。

### 独立工程性能探针

这是无模型的固定源码工程测量，使用Q20 main `4e0cb4ecc3b6c0d33f60ce323e8ff793dcbcd564`、`PrimeDivisionReverse`、固定toolchain、64GiB/800%CPU及4 Lake jobs。每类3样本，p50/p95采用nearest-rank；n=3时p95就是最大样本，不是总体尾延迟估计。所有样本PASS。

| 检查情形 | 模块数 | 墙钟p50／p95（秒） | CPU p50／p95（秒） | peak process RSS p50／p95（KiB） |
|---|---:|---:|---:|---:|
| 完整项目cold | 93 | 137.096／139.024 | 525.60／533.63 | 4,661,616／4,662,444 |
| 局部closure cold | 24 | 368.285／369.549 | 359.04／359.65 | 6,343,420／6,362,732 |
| 同closure warm | 24 | 1.150／1.173 | 0.85／0.86 | 978,616／980,848 |
| 仅leaf源码变化 | 24 | 17.771／18.538 | 17.05／17.91 | 5,775,404／5,775,568 |

冷局部检查明显回退：它串行执行parser与每模块build/replay，覆盖24模块却比93模块完整构建更慢。warm为24hit/0miss，leaf变化为23hit/1miss，展示了受控复用；两类检查scope不同，不能把局部PASS当完整检查等价物。RSS是实际worker进程峰值而非并发cgroup总内存，CPU为worker累计。自然运行7/19局部请求有命中，共11模块hit/19miss；没有完全命中的请求，也没有同scope/path/目标hash原样重复检查。自然运行没有同输入禁cache对照，cache节省秒数unknown，不能由工程warm时间倒推整轮提速。

## Analysis

最终证明有可验证的分工：计数、两中心几何网格和同圆三点引理由三位Bot交付，主Bot实现颜色归约并接上原目标。最终目标的依赖链为CircleTriple、TwoCenterGrid、ColorReduction→ColorGrid；这些引理的前提在原目标中实际提供，没有留下额外几何假设包装。

并非所有已检查交付都在该依赖链。CircleGridBridge已PASS并merge，但原目标选用主Bot的ColorReduction；HelperAudit有独立检查和Material交付，未并main，也未见触发后续修复或改变最终验证。另四位无Execution的替换Bot分别取消重复审计、发起最终提交、只读核对／等待；不能以活跃身份或DONE数量推断研究收益。7份Task没有显式task relation，没有优先级竞争选择样本，不支持“已改善关键路径排序”的结论。

嵌套maxRecDepth发生在tactic错误的内部层，既有分类器遗漏该资源原因。CheckResult保留位置、completed和retryable=false，却写source_failure；正确处理应保留未完成检查的ERROR/unassessed边界。Bot随后将两处宽泛简化限制为显式引理集，新revision通过，未原树盲重试，也未提高资源。这次可恢复缺陷没有触发登记的unrecoverable-stop条件，因此运行按原配置继续；修复项仍FAIL。后续修复及测试不能改变本次实测结论。

本轮是成熟短Putnam单样本，不能证明Q20可解、8小时效率或更一般的选工质量改善。计时、资源与历史控制不同；helper数、材料阅读率、cache命中数和Core占用只支持具体行为解释，不是成功率或因果收益估计。

## Next steps

保留原始证据和本轮repair FAIL；在Issue137范围完成嵌套资源诊断修复，经过回归、独立Spec/Standards评审及相应正式验收后，再判断合并条件。后续修复测试即使通过，也不能写成本轮已正式验收。本报告不授权新付费实验、改变研究算法或合并PR。

将自然未触发功能继续明确标为controlled-only。若研究替代桥投入、最终验收等待期继续启动Bot或长期优先级排序，应先取得人类对比较问题、资源和验收的批准。本次不以额外实验补写成功叙事。

## Evidence and limitations

公开结果由三项相互独立的只读审核汇合：Task／数学推进、Materials／Workspace接续、四Core价值投入；详细稳定IDs和交付链见[Bot分析](EXP-20261117-05-bot-analysis.md)。权威证据是本EXP最终report、model-budget、固定Workspace revisions、Bridge及实际tool返回、只读终态快照、物理cleanup检查、完整analyzer，以及三轮工程performance-summary。原始证据仅保留于ignored本地实验目录；本报告不复制证明、对话、stdout、数据库或私密路径。快照为顺序跨库backup，非原子跨库事务；终态已停止，关键输入另由不可变Git revision交叉核实。

局部artifact replay保留普通Lean frontend/metaprogram信任假设，不是对任意恶意native driver协议伪造的attestation；最终Mission信任边界不变。历史EXP03仍UNSOLVED且protocol-invalid。本次数学接受、runner有效性、物理清理、修复验收和PR状态分别报告。
