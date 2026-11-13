# Test suite

The executable suite covers the Mission-scoped flat Task model: Mission and Task registration, canonical `task_take`, multiple shared-Mission Executions, ordinary Task exclusivity, typed dependencies, Material delivery, Judge iteration, Workspace continuity, Runtime fencing, capability profiles, observability, and deterministic fixture execution.

The old Root/Child test families were retired with the flat-only cleanup. They exercised APIs that no longer exist (`propose_task`, `create_child_task`, structural groups, parent review, and rework) and could only pass by restoring the removed compatibility surface. New lifecycle behavior belongs in the flat Mission/Task fixtures and should use `createMission`/`createTask` plus `task_take`.
