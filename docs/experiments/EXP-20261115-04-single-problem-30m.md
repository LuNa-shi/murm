# EXP-20261115-04: Four-Core single-project 30-minute validation

Status: BLOCKED (operator-stopped after real runtime defects)
Approved GitHub Issue: [#122 and owner decision](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563)
Implementation: `cb6c98212cfd439fefcec742df4a4183d6b35527`; runtime reviewed independently at `a89721fd83cf70ebdf9a3cb5c0e18cb3c5efc24c`, followed only by generated documentation.
Repeat of: [EXP-20261115-03](EXP-20261115-03-single-problem-30m.md). Repairs accept the provider's empty reasoning content on Pi replay, supply executable discovery/proposal help, and provide consistent graceful operator interruption. Selection and single-request limits increase from 2 to 3 minutes within the unchanged 30-minute Mission/10-minute Bot maximum, allowing a slow response without exhausting the whole discovery window.
Comparison: descriptive comparison with [formal24](issue122-formal24-gap-analysis.md); this is not a controlled causal comparison.

## Setup

This run observes the approved Phase 02 behavior with a real model after independent Spec and Standards review. The Mission begins with zero Tasks. Four independent Cores should discover public work, propose bounded responsibilities where needed, take before execution, and continue through publicly saved work and Materials. Existing actionable work has priority over unnecessary proposals. An individual Bot owns at most one Execution. A proposal is not required when appropriate existing work can be taken.

| Item | Fixed value |
|---|---|
| Source | Runtime `cb6c982`; launch commit is recorded in `metadata/experiment.json`. Registration and architecture-only commits do not change runtime code. Clean worktree required at launch. |
| Agent image | `swarmenv/agent:issue122-pilot-cb6c982`; `sha256:e86b0c932551ebca41fb48533dac17e41579e6793b6ce6c7d7ddd5ccf80ed62e`; Pi 1.3.0 |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7` |
| Checker | Lean 4.33.1; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659` |
| Artifact lock | SHA256 `36bdf33550b5364e122b6e345d1c72b72f70e22ea702b834c7e940be744c621f`; existing trusted deployment, unchanged target |
| Provider/model | `gpt_proxy/gpt-6.1-sol`; actual host credentials, per-Bot local gateway tokens, no scripted model responses |
| Prompt/profile/schema | Prompt manifest SHA256 `994143c06ca3549d29fd6171b9edeb74ca11c60a1a563689ce4ebdcaa9ba8fba`; system text `683af4e09fe2b53ee766fb62bbc04000ed2fb2afe89f9ec00e51e6b933c0c5c5`; Pi catalog `2f7af32c853568f358b7c7fabb66d6992df5fbc727eac777130e1650ed124070`; CLI `518de4acc10bf56a875e93bf08eab9fcadb797954042522da44639a0e560dbf4`. Actual sent messages remain private evidence. |
| Concurrency/time | 4 Cores, 1 project; Mission 1,800,000 ms including setup, Bot/Execution 600,000 ms, selection 180,000 ms, turn setting 180,000 ms; shared cleanup grace 30,000 ms |
| Model bounds | Time-bounded mode; request limit 180,000 ms intersected with lifecycle deadlines; requested output cap 32,768 tokens. No currency/rate contract; actual cost unknown. No local meter used as a substitute. |
| Isolation | OpenSandbox release-1.2.0, local Docker network allowlist, 100,663,296-byte/8,192-inode per-Bot writable filesystem; coordination grant only `mission_submit` |
| Judge bounds | Unchanged defaults: 20 source admissions / 2 simultaneous, 4 final admissions / 1 simultaneous; source FAIL is distinct from infrastructure failure |
| Deployment configuration | Private nonsecret overlay of locked 12-problem catalog, selected with `--problem`; SHA256 `68da299563d69e5a01c5ec3d09cf47259ab6e2981a8e3cb336d3c200336291d1`. Host-local paths are retained only in private provenance. |
| Evidence | Ignored `experiments/EXP-20261115-04/`; aggregate/project output under ignored `reports/EXP-20261115-04/`; semantic reconstruction under the experiment's `analysis/` |

Invocation, with `DEPLOYMENT_CONFIG` and `PUTNAMBENCH_ROOT` resolved to the verified private local deployment:

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue122-pilot-cb6c982 \
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
  --experiment-dir experiments/EXP-20261115-04 --report-dir reports/EXP-20261115-04
```

Stop at the Mission deadline or trusted Mission acceptance, followed by bounded cleanup; stop and diagnose a systemic authorization, provider, or protocol failure. The follow-on two-hour run is conditional on healthy real-model activity, genuine overlapping Executions rather than merely allocated Cores, meaningful proposal/take/work traces, no unresolved infrastructure failure, and confirmed cleanup. Independent subagents inspect actual content. Solving B1 is reported separately and is not the health gate. Capability paths not triggered are recorded as unobserved, not passed.

## Results

项目执行 280,277 ms，因操作员提前停止，`protocol_valid=false`、`invalid=true`（`operator_stop`）、`solved=false`。项目报告记录清理 973 ms、无清理错误和未处理拒绝。四个初始 Bot 在 28 ms 内注册，约 4.7 秒后全部 ready，各自提议并领取不同的 Task。Task 创建来源与持久 Execution owner 一致。四个 Execution 同时运行约 97.45 秒，即 14:11:32.484–14:13:09.937 UTC。项目报告另计四个活跃 Core 214,828 ms，其中含选工与运行，不能替代 Execution 重叠。

| Core / Bot | 选工、实际行动与终态 |
| --- | --- |
| 1 / `92cec2b2` | 查看 Mission、公开源和已存在的几何 Task `5bdb180a`、圆周桥接 Task `c7126829`，界定自己负责网格计数矛盾以及带几何假设的条件归约。提议并领取 `d84caab2`，进入 E `d2554001`。执行中查询 Mathlib，轨迹出现 publish 调用文本，未找到相应已受理发布、公开保存或 finish。E 因操作员停止而 FAILED，Task 回到 OPEN。 |
| 2 / `d9c47a00` | 浏览 R 0.1、Task、Material 与 Mission，从空队列提出两圆心等距网格的几何构造，职责与后续计数拆开，领取 `5bdb180a` 进入 E `afa7e7b3`。检查当前 Workspace，并查询用于几何构造的 Mathlib API。未形成公开保存、Material 或 finish。E 持久终因为 `provider_failure`，Task 回到 OPEN。 |
| 3 / `5af6766e` | 阅读公开源和队列后，提出圆周上三点到二维单形外心的桥接，领取 `c7126829` 进入 E `30545793`。查询 Mathlib，写入候选辅助文件，按 `0.1 → 0.2 → 0.4` 保存，反复诊断，并读回 R 0.4。编译未获验证时发布版本 1 的 Material `6c8e1fcb`，注明候选与不可验证状态；该 Bot 读回自己的 Material，再提交 `finish incomplete` 引用 R 0.4。E 持久为 HANDED_OFF，Task 回到 OPEN。 |
| 4 / `98bf1ee8` | 比较前三个具体 Task 合同与公共版本历史，提出整合责任 `7f62af8d`，其中先做单形假设到圆周着色的适配，再组合其余组件。领取后进入 E `50c9bbf1`，保存基于 R 0.1 的适配草稿 R 0.3；并排读公开 R 0.4 和自己的 R 0.3，执行 Judge 诊断。轨迹出现发布/收尾命令尝试，但未留下成功的 Bridge 收据。E 因操作员停止而 FAILED，Task 回到 OPEN。 |
| 3 / 后继 `0c2807b6` | 在前任 finish 后作为新 Bot 启动，读取 Mission、公开源、队列及前任 Task `c7126829`。未领取或提议新 Task，随后操作员停止。 |
| 2 / 后继 `b16eecb4` | 在 provider failure 后登记新 Bot，操作员停止前未 ready。未找到实际选工指令或 Task 操作。 |

公共 Workspace 有三条实际保存，R 0.2、0.3、0.4；main 保持在 0.1，零持久 apply/merge。唯一 Material 由 Core 3 产生，作者本人查询了它；没有持久 Material consume，也未观察到其他 Core 把它落到自己的公开成果中。Core 4 对其他 Task 的阅读改变了它的职责选择，且对后继公开 R 0.4 有实际版本读取；没有证据表明读取后完成了合并、通过检查或改变 R 0.3。

共 6 次 Bridge workspace_check 返回成功的协议收据。Judge 实际保存 5 个 CheckResult，其中 4 个为 `ERROR / infrastructure_failure / checker_unavailable`，1 个为 `ERROR / request_failure / checker_request_rejected`；不能把 Bridge 成功算作数学 PASS，也不能把六次调用视为六个独立检查。Lean 原始事件记录五次 `checker.preflight.complete healthy`，之后运行实际 source diagnostic；持久 checker 健康状态降级为 unavailable。启动版本验证和真实 source diagnostic 必须分别判断。没有 Mission submission 或 Mission 验收判定。

模型网关有 83 个入账请求，69 个有用量，14 个 `transport_interrupted` 后结果未知，结束时无 pending。已观测 input 1,213,246，output 11,300 tokens，实际费用未知。未在可见 Pi 错误中观察到 EXP03 的 `unsupported_responses_request`。

## Analysis

零 Task 启动已经自然地产生四个由各 Bot 提议并自行领取的角色。Core 1 与 Core 4 在提出新工作之前主动读取了其他责任，几何构造、圆周桥接和计数责任之间有可区分的接口。Core 4 的整合与 Core 3 的圆周接口边界可能交叠，是否造成重复实现无法从读取和未检查的 revision 推断。整合 Task 的实际合约也依赖两个尚未交付的成果，虽然可立即做适配工作，但当前 Task 边未显式声明这些依赖。不能从四个角色各自领取推出有积压时的优先选工行为。Core 3 的真实 handoff 与新 Bot 的公开发现都已发生，后继还未形成可归因的接续交付。

这轮可用于区分两个独立的系统问题。普通 source diagnostic 多次无法产出可解释的数学结果，直接影响 Core 3 的交付判断；正常运行期模型流亦多次中断，Core 2 的最终失败被持久记录为 `provider_failure`。单看无清理错误、全部 Task 重新开放或 4 Core 同时运行，都会掩盖这些运行期条件。普通 checker 的具体根因已复现为 Lean 的内部内存阈值：连最小 `import Mathlib` 加平凡命题在 `-M4096` 下也以 134/memory_exception 退出，而在同一个 4 GiB/no-swap cgroup 下使用 `-M0` 可以成功，错误源码则给出正常 code 1 诊断。生产系统级内存、进程、CPU 和时间上限均不变。模型请求中断则与准入时固定的旧 lease 截止对齐，即使 Runtime 已正常 heartbeat 续租；这会被 Pi 表述为 terminated，继而可能被 Runtime 归为 provider_failure，并不构成 OpenSandbox 或真实上游故障的证据。

## Next steps

按已批准的正式流程，2 小时实验的健康前置条件未满足。修复已分别通过独立 Spec 和 Standards 审核：在原硬截止内观察同一 E/fence 的及时续租，拒绝过期 heartbeat 复活，撤销/更换 E 立即停止；Lean 采用仍受原物理上限保护的运行模式。实际 Pi/HTTP、Task Service 和生产 cgroup + Lean 回归验证了这些边界；固定最终 B1 占位输入仍正确被拒。完成最终整合检查后，用相同任务和模型重跑完整 30 分钟。以真实普通 source Judge 输出、跨续租窗口模型流、完整 cleanup 和至少一条可追溯的公开产物接续为实际观测项；无法触发的行为保留为未验证，不以数量补足。

## Evidence and limitations

证据使用项目 `report.json`、`aggregate-report.json`、独立只读 Task/Bot/Execution/Context/Judge SQLite 对照、公开 revision 记录，以及每 Core 的 Agent、Bridge 和 Lean 事件。所有持久事实在结束后核对。报告中的 Bash 文本只用于辨识意图；只有 Bridge 收据或持久状态支持操作成功。无假定的模型内部推理、未取消费用或数学正确性。清理结论来自项目报告与六个 CLOSED Bot，另一位独立系统观察者逐个核对本轮 6 个 provider ID 均为 HTTP 404；运行清理耗时 973 ms、cleanup_errors 为空。
