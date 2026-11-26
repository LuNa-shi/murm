# Test suite

The executable suite covers the Mission-scoped Task model: Mission and Task registration, canonical `task_take`, concurrent Executions of distinct Tasks within one Mission, ordinary Task exclusivity, typed dependencies, Material delivery, Judge iteration, Workspace continuity, Runtime fencing, capability profiles, observability, and deterministic fixture execution.

Lifecycle tests use the canonical Mission and Task fixtures. New behavior should use `createMission` and `createTask`, then exercise the public Task lifecycle through `task_take`, the Task mutation operations, and `task_finish`.

The [ProgramBench Pastel benchmark](../benchmarks/programbench-pastel/README.md) is an opt-in case with its own Docker, OpenSandbox and evaluation requirements. Run its local checks from a source checkout.

## Subagents verification

The [Subagents example](../examples/subagents-environment/README.md) accepts an arbitrary task. The regression suite exercises its controller and the installed example entry point. Set `SWARMENV_SUBAGENTS_COLLABORATION_TEST=1` for the native recursive delegation, interruption and continued-work checks in `subagents-collaboration-real.test.ts`. These checks require a local Pi/OpenSandbox installation and `SWARMENV_CORE_TEST_IMAGE` set to the immutable Worker image ID.

The fixed communication CLI and four-stage text-adoption adapter live in `test-support/subagents/`. The former verifies exact child output provenance from two original children by default. The latter takes three existing child IDs and verifies cumulative results across four host-driven stages. `subagents-environment.test.ts`, `subagents-controller.test.ts` and `subagents-stages.test.ts` cover those fixture contracts. Set `SWARMENV_SUBAGENTS_REAL_TEST=1` to exercise the installed communication fixture on the same native backend. See the [implementation manual](../docs/architecture/17-environment-reporting.md#optional-four-group-text-adoption-seam) for the fixture input and evidence contracts.
