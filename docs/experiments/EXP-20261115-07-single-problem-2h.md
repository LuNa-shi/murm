# EXP-20261115-07: Four-Core single-project two-hour maximum validation

Status: BLOCKED (operator stopped after owner clarified continued gap discovery)
Approved GitHub Issue: [#122 and owner decision](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563)
Implementation: `6a256d6d4ed53d7b8281de1fd2f05ff21c28a94b`; independent Spec/Standards review covered renewable model authority, late-heartbeat rejection and production checker memory enforcement before registration.
Follow-on to: [EXP-20261115-06](EXP-20261115-06-single-problem-30m.md), which reached locked Mission acceptance in 462,488 ms with valid protocol, four self-proposed/self-taken successful Executions, healthy checks, all 190 model requests settled with usage, and all 12 Bots cleaned up. Independent content and lifecycle observers confirmed these results. This established successful end-to-end execution within the 30-minute allowance, not a 30-minute endurance result. The same success stop rule applies here; the two-hour limit is an upper bound.
Comparison: descriptive comparison with [formal24](issue122-formal24-gap-analysis.md); this is not a controlled causal comparison.

## Setup

This run observes the approved Phase 02 behavior with a real model after independent Spec and Standards review. The Mission begins with zero Tasks. Four independent Cores should discover public work, propose bounded responsibilities where needed, take before execution, and continue through publicly saved work and Materials. Existing actionable work has priority over unnecessary proposals. An individual Bot owns at most one Execution. A proposal is not required when appropriate existing work can be taken.

| Item | Fixed value |
|---|---|
| Source | Runtime `6a256d6`; launch commit is recorded in `metadata/experiment.json`. Registration and architecture-only commits do not change runtime code. Clean worktree required at launch. |
| Agent image | `swarmenv/agent:issue122-stable-6a256d6`; `sha256:c7ae7618ee99433bbac8f3f4e9abedd8b20aa7ddce9134cfbf6760f5fa12a5a7`; Pi 1.3.0 |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7` |
| Checker | Lean 4.33.1; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659` |
| Artifact lock | SHA256 `4286e094c584f324873da37a04ab452946619489f2694f4c3fb15d9da79d7c0a`; regenerated verifier fingerprint; unchanged fixture, dependencies and resource configuration |
| Provider/model | `gpt_proxy/gpt-6.1-sol`; actual host credentials, per-Bot local gateway tokens, no scripted model responses |
| Prompt/profile/schema | Prompt manifest SHA256 `884dfcc526431d8a5d75c0b921a056c83c1359c3f502c9215518f97bc92aa841`; system text `683af4e09fe2b53ee766fb62bbc04000ed2fb2afe89f9ec00e51e6b933c0c5c5`; Pi catalog `2f7af32c853568f358b7c7fabb66d6992df5fbc727eac777130e1650ed124070`; CLI `518de4acc10bf56a875e93bf08eab9fcadb797954042522da44639a0e560dbf4`. Actual sent messages remain private evidence. |
| Concurrency/time | 4 Cores, 1 project; Mission 7,200,000 ms including setup, Bot/Execution 1,800,000 ms, selection 180,000 ms, turn setting 180,000 ms; shared cleanup grace 30,000 ms |
| Model bounds | Time-bounded mode; request limit 180,000 ms intersected with lifecycle deadlines; requested output cap 32,768 tokens. No currency/rate contract; actual cost unknown. No local meter used as a substitute. |
| Isolation | OpenSandbox release-1.2.0, local Docker network allowlist, 100,663,296-byte/8,192-inode per-Bot writable filesystem; coordination grant only `mission_submit` |
| Judge bounds | Unchanged defaults: 20 source admissions / 2 simultaneous, 4 final admissions / 1 simultaneous; source FAIL is distinct from infrastructure failure |
| Deployment configuration | Private nonsecret overlay of locked 12-problem catalog, selected with `--problem`; SHA256 `eee79495a2e8e955ca79320421506011a66ce142efac3f90845075666cf36ee4`. Host-local paths are retained only in private provenance. |
| Evidence | Ignored `experiments/EXP-20261115-07/`; aggregate/project output under ignored `reports/EXP-20261115-07/`; semantic reconstruction under the experiment's `analysis/` |

Invocation, with `DEPLOYMENT_CONFIG` and `PUTNAMBENCH_ROOT` resolved to the verified private local deployment:

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue122-stable-6a256d6 \
SWARMENV_OPENSANDBOX_URL=http://127.0.0.1:8080 \
SWARMENV_OPENSANDBOX_ENDPOINT_HOST=127.0.0.1 \
SWARMENV_BRIDGE_HOST=172.17.0.1 \
SWARMENV_BRIDGE_PUBLIC_URL='http://172.17.0.1:{port}' \
node scripts/run-putnambench-benchmark.mjs \
  --problems "$DEPLOYMENT_CONFIG" --putnambench-root "$PUTNAMBENCH_ROOT" \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 7200000 --bot-max-ms 1800000 --selection-timeout-ms 180000 \
  --execution-timeout-ms 1800000 --turn-timeout-ms 180000 \
  --provider gpt_proxy --model gpt-6.1-sol \
  --observability-metadata experiments/.observability/time-bounded-server.json \
  --experiment-dir experiments/EXP-20261115-07 --report-dir reports/EXP-20261115-07
```

Stop at the Mission deadline or trusted Mission acceptance, followed by bounded cleanup; stop and diagnose a systemic authorization, provider, or protocol failure. The preceding pilot satisfied the observed execution health gate. This longer allowance tests the same model and contract without changing task hints, fixture or acceptance; it does not force continuation after Mission acceptance. Independent subagents inspect actual content. Solving B1 is reported separately and is not the health gate. Capability paths not triggered are recorded as unobserved, not passed.

## Results

项目自 14:58:58.364 运行到 15:15:31.239 UTC，共 992,875 ms。用户在运行期间明确未完成的 Mission 需要持续查缺口和提出工作，操作员随后优雅停止旧规则下的运行。最终报告为 `ended_early=true`、`deadline_reached=false`、`protocol_valid=false`、`invalid=true`（`operator_stop`）、`solved=false`；Mission 仍为 open。5 个 Task 全部 DONE，13 个 Bot 全部 CLOSED，未发现模型运行中请求。报告记录 10 ms 清理、无清理错误和未处理拒绝。

首波 4 Bot 各自提议并领取自己的 Task，持久创建者和 E owner 一致。四个初始 E 从 14:59:51.715 到 15:02:54.237 UTC 同时工作，182.522 秒。Core 2 新 Bot 接续后再次与其余在途执行并行。全部五个有效 finish 都关联准确的公开 R 和普通 PASS 的 CheckResult。

| Core / Bot | 提议、执行、交付与退出 |
| --- | --- |
| 4 / `2461aceb` | 提议并领取完整有限圆交网格证明 `f139bb1d` / E `846481c6`。最初对 R 0.1 的请求被占位符规则拒绝，R 0.7 真检查失败，R 0.8 与 R 0.11 普通 PASS。最后是 3×7 网格变体，合并 R 0.11 为 main R 0.13，发布 M `c020e535`，提交 `grid-submit`，用 R 0.11 / `91d4b5cf` finish done。 |
| 2 / `4c760da2` | 从空队列提出并领取圆周刚性和颜色桥接 `007cb982` / E `d467e9f2`，责任独立于网格和计数。查看其他完整证明 Task，辅助文件 R 0.3 检查失败，修成 R 0.6 / `b673da67` PASS。发布 M `116b1a7b`，首次 finish 引用未链接 Material 被拒，随后凭固定 R/CheckResult 有效 done。 |
| 3 / `f0faded9` | 提议并领取完整双圆心相交圆网格 `d4c4734f` / E `c73d64fc`。R 0.2 占位符拒绝，R 0.4、0.9 真检查失败，遇 `CHECKER_BUSY` 后重试，R 0.12 / `d12b24d2` 普通 PASS。读了 Core 2 的 M `116b1a7b` 与 Core 4 的 main R 0.13，发布自己的备选 M `6bc66843`，完成 done。无 apply 或主线改写。 |
| 1 / `ddef6b8a` | 提议并领取完整 5×5 圆交网格 `2d4a9856` / E `0de1a00b`。初读公开 R 0.1，检索 Mathlib，R 0.5、0.10 真检查失败，R 0.14 / `66c42c8c` 普通 PASS。查看已有主线后发布备选 M `ac628f5f`。两次带尚未链接的 Material 的 finish 被拒，随后用 R/CheckResult 完成 done。 |
| 2 / `b3f9f1fb` | 前任释放后新 Bot 阅读原有几何辅助与其他工作，提出并领取几何无关的布尔网格计数 `fd62deda` / E `25383ae8`。读取前任 R 0.6 和 M `116b1a7b`，初次 consume ID 参数不符合数组合同；改用合法载荷后，持久记录使用确切 M v1，影响是选定三点互异排除与行列颜色方向。单独保存计数辅助 R 0.15 / `170ccf4f` PASS，发布 M `b5186006` 并有效 done。 |
| 3 / `5a29c448` | 查看当前 main R 0.13、源候选 R 0.11、对应 Task 和 M `c020e535`。未提议或领取，显式 no-work。 |
| 4 / `7da2b67e` | 对照原证明及另一条备选和两份 Material；最终超时后重提同一快照，服务返回重试额度耗尽。无新 E，显式 no-work。 |
| 1 / `63bb5920` | 读已有合并证明的 Task、M `c020e535` 和 main R 0.13，无新 E，显式 no-work。 |
| 3 / `af6c138c` | 对照已合并的证明与 M，实际重新提交同一快照，服务返回重试额度耗尽。无新 E，显式 no-work。 |
| 2 / `5e913d4a` | 比较主线 R 0.13、两个证明 Task 和证明说明，未造成公开状态变更，显式 no-work。 |
| 4 / `347ada2a` | 比较已合并证明与未合并备选，读取三条证据 Material；未提出新 Task，显式 no-work。 |
| 3 / `efcee801` | 检查主线证明、关联 Task/Material 及现有提交，没有受理的新操作，显式 no-work。 |
| 1 / `2c69b1d2` | 阅读更新后的 main 与已完成 Task/证据，搜索可继续责任，未提议或领取，显式 no-work。 |

普通 Judge 15 个请求，6 PASS、6 source FAIL、3 占位符拒绝，无基础设施错误，另有 BUSY 请求在上限处明确拒绝。实际唯一启动的最终 Mission 验收固定 main R 0.13 和 M `c020e535`，从 15:04:14.553 到 15:06:14.647 UTC，结果 `SERVICE_TIMEOUT`，冻结已释放。随后两个同一快照的新请求均以 `MISSION_RETRY_EXHAUSTED` 结束，无独立科学判定。可见模型 193 个请求全有用量、零 unknown，输入 4,173,733、输出 37,309 tokens，费用未知。

## Analysis

Core 1/3/4 都提出完整网格证明，三条路径有实质重叠，也产生了各自经普通检查的候选。四个首波 Bot 的最后一次提案前 task list 都返回空，查询时间为 14:59:22–28；第一条提案于 14:59:34 受理，最后一条于 14:59:46 受理。它们依据的是同一个近同时的空队列快照，这一轮不能用来判断 Bot 看见可领取的积压任务后是否优先选择。续轮 Core 2 则确实先读到四条已有责任，再提出与其他在途责任可区分的计数辅助。采纳的是 Core 4 改用 3×7 的方案，其余候选依旧有比较价值。Core 2 的两个不同 Bot 先后完成独立几何/布尔计数，第二个 Bot 不只读取前任成果：确切版本 consume 有明确选择影响，并产生后续公开辅助文件和 PASS。它使用了前任的接口来设计计数边界；未见导入前任源码的 apply，也没有共同变更进入被提交的主线树。Core 3 只查阅了几何材料，无可确认的后续使用。此轮因此观察到确实的跨 Bot 信息接续，未观察到多 Bot Git 变更共同合入。

后继的八次 no-work 共 56 个模型请求、851,477 输入 tokens。冻结期间比较已完成任务可以避免重复新任务；超时且同快照重试耗尽后，Bot 没有发起一个以替代证明推进验收的新任务和新快照。普通源检查 PASS 不能替代锁定验收，所以此时还有未完成的 Mission 条件。该观察暴露自治恢复缺口，但单凭工具结果不能判断 Bot 对替换 main 的风险做了私下何种权衡。这轮实施允许把未发现合适已存在责任作为 no-work 结束；用户是在运行期间明确更新规则，不能把新条件当作旧版实验开始时已批准的合同。

## Next steps

这轮两小时上限验证因操作员停止而未完成，不能作为旧实现的通过记录。用户新要求应覆盖队列清空、验收尚待判定或最终 checker 失败后的查缺口和可执行 Task 提案。此次实际只读观察未更改实验输入、运行期存储或源码。

## Evidence and limitations

Launch commit `10998df7a123e7f46e7ce434b311154d7e32a55a`, clean worktree, unchanged runtime `6a256d6`. The owner [clarified continued Bot-driven gap discovery](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6896705828) during the run; its earlier permissive no-work behavior is preserved as evidence, not retroactively described as passing the new requirement. Independent system observer verified 13/13 scoped sandboxes returned HTTP 404. Final cleanup took 10 ms with no errors.

The trusted final checker used approximately 24.0 s for original export, 36.8 s for candidate export and 58.5 s of replay before the absolute 120 s cutoff. EXP-06 used approximately 18.1 / 24.7 / 66.0 s and passed. These are different proof snapshots; a longer limit has not been tested and would not guarantee acceptance. Configured zero infrastructure retries correctly rejected the unchanged snapshot.

Local `analysis/experiment-analysis.md`, `analysis/bot-observation.md`, `analysis/system-observation.md` and `analysis/design-gap-review.md` preserve separate automated, semantic, system and contract views. Raw Agent conversations, proof source, credentials, logs, databases and private paths remain ignored. Actual model currency cost is unknown. This is an interrupted two-hour-maximum attempt, not a completed two-hour experiment.
