# End-to-end paths

The deterministic ScriptExecutor verifies the Task, Execution, Workspace,
Material, Judge, checkpoint, wait, recovery, and PASS application path. It
uses the same named Service boundary as a real Agent and never writes directly
to SQLite.

The real Agent path starts Pi through NuRouter, passes the reusable Agent
prompt at startup, and lets the Agent use the Service bridge for Task browsing,
claiming, Workspace inspection, Material exchange, and candidate submission.

PutnamBench reports keep project IDs, hashes, timings, versions, and audit
flags. Candidate source, proof text, raw transcript, stdout, and stderr are
excluded from sanitized reports.
