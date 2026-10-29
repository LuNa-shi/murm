# SwarmEnv Glossary

**Mission** is the shared objective scope for one problem or project. It
contains a Task pool, a relation graph, and optionally a final acceptance
contract. It does not make one Task the owner of all other Tasks.

**Task** is one durable responsibility in a Mission. It has a concise summary,
goal, scope boundary, expected output, acceptance conditions, Mission
contribution, document references, validation mode, priority, and lifecycle
state.

**Peer Task** is a Task with no origin relation. It enters the same Mission
pool as every other Task.

**Child Task** is a Task with a `spawned_from` origin relation. The relation
records provenance; it does not grant ownership, approval authority, or special
scheduling behavior. Child and Peer Tasks share one lifecycle.

**Task relation** is a durable link such as `spawned_from`, `related_to`,
`depends_on`, `supersedes`, `duplicate_of`, or `contradicts`. Only
`depends_on` changes Claimability.

**Overlap review** is the Agent-authored comparison of a proposed Task with
existing Tasks and Context Documents. It explains why the proposal is distinct.
Task Service provides comparable records and validates references; it does not
apply an opaque semantic duplicate detector.

**Task kind** is a domain label such as `proof`, `research`, `analysis`,
`coordination`, or `artifact`. It selects validation behavior, not topology or
permissions.

**Validation mode** is the evidence required by a Task contract. Proof Tasks
need a Candidate and passing Judge result; research and coordination Tasks need
valid Context Documents or Materials; artifact Tasks need a Workspace artifact
reference and explanatory Document.

**Task completion** is self-owned. The current Execution satisfies the Task's
contract and records result references. Other Agents may consume the result or
propose follow-up work but do not approve or rewrite it.

**Task list** is the bounded Mission-scoped view of claimable Tasks.

**Execution** is one leased attempt to carry out one Task. Runtime binds it to
one Core, Agent Session, and private Workspace revision.

**Blocked** means a Task has a concrete unresolved dependency and no active
Execution. An empty queue is `IDLE`.

**Workspace** is the private, versioned working surface of an Execution. Shared
results leave the Workspace through Context Documents or artifact references.
Workspace is Runtime-owned, not an independently registered external Service.

**Context Document** is an immutable, versioned, Mission-scoped record of a
fact, failure, decision, experience, analysis, artifact, or candidate. The
current implementation persists this collaboration record as a Material.

**Material** is the current Context Service representation of a shared
Document, including source Task/Execution provenance and evidence state.

**Judge** is the independent validator for Candidate evidence. Its CheckResult
is tied to a Task, Candidate, Workspace snapshot, checker, and environment.

**Core slot** is reusable physical worker capacity. It has no semantic Task
ownership.

**Core Daemon** is the long-lived supervisor for one Core. It discovers a
bounded Task shortlist, selects and Claims one Task, starts its Execution,
releases the Session when the Execution ends, and returns to discovery.

**Task Controller** is the deterministic reconciliation loop that maintains
claimability, reopens eligible Blocked Tasks, and signals idle Core Daemons. It
does not choose or Claim semantic work.

**Agent Session** is one Agent process session. A bound Session belongs to one
Execution and receives a role-scoped capability profile.

**Service** is an independently owned capability provider with a versioned
public interface, schemas, usage guidance, side-effect declarations, and
structured errors.

**Service Manifest** is the declaration used to register a Service with
SwarmEnv. It describes identity, endpoint/adapter, capabilities, role scope,
schemas, and help references.

**Service Registry** validates Manifests and derives the role-scoped capability
profile used for Agent tool registration and dynamic prompt construction.

**Runtime-owned capability** is a Task- or Execution-scoped capability supplied
by Runtime rather than an independently registered external Service. Workspace
operations and lease/fencing enforcement remain Runtime-owned.

**Lease** is the time-bounded ownership period of an Execution. Heartbeats
extend it; expiry fences the old owner.

**Experiment** is one complete observed run of one Mission, including Tasks,
Executions, Materials/Documents, Workspace revisions, Judge results, Agent
Sessions, Core lanes, and Service events.

**Core lane** is the timeline identity of one reusable Core slot over an
Experiment.

**Execution segment** is one continuous assignment of an Execution attempt to a
Core lane.

**Interaction** is one ordered Agent-facing exchange: a message, capability
call, result, lifecycle notification, or diagnostic.

**Observation Event** is append-only evidence for monitoring and diagnosis. It
does not replace domain truth held by Task, Runtime, Context, Judge, or
Workspace.

**Diagnostic Finding** is an evidence-linked, typed conclusion about an
Experiment or one of its parts.

**Eligible window** is a reporting interval with enough independent unfinished
work for the configured Core slots to execute concurrently.

**Deterministic test scenario** is a bounded fixture used to exercise the
production lifecycle with known inputs, calls, and acceptance conditions.
