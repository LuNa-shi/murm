# EXP-20261115-06: Four-Core single-project 30-minute validation

Status: PASS (Mission accepted before the 30-minute maximum)
Approved GitHub Issue: [#122 and owner decision](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563)
Implementation: `6a256d6d4ed53d7b8281de1fd2f05ff21c28a94b`; independent Spec/Standards review covered renewable model authority, late-heartbeat rejection and production checker memory enforcement before registration.
Repeat of: [EXP-20261115-05](EXP-20261115-05-single-problem-30m.md), rejected before Bot/model activity because its deployment lock still pinned the previous verifier implementation. The regenerated lock changes only the verifier artifact fingerprint. Full locked-verifier validation passed with the same fixture, toolchain and 4 GiB resource guard before this registration. Runtime code and Agent image are unchanged.
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
| Concurrency/time | 4 Cores, 1 project; Mission 1,800,000 ms including setup, Bot/Execution 600,000 ms, selection 180,000 ms, turn setting 180,000 ms; shared cleanup grace 30,000 ms |
| Model bounds | Time-bounded mode; request limit 180,000 ms intersected with lifecycle deadlines; requested output cap 32,768 tokens. No currency/rate contract; actual cost unknown. No local meter used as a substitute. |
| Isolation | OpenSandbox release-1.2.0, local Docker network allowlist, 100,663,296-byte/8,192-inode per-Bot writable filesystem; coordination grant only `mission_submit` |
| Judge bounds | Unchanged defaults: 20 source admissions / 2 simultaneous, 4 final admissions / 1 simultaneous; source FAIL is distinct from infrastructure failure |
| Deployment configuration | Private nonsecret overlay of locked 12-problem catalog, selected with `--problem`; SHA256 `eee79495a2e8e955ca79320421506011a66ce142efac3f90845075666cf36ee4`. Host-local paths are retained only in private provenance. |
| Evidence | Ignored `experiments/EXP-20261115-06/`; aggregate/project output under ignored `reports/EXP-20261115-06/`; semantic reconstruction under the experiment's `analysis/` |

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
  --timebox-ms 1800000 --bot-max-ms 600000 --selection-timeout-ms 180000 \
  --execution-timeout-ms 600000 --turn-timeout-ms 180000 \
  --provider gpt_proxy --model gpt-6.1-sol \
  --observability-metadata experiments/.observability/time-bounded-server.json \
  --experiment-dir experiments/EXP-20261115-06 --report-dir reports/EXP-20261115-06
```

Stop at the Mission deadline or trusted Mission acceptance, followed by bounded cleanup; stop and diagnose a systemic authorization, provider, or protocol failure. The follow-on two-hour run is conditional on healthy real-model activity, genuine overlapping Executions rather than merely allocated Cores, meaningful proposal/take/work traces, no unresolved infrastructure failure, and confirmed cleanup. Independent subagents inspect actual content. Solving B1 is reported separately and is not the health gate. Capability paths not triggered are recorded as unobserved, not passed.

## Results

Launch commit `72b4487197e075bd66722241dc703d7549ee8ac7`, clean worktree; unchanged runtime `6a256d6`. Actual elapsed **462,488 ms** with cleanup **950 ms**, zero cleanup errors. `protocol_valid=true`, `invalid=false`, `solved=true`. Mission submission `submit-circle-grid` accepted main revision `0.14`, final check `treecheck:eb901a3f-002f-4e39-90db-8ccbcb146c94` at 2026-11-15T14:55:11.977Z.

Four initially empty Core lanes each proposed and took a Task, and all four Executions succeeded. All four Tasks ended DONE. All 12 Bots closed; the independent observer verified every sandbox returned HTTP 404. Ordinary Judge results: 5 PASS, 7 source FAIL and 1 request rejection, zero infrastructure failures, healthy checker. Gateway: 190 requests, all 190 with terminal observed usage, zero unknown or pending; 4,051,044 input and 34,447 output tokens observed, actual currency cost unknown.

This was a successful run within a 30-minute upper bound. It stopped early on Mission acceptance after 7 min 42 s and **does not demonstrate 30-minute endurance**. The per-Bot reconstruction follows; IDs are stable prefixes.

| Core / Bot | 实际行为与结局 |
| --- | --- |
| Core 1 / `2e8cf6df` | 查 Mission、Workspace 和空队列，提议并领取完整网格计数证明 `1bf53ca8` / E `7f8d4c7b`。检索 Lean API，自 R 0.1 修改并保存目标文件，R 0.6、0.9、0.10 三次真实诊断失败，修到 R 0.12 获普通 PASS `ad24437d`。合入形成 main R 0.14，发布证明说明 M `c851e19b` 并核对公开版本。以该说明和 main 触发最终 Mission 验收，同时用 R 0.12 与原 CheckResult 结束 Task done。 |
| Core 2 / `a2470cc5` | 提议并领取另一条完整网格证明 `f3adc4f5` / E `9c8b724d`。查询 Mathlib，保存 R 0.3 后因占位符被请求层拒绝。后续 R 0.8、0.11、0.13 是实际源错误，继续修改到 R 0.15 获普通 PASS `53a942f4`。发布独立方案 M `7b8dd65b`，以 R 0.15 和该 CheckResult done。此分支未合并、未纳入唯一成功 Mission 快照。 |
| Core 3 / `bdc7730e` | 先调用本地 propose 帮助，随后查看两个已有完整证明 Task，提出较窄的三点圆周到单形/颜色桥接 `80f1df67` / E `f7402b17`。R 0.2 真实源检查失败，修到 R 0.4 获普通 PASS `85742921`，发布使用说明 M `716e786a`。第一次 finish 带未建立 Task 链接的 Material 被拒，按已检查的 R/CheckResult 提交有效 done。 |
| Core 4 / `dc0f6b44` | 查看两条完整网格 Task 后，也提出圆周三点到颜色的可复用桥接 `8c48c1d6` / E `5aba38ce`。独立在 R 0.5、0.7 两次通过公开辅助文件的 Lean 检查，发布 M `62a504d8`，以 R 0.7 / `26aa9b12` 完成 done。 |
| Core 3 / `edb278ce` | 前任 done 后读取两份桥接 Material 和公开 R 0.4、0.7，也查看推进中的 R 0.9。ready 后用约 79 秒探索，到 no-work 时尚无可归因的受理变更。最终无提议/领取，显式 no-work。 |
| Core 4 / `8699b940` | 新 Bot 比较两份桥接 Material，检查当前队列和仍在工作的候选。无提议/领取，显式 no-work。 |
| Core 3 / `db56308d` | 再核对两份公开桥接实现、Mission 状态，看到后来发布的 M `c851e19b`。无提议/领取，显式 no-work。 |
| Core 4 / `a86097f5` | 从 R 0.1 切到读合并后的 main R 0.14，核对 Core 1 Task、M `c851e19b` 与提交状态。无提议/领取，显式 no-work。 |
| Core 3 / `b803efd2` | 对照两个证明 Task、原始 R 0.1 和 M `c851e19b`，实际尝试提交已有公开成果。服务以已有提交/冻结拒绝，随后查询状态。无新 E，由 Mission 接受后的运行收尾关闭。 |
| Core 1 / `e891316f` | 前任完成后对照两个证明 Task 与两条证明 Material，读取公开 Workspace。没有产生新 Task/E，由运行收尾关闭。 |
| Core 2 / `d0c9c81c` | 对照两个已完成证明 Task、两条证明 Material，并多次读取独立 R 0.15。无新持久提交或 E，由运行收尾关闭。 |
| Core 4 / `431b8f43` | 比较两条证明 Task/Material 并读取 R 0.15。无新持久提交或 E，由运行收尾关闭。 |


## Analysis

The actual model completed the intended propose/take/execute flow on all four Cores. Source failures led to corrected revisions and fresh successful checks; long requests survived valid lease renewal. Final Mission acceptance, not the helper PASS count, establishes success on the fixed B1 target. Initial work was partly duplicated: two complete proof tracks and two adapter tracks. No durable helper Material consumption was observed, so concurrency and published Materials do not establish useful division of labor or reuse. Successor discovery included justified no-work decisions while complete proof owners were still active or the final check was pending.


四次 no-work 前，Bot 实际比较了已完成的桥接和仍有人负责的证明，后来的 Bot 又观察到 main 合并与现有提交。公开证据不足以证明需要另提整合 Task，实际接受结果也显示这条成功路径可以由原证明 E 合入并提交；当时再提等价责任会重复已有工作。另一方面，新 Bot 的重复扫描开销可观：8 个后继只选工，共 79/190 请求，其中四个 no-work Bot 占 44 次、825,880 输入 tokens。Runtime 以 Task、Material、Workspace 公共变更通知重新唤醒空闲 Core。观察到这批 Bot 同期确实出现保存、发布、结束和合入，仍未逐次归因触发者。数据支持区分「再发现带来分工变化」和「反复确认已有责任」；不把四次退出都判为 Runtime 故障，也不把后继的阅读计作研究交付。


## Next steps

The independent content and lifecycle reviews passed for this observed successful run. [EXP-20261115-07](EXP-20261115-07-single-problem-2h.md) preserves early acceptance and the same fixture with a two-hour upper bound and finite longer Bot lifetime. Actual duration, duplicate work, existing-task selection and genuine downstream reuse remain explicit observations.

## Evidence and limitations

The repository analyzer completed with exit 0, full local evidence, four Executions and zero warnings. Local `analysis/experiment-analysis.md`, `analysis/bot-observation.md` and `analysis/system-observation.md` provide complementary reconstructions. Raw transcripts, reasoning, proof files, logs, credentials, database files and private paths remain in ignored local evidence. Public reporting uses stable IDs, summarized actions and attributed results. Currency cost and upstream retry/billing outcomes remain unknown when not supplied by the provider. Lifecycle cancellation is not proof of upstream cancellation or zero cost. The run deadline includes setup; cleanup has its separate bounded grace.
