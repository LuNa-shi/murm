# EXP-20261117-06: Issue137 acceptance after diagnostic and deadline-attribution repairs

Status: COMPLETED — original-goal acceptance, protocol and physical cleanup PASS. Nested-resource repair naturally exercised and independently audited; long-horizon efficiency remains unverified.
Approved Issue: [#137](https://github.com/LuNa-shi/SwarmEnv/issues/137), [owner-authorized review, short acceptance and merge sequence](https://github.com/LuNa-shi/SwarmEnv/issues/137#issuecomment-6946737402).
Implementation PR: [#134](https://github.com/LuNa-shi/SwarmEnv/pull/134).
Repeat of: [EXP-20261117-05](EXP-20261117-05-issue137-putnam-acceptance.md), which accepted B1 with valid protocol and cleanup but left nested recursion-limit diagnostics misclassified. Its historical results are unchanged.

## Setup

Use a fresh B1 fixture and new Mission. No prior proof, operator-authored Task or prior Material is supplied to Bots. This is the same approved one-hour/four-Core acceptance with targeted diagnostic and deadline-attribution repairs after collecting the EXP05 and regression findings. The repair recognizes structured recursion-limit tags and bounded leading tactic-error wrappers in source, module, project and final diagnostics; it preserves ERROR/unassessed/nonretryable/completed instead of calling resource exhaustion a mathematical source failure. Arbitrary goal words remain ordinary content. When selection is capped to the exact Bot hard deadline, either timer now records bot-lifetime-budget; a genuinely earlier selection deadline remains selection-budget. Timer deadlines, lifecycle guards and cleanup are unchanged. The prior test-only clock change did not repair this reason race; a separate runtime change and forced callback-order regressions do. Core organization, prompts, provider/model, fixture and final proof acceptance remain unchanged from EXP05.

| Item | Fixed value |
|---|---|
| Implementation | `ccdd5c7e7ba7185d48718a63172244fae81dd4f1`, based on origin/main `9a9c3b731d5131dfb35c5cbc35a4f254ee547fb5`; launch will use its clean documentation-only registration descendant. |
| Treatment | Required Task gap/output/completion/priority, direct take/multiple/ACTIVE proposals, UNBOUND versioned revision/cancellation, accurate errors, scoped Lean module checks with verified cache, bounded serial checker admission, shutdown and evidence-analysis repairs. Existing Mission/Task/Bot/Execution/Core architecture retained. |
| Fixture | `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Fresh initial fixture, no historical proof or operator-authored research Tasks supplied to Bots. |
| Toolchain | Lean4.33.1 `819816b2e0a3bf405af45ae5c7af2491d8f5bee6`; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; Comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659`. |
| Checker | Lock `fe70782daba683badeceb5f477bce67b475777facfdcc2c46ce0e49d55c3120c`. Local module/dependency diagnostics and validated process-local cache; full combination checks and original final type/axiom/portable-kernel acceptance remain separate. Local results stay mathematically unassessed. |
| Resources | Exactly4 research Cores, one project; maximum3600000ms including setup; initial stagger60000ms; Bot/Execution1800000ms; selection360000ms; turn settling1800000ms. Ordinary source/merge600000ms, final900000ms. Ordinary4 concurrent/8 queued/900000ms queue wait; no cumulative limit. Final4 admissions/1 concurrent. Checker64GiB/no swap/800%CPU/128tasks, Lake jobs4. Bot writable quota96MiB/8192inodes. |
| Model | `gpt_proxy/gpt-6.1-sol`; gateway180000ms per-request cap. Currency cost unknown without trusted rates. |
| Image | `swarmenv-agent:issue137-ccdd5c7`, `sha256:e48a70e9d8c4844ecd321005a611c660897ca0f8a736ea45b365d0c48bf983d1`; Pi1.3.0, no local Lean/Lake/elan. Built only from committed image inputs. |
| Prompt/protocol | `swarm-bot-v1-draft.3`; system composition hash `5bb9a191d10fefc19d91f4b2abdcd80a4892de34d37b40788fe151848da4f5ec`; Workspace skill `9f7c8fed6b1f4b1607a0328ffca09a67a2e83b547552a0bf276f48ae8631dcae`; full immutable resource hashes in private launch manifest. CLI SHA256 `84944ada59b2fc0c3bb08867c37ff46ae1f201548eee106e292e94e47671a99d`. |
| Deployment/launch | Configuration SHA256 `d99308c03e2a716bff4ff63cfe999e9ee6d06d4e07d2388ee7c4c04ed05cdef7`; private command SHA256 `7c3e2d1cb62f7202d8e4c3e4fcd030581346baadb424173317eeb120ab88928d`. Canonical `run-putnambench-benchmark.mjs`, one selected B1 project, explicit arguments above; observation server off, local evidence on. |
| Stop rules | Trusted acceptance may stop early; report actual duration. Stop on startup contract violation, unrecoverable service/checker/protocol failure, or the one-hour limit; retain evidence and repair before another registered attempt. No mid-run code/config changes or silent fixture/model substitution. |

Independent Spec and Standards PASS apply to `ccdd5c7`. Focused real Lean raw/module/project/final regression, split-stream/goal-word negatives and both deadline-callback orders plus genuinely earlier selection/Task deadlines pass. The original real-enabled full run is retained as736total/725PASS/10SKIP/1FAIL due to the termination-reason race; it is not relabelled as green. The corrected implementation must pass a fresh complete suite before launch. Full tests with real Lean/Mathlib/Comparator/cgroup isolation and the renewed production-lock positive/negative checks must finish before launch; image contract3PASS and disk/inode confinement are already verified. The source/diagnostic change requires a fresh lock and image; matching fixture and semantics are not a claim of byte-identical environments.

## Results

本轮原始B1目标获得可信接受，协议与独立物理清理通过。实际launch为清洁注册后继 `d5e07ac5d027ebd0ac7445fc95c3d38dd226e2b3`，运行实现为 `ccdd5c7e7ba7185d48718a63172244fae81dd4f1`；没有运行中改动代码、输入、模型或配置。完整逐Bot行为见[11Bot分析](EXP-20261117-06-bot-analysis.md)。

### 实际验证门禁与登记差异

独立Spec与Standards对最终runtime均PASS，启动审计核对代码、镜像、lock、资源和原始fixture。最终完整默认 `npm test` 为 **737total /699PASS /38environment-or-opt-in SKIP /0FAIL /0cancelled**。登记Setup中写过“full tests with real Lean/Mathlib/Comparator/cgroup isolation”；实际最终整套运行没有打开全部opt-in环境，不能把这句话当作已经发生的全环境测试。真实Lean/module/Judge/HTTP peer、最终kernel、诊断、生产锁正负例、镜像及confinement分别由额外真实接缝检查覆盖；这与所有opt-in测试在最终commit一起重跑并不等同。旧real-enabled整套保留为736total/725PASS/10SKIP/1FAIL，失败是随后修复的等deadline终止原因竞争。最终改动的两个callback顺序、较早selection和Task边界由确定性回归及独立评审验证，不能回填旧suite为通过。

生产锁再次接受完整正确树，拒绝原placeholder、改目标type、原type新增axiom绕过。历史正确树只用于operator readiness，未进入Bot输入。镜像contract3PASS与实际写入/磁盘/inode隔离PASS；docs生成、docs检查和diff检查PASS。启动前的Issue记录已明确上述skip和历史失败，原Setup保留供核对。

| 验收层次 | 结果 | 证据与边界 |
|---|---|---|
| 原始数学目标 | PASS | 唯一submission `submit-complete-proof-1`；final `treecheck:0e548d27-4f6f-4947-9344-3b2fc4a15af7`。原目标type、axiom和portable-kernel门禁保持不变。 |
| Runner protocol | PASS | `protocol_valid=true`，提前接受，`cleanup_errors=[]`，没有达到一小时上限。 |
| 物理清理 | PASS | 14:42:04.382 UTC核实11/11sandbox provider GET404；64/64 checker unit settled/inactive，无cgroup；Context/Judge进程及进程组不存在；pending gate/finish/final admission和live Bot均0。 |
| 嵌套资源诊断 | PASS，natural | 嵌套recursion耗尽和heartbeat耗尽均返回ERROR / `lean_resource_limit` / unassessed / nonretryable；新源码或依赖revision后PASS。未把未完成检查判作数学FAIL/PASS。 |
| 等deadline原因归属 | PASS，controlled-only | 最终确定性两种callback顺序均为bot-lifetime-budget；本轮没有自然触发此边界，不算自然覆盖。 |
| 长程效率／单Agent并行优势 | 未验证 | 本次为成熟短B1单样本；不替代Q20、八小时或匹配资源的对照。Issue137相应目标继续开放。 |

Mission `mission:putnam_2025_b1:c45cede6-305e-4783-8cc3-9f83ec699294` 接受main0.24，commit `95ea2be3d2b532d7f6aa7ac70be5d02234e2294f`，tree `0cf72277d0f8d0d11d00bcf721c5c3d1c27674fc`。提交者 `bot:5c176c70-ed16-4a21-a5d4-9cb05207652f` 仍绑定Task `33705e65-8aa0-4fae-9de0-cd3887b7bd47` / Execution `0bb1b597-a70b-4187-95c9-8224fe00a81f`，选择整合Material `0e36260f-a3b9-488b-a5d6-a832963bc98f`。6Task全部DONE、6Execution全部SUCCEEDED、11Bot全部CLOSED。这些生命周期状态不单独证明研究价值。

### 时间与用量

所有时间为2026-11-17 UTC。

| 边界 | 时间 |
|---|---|
| metadata started_at | 14:25:25.598 |
| project run.started_at | 14:27:56.675 |
| 首Bot ready | 14:28:00.678 |
| final submission创建 | 14:39:15.927 |
| accepted | 14:41:11.507 |
| project run结束 | 14:41:12.465 |
| metadata结束 | 14:41:13.475 |

metadata到接受 **945.909秒（15m45.909s）**；project到接受794.832秒（13m14.832s）。report.elapsed_ms=795790为project到结束；metadata总时长947.877秒。最终验证115.580秒，runner单列cleanup936ms。一小时是上限，并非实际持续一小时。EXP05相同metadata边界为834.255秒；本次多111.654秒。这两个随机协作轨迹不能用来隔离代码修复的性能效应。

198次模型请求全部有usage，unknown/pending均0；输入6,335,334 tokens、输出39,058 tokens。time_bounded policy `26b24fb7ecc366ac756f35c8f90f2fab405d0d76101b686b79ef8056ddd62406`。货币费用及可信费率未知，不记为0。

### 局部验证、修复与独立最终验收

18次普通检查全部为lean-module，9PASS/6FAIL/3ERROR，数学outcome均unassessed。9次请求命中cache，共26个dependency artifact hit /18target miss，无完全命中请求。最终原目标仍经组合树检查与独立fixed-target验收；局部PASS没有替代它们。完整analyzer重建6Execution，inventory warnings=0。

| 触发与固定输入 | 返回 | 后续实际行为 |
|---|---|---|
| `8ab5f818-8023-458b-b0b2-b1b079d25495`，IncidenceBridge0.14，14:34:34.932→14:34:48.209 | 嵌套simp recursion耗尽；ERROR / lean_resource_limit / completed / unassessed / retryable=false，保留39:2位置 | 修改源码；0.16普通source FAIL，0.18通过 `4ff5cb3c-8db5-4d6b-b547-965c2386a71f`。没有原树盲重试。 |
| `30753927-ef36-4505-8e7d-5482e9f22092`，原目标0.20 | heartbeat资源耗尽，保持同样ERROR边界 | 修改原目标形成0.21，通过 `95d1f301-91fe-450b-bc0a-a73163c5643a`，随后整合main0.24。 |
| `0ce5f9f7-a274-4c7c-a792-1c4738d434d7`，TrustAudit0.22检查 | 导入旧目标源码的heartbeat耗尽，正确ERROR | TrustAudit文件未变，但依赖切换到已修正原目标；0.23通过 `83c62c99-ad33-4829-b90e-0955b541d40b`检查。所选TrustAudit文件hash相同，导入的原目标hash已变化，因此完整输入不同。 |

普通错误的result_class仍为infrastructure_failure，但资源ERROR带具体诊断并保持checker健康；不能从这一通用字段推断服务崩溃。这三项资源ERROR包括同一旧目标问题在审计依赖中的再次暴露，不是三个相互独立的根因。EXP05原有错误分类仍为历史FAIL，不受本轮修复结果改写。

### 修复与验收对照

| Issue137修复 | 自然证据 | 额外控制证据／限制 |
|---|---|---|
| Task gap/output/acceptance/priority合同与选择自由 | 6份具体合同、自主选择和自提自取；优先级非全相同 | 多提案、ACTIVE提案、跨Bot take、UNBOUND版本修订由实际CLI→Bridge控制测试覆盖；本轮这些行为及取消均未自然触发；EXP05另有自然取消样本，不能混入本轮。 |
| 版本化Workspace接续与Material采用 | 最终树组合多Bot助手与整合模块，完整采用链见Bot分析 | 读取、consume、源码引用、merge、最终依赖分别核对，计数不自动代表价值。 |
| 选定模块/dependency局部检查与可信缓存 | 18局部请求，9有dependency cache命中 | 冷/热/leaf固定Q20探针、伪产物/早退/无效safe声明/失效/跨Mission隔离由真实控制检查覆盖；本轮无cache-off对照。 |
| 资源诊断及准确反馈 | 嵌套recursion与heartbeat自然ERROR后源码/依赖调整并PASS | raw/module/project/final与split-stream/goal-word负例均有回归；module_verification_failed保真另有真实链路测试。 |
| Judge有限串行计划与cleanup | 局部多阶段完成，64unit最终全部清理，无pending | admission、fencing、超时与并发边界通过独立真实控制测试；不能因本轮未触发就称自然覆盖。 |
| 等deadline生命周期原因修复 | 未自然触发 | 两种callback先后及真正较早selection/Task均确定性验证；原失败记录保留。 |
| 大证据分析修复 | 本轮完整analyzer6E/0warnings；EXP03离线重建102E/0warnings | 历史EXP03当时自动分析失败及protocol-invalid不改变。 |
| 文档、prompt与实际部署一致 | 固定draft.3镜像、CLI/skill/prompt hashes与正式真实部署 | Architecture、source-map、生成引用、image contract与独立Spec/Standards形成版本绑定证据。 |

## Analysis

最终原目标的依赖为CircleColor、CircleGrid、IncidenceBridge，后者调用IncidenceCounting。四个助手均经过检查和merge，hash与交付版本一致，没有额外未用助手进入main。6/6Materials都有跨Bot完整正文送达，共21个Bot×Material对；6/6consume前均有完整正文。四项integration记录中，一项是纸面路线，三项是源码接口；另两项是独立审计采用，不能算成六次定理调用。纸面路线的引用与实际实现方向一致，但不能从中恢复Agent隐含推理或宣称唯一因果贡献。

独立审计Bot提供了明确的未合main版本接续：它应用整合者的0.20，保存0.22，重现旧目标依赖的heartbeat资源ERROR；再应用已修正但尚未合main的0.21，形成parents=[0.22,0.21]的0.23，六模块检查PASS。TrustAudit源码本身相同，依赖树已变。因此不能把这对检查算作相同完整输入的盲重试。审计交付本身没有进入最终目标证明依赖，不能给它与最终采用助手相同的数学贡献。

四Core同时承责窗口只有14:31:51.319–14:32:01.420和14:32:57.822–14:33:13.266，合计25.545秒。按Execution.started_at到终态updated_at计算总责任1523.621 Core秒；ordinary check按每Execution的created_at→updated_at取并集后求和251.076 Core秒，包含服务/排队/处理，不能直接解释为纯编译或Bot完全停顿。其余责任时间也不是纯有效证明时间。

最终验收115.580秒期间还启动B009/B010/B011；startup合计12.930 Core秒，新身份接受前寿命152.594 Core秒，所有UNBOUND ready窗口与final重叠339.091 Core秒。这些窗口有读取/观察活动但没有新Task，未见改变已冻结目标；这是可观测尾段投入，不证明应当直接修改调度策略。六次take全为自提自取，缺少有竞争候选任务的优先级选择样本；本次不能说明已解决长期关键路径投入不足。

唯一普通Agent工具错误是首Bot读取尚未存在的临时Mathlib参考文件，随后改用固定commit的公开参考源码与Mathlib search并完成助手；不是checker崩溃。另有最终提交冲突，已被明确拒绝。四个identity loop最终均保留PROCESS_EXITED及take_failure_count=1，最后STOPPING事件在接受后6–14ms。独立评审进一步核对report.run.identity_loop_events的105–108项：四次identity_loop_take_failed回调在14:41:11.581/.590/.597/.604，分别晚于接受74/83/90/97ms；每Core只有一次failed事件、无其他failed/invalid，因而是最终错误汇总的唯一候选对应。事件清洗保留kind和时刻但不保留error正文，原生会话错误首次产生时间仍未单独记录，不能与回调时刻混同。现有关闭流程停止loop/controller并终止等待agent_settled的会话，失败回调确实位于接受后停止阶段；这些字段如实保留，不构成新的不可恢复服务故障证据。无Execution失败、接受丢失或物理资源残留证据。

本次是成熟短任务、单个随机协作轨迹。真实跨Bot复用与局部cache命中均已观察，但四Core同时推进覆盖很短，final期间仍有额外身份成本。没有匹配的单Agent/禁cache反事实，不能据此断言并行胜出、计算节约或Q20长程选工质量已经改善。

## Next steps

逐Bot、Material/Workspace和并行价值三项独立审计已完成，公开结果的关键统计与隐私边界通过各轴复核。运行代码与Architecture保持已评审runtime不变；将最终报告与测试证据进行独立Spec/Standards收口并逐项回写Issue137/PR134，通过后按既有用户授权合并。PR状态以GitHub合并记录为准。本次不自动启动下一轮付费实验，不关闭未验证的长程效率目标，也不改变EXP05或EXP03的历史结果。

## Evidence and limitations

原始来源为本EXP metadata、report、model-budget、权威Task/Execution/Material记录、固定Workspace revision、逐物理请求Bridge回执、独立三轴审计、cleanup探针与完整analyzer。公开仅包含必要稳定ID、时间、数量及行为摘要；证明源码、原始对话、stdout/stderr、数据库、凭据与私有路径不公开。终态快照为顺序跨库备份，不是原子跨库事务；关键产物另按不可变Git revision核对。

局部验证最低粒度是选定文件及其必要依赖，不是多声明文件内的任意单声明；可将独立定义/lemma组织成模块以缩小诊断范围。可信artifact缓存保留普通Lean metaprogram/frontend信任假设，不宣称对恶意native driver的密码学attestation。最终Mission完整性门禁独立保留。

固定Q20工程性能结果见[EXP05工程探针](EXP-20261117-05-issue137-putnam-acceptance.md#独立工程性能探针)：3样本每类，cold全量p50为137.096秒、cold局部368.285秒、warm局部1.150秒、leaf修改17.771秒。冷局部存在真实回退；warm/leaf收益不能换算为本轮节约秒数。该性能探针早于后续诊断/期限原因修复，不是本轮重新跑过的性能suite。Q20历史八小时仍UNSOLVED/protocol-invalid；本轮短任务不证明长程效率、千级扩展或相对单Agent的因果优势。
