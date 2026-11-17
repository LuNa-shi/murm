# EXP-20261117-06: Issue137 acceptance after diagnostic and deadline-attribution repairs

Status: REGISTERED — pending completion of full tests and production readiness.
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

Not started. No new autonomous outcome, cleanup or usage result claimed.

## Analysis

Acceptance requires trusted original-goal Mission acceptance, valid protocol and physical cleanup, plus repair-specific evidence. If the nested-resource condition is not naturally triggered, mark it naturally unobserved and use the separately labelled real controlled regression. Track Task proposals/takes/revisions, actual Material body reads and downstream source use, shared Workspace integration, local cache scope, retries and four-Core concurrency with stable IDs. One mature short problem and stochastic model traces cannot establish Q20/eight-hour efficiency or causal speedup.

## Next steps

Finish all readiness checks, publish registration, run for at most one hour with early stop on trusted acceptance, and monitor approximately every ten minutes with independent Task, Material/Workspace and parallel-value audits. Do not modify runtime/config during execution. On unrecoverable startup/service/checker/protocol failure or time limit, stop and preserve evidence. Analyze results against every repair before the owner-authorized merge; keep unverified Issue137 long-horizon claims open.

## Evidence and limitations

Raw evidence will remain in ignored `experiments/EXP-20261117-06`; private launch manifest and engineering probes retain exact hashes and resources. Public reports omit proof source, raw conversations, stdout/stderr, databases, credentials and private paths. Local diagnostic replay retains ordinary Lean metaprogram trust assumptions and cannot substitute for full fixed-target Mission verification. EXP05's diagnostic failure and EXP03's UNSOLVED/protocol-invalid result remain version-bound historical observations.
