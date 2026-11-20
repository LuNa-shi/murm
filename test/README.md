# Test suite

The executable suite covers the Mission-scoped Task model: Mission and Task registration, canonical `task_take`, concurrent Executions of distinct Tasks within one Mission, ordinary Task exclusivity, typed dependencies, Material delivery, Judge iteration, Workspace continuity, Runtime fencing, capability profiles, observability, and deterministic fixture execution.

Lifecycle tests use the canonical Mission and Task fixtures. New behavior should use `createMission` and `createTask`, then exercise the public Task lifecycle through `task_take`, the Task mutation operations, and `task_finish`.
