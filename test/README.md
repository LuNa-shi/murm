# Test suite

The executable suite covers the Mission-scoped Task model: Mission and Task registration, canonical `task_take`, concurrent Executions of distinct Tasks within one Mission, ordinary Task exclusivity, typed dependencies, Material delivery, Judge iteration, Workspace continuity, Runtime fencing, capability profiles, and deterministic fixture execution.

Lifecycle tests use the canonical Mission and Task fixtures. New behavior should use `createMission` and `createTask`, then exercise the public Task lifecycle through `task_take`, the Task mutation operations, and `task_finish`.

The [ProgramBench Pastel benchmark](../benchmarks/programbench-pastel/README.md) is an opt-in case with its own Docker, OpenSandbox and evaluation requirements. Run its local checks from a source checkout.

## Subagents verification

The [Subagents example](../examples/subagents/README.md) accepts an arbitrary task. The regression suite exercises its controller and the installed example entry point. Set `MURM_SUBAGENTS_COLLABORATION_TEST=1` for the native recursive delegation, interruption and continued-work checks in `subagents-collaboration-real.test.ts`. These checks require a local Pi/OpenSandbox installation and `MURM_CORE_TEST_IMAGE` set to the immutable Worker image ID.

The fixed communication CLI and four-stage text-adoption adapter live in `test-support/subagents/`. The former verifies exact child output provenance from two original children by default. The latter takes three existing child IDs and verifies cumulative results across four host-driven stages. `subagents-harness.test.ts`, `subagents-controller.test.ts` and `subagents-stages.test.ts` cover those fixture contracts. Set `MURM_SUBAGENTS_REAL_TEST=1` to exercise the installed communication fixture on the same native backend. See the [implementation manual](../docs/architecture/17-harness-reporting.md#optional-four-group-text-adoption-seam) for the fixture input and evidence contracts.

## Codex/OpenSandbox verification

Build the Worker from the candidate revision and use its immutable Docker image ID. The opt-in checks run the pinned native Codex CLI against scripted local Responses. They exercise installed Notes across three inputs, installed Subagents with two overlapping Agents and verified Service handoff, and required file export failure with a stopped Sandbox and later cleanup retry.

```sh
npm run build
MURM_CORE_TEST_IMAGE="$image_id" \
  MURM_CODEX_NOTES_REAL_TEST=1 MURM_CODEX_SUBAGENTS_REAL_TEST=1 MURM_CODEX_ARTIFACTS_REAL_TEST=1 \
  node --test --test-concurrency=1 dist/test/{notes-harness-real,codex-harnesses-real,core-artifacts-real}.test.js
```

The Worker control probe runs the same pinned CLI with Docker network access restricted to the container's loopback. It injects a lost reply, verifies original input receipt recovery and conflict handling, observes active steer in a native model request, discards a queued follow-up on interrupt and resumes the same thread with its earlier file.

```sh
MURM_CODEX_WORKER_REAL_TEST=1 MURM_TEST_AGENT_IMAGE="$image_id" \
  node --test dist/test/core-codex-worker-real.test.js
```

See the [OpenSandbox implementation manual](../docs/architecture/16-pi-opensandbox-backend.md#codex-app-server) for the supported request dialect and Session export contract.
