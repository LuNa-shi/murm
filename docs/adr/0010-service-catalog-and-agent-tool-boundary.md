# ADR 0010: Services are the Agent tool boundary

Status: accepted.

## Decision

Agent capabilities are organized as named Services. The MVP exposes Task,
Execution, Workspace, Context, and Judge Services. The catalog provides
`list_services`, `get_service_metadata`, and `list_tools`; each operation also
has a named tool with a schema and side-effect declaration.

Pi receives the named tools through the SwarmEnv extension. `swarmenv_call`
remains a compatibility transport for old sessions, but the generic prompt
directs new Agents to discover and use named Service tools. Runtime internals
such as process spawning and fencing remain behind the bridge.

## Consequences

An Agent can discover the complete capability surface without memorizing one
large multipurpose operation. Service ownership is visible in logs and
metadata, and adding a tool requires a catalog entry, a route, and a focused
contract test.
