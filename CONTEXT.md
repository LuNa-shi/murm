# SwarmEnv Context

SwarmEnv coordinates long lived tasks whose work can be divided, paused, resumed, replaced, and independently checked. This context defines the task language used by the design and its MVP.

## Language

**Task**:
A durable goal with a registered task type, its own completion contract, and a responsibility lifecycle.

**Task type**:
A versioned rule set that specifies an allowed task shape, required outputs, and completion policy. The MVP registers `default`, `research`, `proof`, and `implementation`; any registered type may be used as a root or direct child; an Agent cannot create an unregistered type or omit its required acceptance fields.

**Completion contract**:
A structured set of required child results, Material outputs, optional candidate checks, and review rules that determines when a Task may become satisfied.

**Acceptance authority**:
The actor allowed to accept or request rework for a Task. A child Task is reviewed by its Parent Task's active execution; a root Task is reviewed by its owner.

**Parent Task**:
A Task that creates and owns the local responsibility for one or more child Tasks.

**Direct child Task**:
A Task whose `parent_id` points to the current Parent Task. A Parent Task may wait for the terminal state of a direct child Task; nested task trees are handled one parent-child edge at a time.
_Avoid_: dependency node, arbitrary prerequisite

**Cross-tree relation**:
A support, dependency, or weaving relationship between Tasks that is not a direct parent-child edge. In the MVP, it is descriptive context or a material reference and does not itself create a scheduling, blocking, wake-up, or claim condition.
_Avoid_: schedulable dependency

**Execution**:
One replaceable period of responsibility for carrying out a Task.

**Agent Core**:
The active model and tool loop that carries out an Execution. In the MVP, a local NuRouter/Pi Agent Core Adapter starts Pi for the Execution; the adapter is an execution mechanism, not a fifth core domain object.

**Pi session**:
A resumable Agent Core session artifact associated with an Execution. It can help restore the loop, but Task, Execution, Material, and CheckResult remain the authoritative records.

**Execution state**:
The single lifecycle status of one Execution, including whether it is running, waiting, finished, or invalidated.
_Avoid_: protocol phase

**Parent review**:
A wait condition used when a child has delivered material but its Parent Task must decide whether the delivery is sufficient. The parent may accept it or request rework.

**Steer**:
An immutable instruction delta appended by an authorized Parent Task during rework. It preserves the original Task specification, workspace, context snapshot, and checkpoint lineage.

**Resumable Execution**:
Every non-terminal Execution has durable workspace, context, and checkpoint references. A new Execution may take over after expiry or fencing while preserving that lineage.

**Task state**:
The single lifecycle state of a Task, including whether it is open, running, waiting, blocked, complete, or ended.
_Avoid_: parallel Task status truth

**Blocking reason**:
An explicit reason why no Execution may currently claim a Task, such as capacity or an unmet admission condition. It does not describe an Execution that has deliberately entered a wait.
_Avoid_: wait condition

**Material**:
A versioned piece of shared work, evidence, input, observation, or artifact that can be referenced across Tasks and Executions.

**CheckResult**:
An independent, structured judgment about a candidate Material under a specified Task, input, checker, and environment.

**Context Service**:
The shared service that stores, versions, reads, and publishes immutable Material for Agents. It does not claim Tasks, schedule Executions, or manage private Workspaces.

**Initial Context**:
The frozen input bundle for one Execution. It contains the Task specification, initial prompt, selected Material references and hashes, input snapshot hash, and the service/environment information needed by that run. Later shared Material does not silently change it; parent rework appends steer instructions.

**Workspace Manager**:
The Runtime-owned component that creates, saves, restores, releases, and fences an Execution's private Workspace and checkpoint files. It is not exposed through the Agent-facing Services SDK.

**Services SDK**:
The Agent-facing client boundary for Task/Execution operations and Context Service Material operations. It carries operation, version, and fencing metadata and does not expose Workspace Manager operations.
