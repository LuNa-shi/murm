# ProgramBench Pastel validation across three MAS

Status **REGISTERED**. The owner approved three parallel 30-minute runs with three Bot slots per run in [Issue #209](https://github.com/LuNa-shi/SwarmEnv/issues/209).

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

Pending execution.

## Analysis

Pending execution.

## Next steps

Execute the registered matrix and record per-run artifact, collaboration, usage, evaluator and cleanup receipts.
