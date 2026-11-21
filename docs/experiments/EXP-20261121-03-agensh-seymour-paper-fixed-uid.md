# EXP-20261121-03 · Native Agensh Seymour manuscript with readable Lean dependencies from startup

## Setup

The owner approved a single fresh four-worker paper-arm repeat under [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157). Repeat [EXP-20261120-09](EXP-20261120-09-agensh-seymour-paper.md) using the released worker-permission fix in merge `490a215f3d7658908e3f693ecc0170fe9b12135d`. Compare the two native cases and the [SwarmEnv matched-brief run EXP-20261121-02](https://github.com/LuNa-shi/SwarmEnv/issues/159#issuecomment-7062741862). The question is how this paper case proceeds with local Lean available from the start. All timings are single-run observations.

| Condition | Registered selection |
|---|---|
| Public input | Original Seymour theorem, fixture `fa30b4c4f6a68cac222daf3cb5a11e1e2bbbf36a`, target digest `fa4a3783`, and manuscript 173 PDF/text digest prefixes `20be8597` and `eab9cae7`, manifest `7154d525`. Fresh Git and messages. The reference proof and 19-item rubric stay with the evaluator. |
| Workers | Four equal native Pi 1.3.0 workers on Agensh `2dae4e14`, image `a93a70e09b30`, each 4 CPUs and 8 GiB. `gpt_proxy/gpt-6.2-sol`, medium, effective context 500,000 and output ceiling 128,000. Unique profile `exp157sey112103`. |
| Brief | The shared original-theorem and paper-formalization assignment from the native pack. Both paper paths are named. Workers choose responsibilities through Agensh's messaging, board and PR workflow. The operator supplies no mathematical work assignments. Native brief template SHA-256 `e508a0dec25841fac3f6ac3b4b676cbae6c4e1e23c0cf47324b4ce7ed43aad3f`. |
| Lean and Judge | Lean 4.34.1, Mathlib `d13f23b7`. Staging copies the same public compiled libraries into readable, read-only mounts. Validate the four staged worker mount plans and probe each with the worker image as UID/GID `10000:10000` before launch. Use the native locked `f0a85f18` independent fixed-theorem checker with 600 s per check. Confirm that the seed fails and an operator-only complete control passes with both paper files present. |
| Timing and spend | One run, the native four-hour wall window from driver launch, and the existing provider allowance with metered usage. Record preparation, driver launch, first worker wake, trusted acceptance and settlement separately. Compare first-wake and launch durations where available. No automatic replacement. |
| Evidence and stop rule | Observe all four actual sessions, first paper reads, early responsibilities, local-tool returns, public Git and independent receipts. Stop on a trusted PASS for the current published main, the four-hour cutoff, confirmed input or protocol integrity failure, or owner request. Final export is checked again. |

Private staged-input manifest file SHA-256 `37d22778ea96df809c2aa4b5fd863f072d2e3e72334a1ca5aa5e3a09e7a8961f`. The native and SwarmEnv runs retain their respective harnesses, verification paths and startup boundaries. Whole-target acceptance scores 1.00. A partial score requires independent adjudication of all 19 milestones in a compatible package.

## Results

**Startup failed before first wake.** Four staged worker UID/GID probes passed. The locked Judge preserved the original fingerprint in an isolated checker child, rejected the unproved paper seed and accepted the operator-only control. The native driver then failed when its privileged Docker lookup tried to use a host-library copy whose ownership and setuid bits had been lost during copying. There were no model requests and no remaining team containers. Driver launch was recorded for startup accounting. The research start is unavailable.

## Analysis

The Agensh image was installed. The message about a missing image came from the failed privileged lookup. The independent checker controls and worker Lean probes had not exercised that driver operation.

## Next steps

Use an ownership-preserving root-protected host-library copy and verify the actual privileged image lookup before [the fresh startup attempt](EXP-20261121-04-agensh-seymour-paper-fixed-uid.md). Preserve the original locked Judge inputs and the single model-run allowance.
