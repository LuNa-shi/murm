# Four-core PutnamBench benchmark uses isolated projects

Status: accepted. The PutnamBench experiment treats one formalized problem as
one SwarmEnv project. A project owns its SQLite database, root Task, four
direct-child proof Tasks, four private Runtime Workspaces, four Pi session
directories, and one redacted report. Projects may run in bounded parallel
groups, while each project always starts exactly four Agent Core processes.

## Decision

The benchmark input is the formalization source at a pinned PutnamBench commit
plus the locked Lean, Mathlib, checker, and environment metadata. The source
is published as shared Context Service Material with a `sorry` placeholder so
Agents receive the theorem statement without a known candidate or solution.
Each child Execution freezes that Material reference and metadata in its
Initial Context. Private Workspace files and Pi session state stay inside the
project and are never used as cross-project communication.

Benchmark Agent Cores receive only the `swarmenv_call` extension. Built-in
filesystem, shell, web, skill, prompt-template, and context-file tools are
disabled. A final audit checks input and prompt hashes, Material provenance,
candidate source Execution, project boundaries, observed tool events,
forbidden placeholders, and report redaction before a result can count.

## Consequences

The runner can compare four concurrent Cores on one problem and can schedule
several independent projects without sharing mutable service state. Reports
contain IDs, hashes, classifications, timings, versions, resource snapshots,
and audit flags, while candidate text, proof text, and raw Pi transcripts stay
out of committed artifacts. A project timeout or setup failure is recorded in
that project's report and does not cancel sibling projects.
