# Issue #111 evidence index

Implementation commit: `d5214b5493e952a197d00375a7260d54a197f897`
(clean worktree). This index was written after that commit; later
documentation-only commits do not change the implementation under test.

Shorthand: **R** = real Agent event, **I** = deterministic/integration test.
The sanitized real-Agent report is
`experiments/issue-111-probe-d5214b5/analysis/report.json` (ignored local
evidence). Raw transcripts, proof text, and credentials are not published.

| Item | Implementation | Regression/integration | Real evidence | Result / gap |
| --- | --- | --- | --- | --- |
| A01 Judge available to a research Execution | `src/agent/services-bridge.js`, `src/judge/judge-service.js` | `test/services-bridge.test.js` ("allows a research Mission Task to use Judge…") | R: probe `submit_candidate` returned a real Lean CheckResult | PASS for the controlled probe; full run pending |
| A02 same-Execution FAIL → revise → check | `src/runtime/runtime.js`, `src/agent/services-bridge.js` | `test/putnam-runner.test.js` ("flat Judge source failure stays…") | R: probe first FAIL `source_failure`, revised artifact, second PASS, same Session/Execution | PASS for the controlled probe |
| A03 version/environment binding | `src/judge/*`, `src/task/task-service.js` | `test/judge*.test.js`, `test/task-service.test.js` | R: probe CheckResults carry candidate/execution/checker identity | PASS (controlled) |
| A04 final acceptance independent of first identity | `src/task/task-service.js`, runner candidate path | `test/putnam-runner.test.js`, `test/task-service.test.js` | none natural | I only; long-run R pending |
| A05 failure/cost classification | `src/judge/check-result.js`, runner projections | `test/putnam-runner.test.js` (checker infrastructure) | R: probe classified source failure, not infrastructure | PASS (controlled) |
| B01 shared Mission concurrency | `src/task/task-service.js`, `src/runtime/identity-task-loop.js` | `test/orchestration-roles.test.js`, `test/task-service.test.js` | none natural | I; four-Core R pending |
| B02 exclusive ordinary Task | Task Service claim guards | `test/services-bridge.test.js`, `test/putnam-runner.test.js` | none natural | I; R pending |
| B03 same identity/Core across Tasks | `src/benchmark/putnam-runner.js`, `identity-task-loop.js` | `test/putnam-runner.test.js` ("production queue dynamically reuses…") | probe used one Session for the whole candidate flow | I + limited R; long-run R pending |
| B04 empty child queue returns to Mission | runner/base prompt, identity loop | `test/putnam-runner.test.js` | none natural | I; R pending |
| B05 no task-count quota | `src/task/task-service.js`, runner | `test/putnam-runner.test.js`, `test/task-service.test.js` | none natural | I; R pending |
| B06 authoritative state/provenance/pagination | Task Service | `test/task-service.test.js`, `test/services-bridge.test.js` | probe Task/Execution IDs agree across reports | I + limited R |
| B07 local Mission lifecycle | Task Service/Runtime | `test/runtime.test.js`, `test/phase1-progress.test.js` | none natural | I; R pending |
| B08 Progress/Git save and restore | `runtime.executionProgress`, `workspace-manager.js` | `test/phase1-progress.test.js`, `test/runtime.test.js`, `test/workspace-contract.test.js` | probe produced two Materials and a Git-backed Workspace | I; real restore-after-checkpoint pending |
| B09 save/prepare failure bounded | `runtime.js` handoff/progress paths | `test/phase1-progress.test.js` (injected save failure) | none natural | I; R pending |
| B10 identity/resource continuity | runner, Runtime | `test/putnam-runner.test.js`, `test/runtime.test.js` | probe keeps one Execution across FAIL→PASS | I + limited R |
| C01 feedback changes current action | prompt + synchronous CheckResult | `test/services-bridge.test.js`, `test/putnam-runner.test.js` | R: diagnostic was followed by a superseding revision | PASS (controlled) |
| C02 cross-Execution feedback, multi-recipient | `task-service.js` notifications | `test/task-handoff-notifications.test.js`, `test/phase1-s3.test.js` | none natural | I; R pending |
| C03 compaction checkpoint after settled turn | `runtime.#queueCompactionCheckpoint` | `test/phase1-s3.test.js` | none | I; real Pi event pending |
| C04 three compactions then 80% | `runtime.#handleSessionEvent` | `test/phase1-s3.test.js` | none | I; real threshold probe pending |
| C05 successor continues work | `runtime.#rotateIdentity` | `test/phase1-s3.test.js` | none | I; R pending |
| C06 abnormal rotation/unknown usage | Runtime rotation guards | `test/phase1-s3.test.js`, `test/runtime.test.js` | none | I; R pending |
| D01 conformance audit items | see `docs/reviews/phase-1-conformance-audit.md` | suite-wide | probe covers A01–A03/C01 | partial |
| D02 adjacent boundaries | bridge/Runtime/Task Service | suite-wide | none natural | partial |
| D03 docs/code consistency | this commit | `npm test`, `git diff --check` | not applicable | updated |
| D04 engineering validation/privacy | all tests | 313/313 at the implementation commit | sanitized report only | passed deterministic checks; long run pending |

## Explicit gaps

- No two-hour four-Core matched baseline/treatment run yet.
- No real compaction-threshold rotation probe yet.
- The Sandbox backend has deterministic fake-docker coverage but no real-image
  long run yet.
- Shared-Mission multi-Execution isolation has deterministic coverage but no
  four-Core natural run in this evidence set.