# ProgramBench Pastel validation across three MAS

Status **SETTLED · acceptance unmet**. The owner approved three parallel 30-minute runs with three Bot slots per run in [Issue #209](https://github.com/LuNa-shi/SwarmEnv/issues/209).

| Run | Environment | Cooperation channel |
|---|---|---|
| `EXP-20261125-01` | Subagents | Parent and two delegated children, routed child outcomes and parent publication |
| `EXP-20261125-02` | Flat | Three tasks with material publication, consumption and source attachments |
| `EXP-20261125-03` | Agensh | Three peer identities, Board and pinned Git pull-request delivery |

## Setup

| Item | Fixed value |
|---|---|
| Acceptance | Confirm that each MAS can start actual Kimi K3 work, show cross-Bot use in the final source, and freeze a candidate before its deadline. Report the benchmark score independently. |
| SwarmEnv | `ec4d286f1f452eb03bb11113ff9c48234c1357c1` |
| Task | ProgramBench `sharkdp__pastel.b60e899`, instance revision `b60e89932629b2d162e1ff9f3976a5a0ef1e5db9` |
| Worker | `sha256:475c1a832d471bc4f7b841add14c72fc73175e87c645ac4332a8d1ccd36b78e7` |
| Evaluation | ProgramBench `895f65916bc5ba34a915d36da321fde0301125ad`, test data `5954a1957b5e0d770ec2c5523506abd212806315`, cleanroom digest `sha256:e75597f4307bf02746598d2b7eb8ae136b9978f0c2551e04b065b14e9e5f9c4e` |
| Model | `kimi_proxy/k3`, shipped model catalog SHA-256 `2495571b7ce4d3193fc851fc143f277e850bf184fbade4c614b1b3225de6f20a` |
| Common prompt | SHA-256 `522863a45f4aa02389fec9c853cd6cf80cd243ab11ebfb2938999eeb98da9b1a` |
| Time and budget | Each window opens after its environment is ready and stops after 1,800 seconds on a monotonic clock. Three Bot slots per run. The approved experiment adds no request count, output token, CPU or memory cap. Infrastructure defaults remain in effect. |
| Isolation | Each environment has its own workspace, model accounting, deadline and artifact store. Bots access the reference executable and public documentation. Eval data and raw execution evidence remain host-side. |
| Final candidate | Choose the latest source archive whose write completed before the deadline. Verify source hashes and run the pinned full ProgramBench evaluator after settlement. Early or missing outputs and evaluation errors are recorded separately. |

The per-environment prompts, profiles and Service contracts are fixed by the tested runtime commit and the recorded runner fingerprints. The operator starts all three environments from one launch. Each run keeps its own setup duration and active window.

The host runner SHA-256 values were recorded at registration.

| Runner | SHA-256 |
|---|---|
| `local-integration.mjs` | `3123a6e3c3d04b2684078f33c6d57d90105c3d14372286ff5fa51569b59ba1ac` |
| `run-window.mjs` | `450af68f6c3a844cc520f33f89c3c7c20dad9e257e0495ef3edcd1979c737d3e` |
| `source-checkpoint.mjs` | `de255ec3897e6bb9dfd8619cca915fb46755f3a55628ded19cfde2c80d85540a` |
| `pack-submission.py` | `d254d92aaf8c3a02f67dded3c677f00fac97e878e3efd2b6df861dfd5dc16846` |
| `pastel-open.mjs` | `d2a64ca4cc3bc3fa0380537f7400e63442958ec0d4532a39fa0aad6362dadaf1` |
| `pastel-open-subagents.mjs` | `73a5f55904f94eef10e54d994892f1b760b40bdc3aa347ddee60ebba99ce2ea8` |
| `pastel-open-flat.mjs` | `a27181096c03e773da2c734ef5f260369c3eff6ec72c103fde73080c9a69de5b` |
| `pastel-open-agensh.mjs` | `7d23964f97737d214508e38770d2c775047b096a0ac27cb1b958ade7ccb82c03` |
| `pastel-matrix.mjs` | `b0df9846251a73bc187ae5cc4e97d0dafda7d84ceb55b4344d582d9ed66b0e7e` |

## Results

All three environments reached their 1,800-second deadline and recorded live, metered `kimi_proxy/k3` use. No run froze a candidate. The official evaluator therefore had no submission to build or score.

| Run | Setup | Active window, UTC on 2026-11-25 | Bot identities ready / metered | K3 requests forwarded / metered / usage unknown | Candidate and score |
|---|---:|---|---:|---:|---|
| `EXP-20261125-01` | 4.295 s | 02:38:09.921 to 03:08:09.921 | 3 / 3 | 89 / 87 / 2 | No archive or score |
| `EXP-20261125-02` | 8.424 s | 02:38:14.155 to 03:08:14.155 | 34 / 34 | 404 / 371 / 33 | No archive or score |
| `EXP-20261125-03` | 71.400 s | 02:39:17.364 to 03:09:17.364 | 3 / 2 | 50 / 50 / 0 | No archive or score |

Flat used three concurrent Bot slots and recycled them after failed work. The ready and metered columns count distinct Bot identities over the window. Known input/output token totals were 2,490,676 / 133,143 for Subagents, 2,687,935 / 133,757 for Flat, and 1,278,529 / 91,971 for Agensh. The closeout ledger had zero pending model attempts for every run.

| Environment | Verified handoff and last observed milestone | Runtime and cleanup |
|---|---|---|
| Subagents | Two children started and received instructions. One child produced completed results at 82.1 s and 549.5 s. The parent admitted both result deliveries. The second child had no completed turn by the deadline. The parent made no candidate publication. | `637917be-74f2-47b3-8d0c-1e1d3cfd5881` closed. Cleanup complete. |
| Flat | 31 successful Task takes and 31 Executions ended as `domain-deadline`. Each had a 60-second limit. The Bridge recorded 46 `task_list` invalid responses. No Material was published. Parser and formatter were OPEN after cleanup. Integration remained BLOCKED. | `cb3b649f-2630-4e42-9ae8-fcb145024bc4` closed. Cleanup complete. |
| Agensh | Peer A completed at 592.7 s, wrote a Board fact and opened PR 2. The host merged its pinned head `a6868397c1ee07c296cb3b0e23519430d89ba776` into `c4f24617129c6eea1d9e28c95cf28121da38682c`. Peer B had metered work and no completed turn by the deadline. Peer C was ready but received no integration input. | `b1c27b51-c659-4baa-a4e9-b6e29fc78c2a` recorded pending Core cleanup with `ARTIFACT_EXPORT_FAILED` for peer C. Gitea and Board cleanup completed. |

The separate operator cleanup confirmed the remaining Agensh sandbox belonged to this Runtime, deleted it through OpenSandbox and confirmed a subsequent provider lookup returned 404. A final Docker query found zero containers owned by any of the three Runtime IDs. The original Agensh Core cleanup and export receipt remains pending.

## Analysis

Subagents verified delivery from a completed child to the parent. Agensh verified an authored PR and the host merge of its fixed head. The records do not establish cross-Bot adoption into a timed candidate. The Agensh driver waits for both contributor turns and merges before sending integration work to peer C. With only one contributor completed, the integrator had no model activity. These are observations of the frozen drivers and one run per environment.

Flat completed discovery, take and workspace handoff for already registered work. The host created the two producer Tasks and their dependent integration Task before the window. The Flat Bot manifest has no `task_create` grant, so discovery assumes the host supplies the initial Task graph. The observed path stalled after take. The runner used the Flat Service default of 60 seconds, and every started Execution ended through that deadline without publication. Independently, when an active Execution appeared on a list page, the Task Service returned a SQLite row with a null prototype. The authenticated Bridge rejected that nested value as invalid JSON. [Flat list repair and regression](https://github.com/LuNa-shi/SwarmEnv/pull/210)

A separate scripted Responses run used the list repair and configured a 90-second Task limit. The formatter took 62.83 seconds to finish, and the integrator froze a candidate at 69.24 seconds with two source adoptions and complete cleanup. This verifies the fixed-Task path under a longer limit with a controlled workload. How K3 behaves under the changed limit remains open.

## Next steps

The original three records are complete. Issue #209 tracks the draft list repair. A hosted Flat rerun requires a new approved registration. Bot-proposed Task creation would require its own reviewed scope and authorization model.
