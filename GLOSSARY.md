# SwarmEnv

SwarmEnv provides a Core library for running Bots and programmable Environments for their collaboration. The [Phase 0005 design](docs/phases/0005-core-environment/README.md) defines this stage's requirements, and [Architecture](docs/architecture/INDEX.md) describes the implementation and retained compatibility paths.

## Core and Environment vocabulary

**Core**
The importable library that owns Bot identities, resource lifecycles, input delivery and Service access for its Runtimes.
_Avoid_ capacity slot, research role, permanent manager.

**Runtime**
One host run created through Core, with its own Bot capacity, registered resources and close responsibility.

**Slot**
One unit of a Runtime's Bot capacity, occupied until the Bot's resource cleanup is complete.
_Avoid_ Core, research role, manager lane.

**Environment**
A host program that assembles a Runtime and Services, supplies collaboration policy and routes inputs among Bots.

**Profile**
A named, frozen configuration of a Bot role, including its prompt, model, image and permitted Service operations.

**Bot**
One identity with a private Session and workDir, belonging to one Runtime. In flat, a Bot has zero or one Execution.
_Avoid_ reusable Agent identity.

**Session**
The Bot's model conversation context, retained across its input turns.

**workDir / Working directory**
A Bot's private project directory. In flat, an active Execution's unsaved changes remain in this directory until published to Workspace.

## Flat vocabulary

Flat's Mission, Task and public-result terms follow the approved [Issue #122 model](docs/phases/0002-task-material-workspace/01-model-and-runtime.md).

**Mission**: The shared research objective, resource boundary and final acceptance scope. A Mission is not a Task to be taken.
_Avoid_: Goal object, Mission Task, root Task.

**Task**: A bounded responsibility with its own objective, deliverable and completion conditions. It has at most one current executor.
_Avoid_: child Task, manager Task, shared Mission Task.

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

## Task design vocabulary — Issue #137 draft

These definitions capture the [Issue #137 discussion](https://github.com/LuNa-shi/SwarmEnv/issues/137); they do not describe implemented interface changes.

**Mission gap**: A missing result, capability or understanding that a Task is intended to address in support of the Mission, including by solving a local problem. Its contribution may be indirect or exploratory and does not require a complete route to Mission acceptance.

**Task priority**: An advisory judgment of the relative value of investing the next available computation in a Task, given the current Mission state and available evidence. It informs a Bot's choice without compelling it and can change as results, uncertainties and alternative routes change.

