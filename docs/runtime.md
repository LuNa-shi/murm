# Runtime and Workspace Manager

Runtime owns process capacity and delegates versioned filesystem operations to
Workspace Manager. Before starting Pi it materializes the selected Workspace
in the Execution's working directory, writes the problem codebase and task
requirements, records a Workspace manifest, and passes the generic Agent
prompt directly to the Pi adapter.

The Workspace contains `README.md`, the formal problem file when present,
`workspace-manifest.json`, Runtime metadata, revision records, checkpoints,
and the Pi session directory. It does not create prompt or context snapshot
text files. The manifest records the Task, Workspace snapshot hash, selected
revision, and runtime information.

Every write checks the Execution ID and fencing version. A resumed Execution
copies the selected revision into a new writable Workspace and retains the
source reference and revision as lineage. A clean Execution materializes the
Task's Workspace directly. Old fenced processes cannot write the current
revision.

`request_wait` saves a revision and checkpoint, changes the Execution to
`WAITING`, stops Pi, and releases the process slot. Runtime can wake that
same Execution or fence it after lease expiry. The Task remains the scheduling
responsibility until the Execution reaches a terminal state.
