# SwarmEnv research runtime

SwarmEnv coordinates independent research responsibilities and public reusable results within a shared Mission. These terms follow the approved [Issue #122 model](docs/phases/0002-task-material-workspace/01-model-and-runtime.md); implementation and compatibility behavior belong in [Architecture](docs/architecture/INDEX.md).

## Language

**Mission**: The shared research objective, resource boundary and final acceptance scope. A Mission is not a Task to be taken.
_Avoid_: Goal object, Mission Task, root Task.

**Task**: A bounded responsibility with its own objective, deliverable and completion conditions. It has at most one current executor.
_Avoid_: child Task, manager Task, shared Mission Task.

**Bot**: One research identity with its own private conversation and computation context. A Bot has zero or one Execution.
_Avoid_: reusable Agent identity.

**Core**: A reusable capacity slot in which one Bot works at a time.
_Avoid_: research role, permanent manager, Core lane.

**Session**: The Bot's model conversation context. Session events are not research deliverables.

**Execution**: A Bot's authorized interval of responsibility for one taken Task, through finish and cleanup.
_Avoid_: permanent worker, resumed predecessor identity.

**Take**: Acquiring exclusive current responsibility for an eligible Task.
_Avoid_: scheduler assignment, manager dispatch.

**Finish**: Ending the current Execution with a truthful Task outcome and bounded cleanup. Done, incomplete, blocked and cancelled express different outcomes.

**Material**: Immutable readable research content or durable attachments, with production and use provenance. Its usefulness or truth is not established by its existence or source alone.
_Avoid_: mandatory Fact, Experience, Progress or Handoff object types.

**Evidence**: An explanation of what supports a specific research claim and its limitations. Evidence can be expressed naturally in Material content.
_Avoid_: global trust score, mandatory Evidence object.

**Workspace**: The Mission's public project repository, with main and immutable public file revisions, including unmerged saves.
_Avoid_: Bot private directory, Workspace lineage.

**Working directory**: The isolated local project files available to an active Execution. Unsaved private changes are not public Workspace revisions.

**Revision**: An immutable Workspace file version with explicit ancestry. Revision numbering alone does not establish ancestry.

**Main**: The current shared Workspace integration version. Saving a revision does not by itself move main.

**Candidate**: An ordinary proposed research file at a specific Workspace revision and path.
_Avoid_: separate Candidate entity, Candidate ID, Candidate store.

**Judge / CheckResult**: A checking service and its result bound to particular immutable inputs, checker and environment. A diagnostic result is separate from Task completion and Mission acceptance.

**Mission submission**: A fixed final delivery selected for Mission acceptance, containing current main and an explicit Material selection.

**Handoff**: Continuing useful work through public Task state, Material and saved files after the earlier Bot ends.
_Avoid_: restoring a predecessor's private conversation or computation.

**Dependency**: A genuine prerequisite that must be satisfied before a Task can proceed. Proposal origin is not a dependency or hierarchy.

**Dispute**: A reasoned question about a specific claim or section of a Material. It does not itself replace the whole Material.

**Supersession**: An explicit whole-Material replacement by a self-contained successor. Revocation removes the matching active relation while preserving its history.

GitHub development Issues and PRs are engineering records, separate from research Tasks and Missions. The word “goal” may describe an objective inside a Mission or Task; it does not name an additional runtime object.
