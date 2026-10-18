# Context Service and shared Materials

Context Service owns immutable shared Materials. A Material has a kind, scope,
evidence state, content reference and hash, source Task and Execution,
provenance, version, and optional supersession link.

Agents use the named `context_read` and `context_publish` tools to exchange
observations, conjectures, artifacts, and Judge feedback. The formal problem
input remains in the Task's Workspace. Publishing a Material does not rewrite a
Workspace or change the input snapshot used by an existing Execution.

Context Service rejects secret-bearing fields and keeps Task claims,
Execution state, process capacity, and Workspace filesystem authority in their
respective Services and Runtime components.
