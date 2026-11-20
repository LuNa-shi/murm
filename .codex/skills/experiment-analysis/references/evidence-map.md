# Task-centric experiment evidence map

Use the experiment directory and metadata as the boundary; summary fields only locate records. Analyze the exact implementation commit. Missing sources are unknown, not zero activity.

| Question | Primary evidence | What to establish |
| --- | --- | --- |
| Task proposal | Agent calls, Task rows, operation receipts, contract revisions and authenticated Bot identity | User/system/Agent origin, question, admission or rejection, actual independent work |
| Execution | Task/Execution/Session/Core IDs, Runtime, Workspace revisions, Agent JSONL | Continuity, actual work, predecessor, ownership, resource use and terminal reason |
| Materials | Immutable source/version, links, reads, receiver decisions and downstream edits/checks | Checkpoint versus cross-Task delivery; use versus merely reading |
| Updates | Feedback identity/type, delivery and decision events, Task changes | Current processing, successor processing, actual response, expired reminders |
| Judge | Requests, scope/content/environment identity, checker result, subsequent edits | Real iterative checking, not cache/replay or new Task rituals |
| Services | Registry/Bridge/service requests and authoritative state | Same task identity, supported deployment boundary, errors and concurrency |
| Acceptance | Preregistered phase/Experiment contract, all baseline/treatment runs and conformance ledger | Improvement with event coverage, guardrails and explicit failed/unknown cases |

Typical stores are `metadata/`, `logs/projects/<project>/`, `state/projects/<project>/project.sqlite` (Task/Bot/Execution/Mission coordination), sibling `context.sqlite` (Material) and `judge.sqlite` (diagnostic checks), public Workspace revisions and private support manifests and the metadata-declared observation database. Report records as present, missing, malformed, empty or not applicable. Check the run-specific contract before assigning meaning to a stored field. For the registered Task contract, `depends_on` records a blocking prerequisite. Trace the relation to a Mission gap through the proposed gap, delivered artifact and its observed use.

Join explicit stable IDs first: experiment/event, Mission/Bot/Task/Execution/Session/Core/operation, Material/CheckResult/revision. Use timestamps only as a labelled fallback; ambiguous reusable-Core events remain unmatched. Order attempts using durable take and finish timestamps for each Execution.

Tool contracts come from serialized runtime metadata or source at the recorded implementation commit. If neither exists, state schema unavailable. Source-verified only is distinct from observed in the run. Read raw Agent JSONL locally for semantic work summaries; never infer hidden reasoning or publish full transcripts.

Evidence references use relative paths plus line/event/row. For external stores use `<external>/<basename>` and commit/store identity, never private absolute paths. Do not change raw evidence or authoritative state. Publish only sanitized metadata, findings and references; omit credentials, raw proof/candidate contents, stdout/stderr and other private payloads.
