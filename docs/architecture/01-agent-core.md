# 01. Agent Core

The Agent Core boundary is implemented by the Pi adapter and the reusable
identity loop. Its job is to run a model session with a truthful, bounded view
of SwarmEnv.

## Prompt layers

`src/agent/agent-prompt.js` defines the stable bound-identity SOP. The adapter
delivers the stable identity contract through Pi's system prompt append path;
dynamic Mission, Task, Execution and Workspace context is placed in the user
turn. The implementation keeps independent prompt versions so a report can
distinguish a changed system contract from a changed task binding.

The current bound-identity contract (verify the concrete hash for each run) instructs an identity to:

- use the current valid Execution and its task-scoped capabilities;
- call canonical `task_take` in its own Core lane;
- keep the same identity, Core and Session after a successful take;
- register a Task only for a genuinely independent responsibility;
- use exact capability IDs from the current directory;
- treat Judge failures as feedback and revise the current route;
- publish evidence with provenance and record feedback decisions;
- save Progress before checkpoint, handoff or typed blocking;
- avoid voluntary handoff; only end an Execution at a valid lifecycle boundary, saving Progress when required.

The prompt is an input to an experiment, not a hidden explanation of what the
Agent actually did. Reports must record its version/hash and the tool/profile
snapshot used by the run.

## Capability profile

`src/agent/capability-profile.js` projects Registry and Runtime capabilities
into the exact profile visible to one Agent role. The profile carries service
and contract versions, manifest hashes, input/output schemas, audience, side
effect and idempotency metadata, documentation references, and Runtime-owned
markers. Internal lease/process operations are filtered out of the normal
bound profile.

The profile is a permission and documentation boundary. A service description
does not grant authority; the Bridge and domain services authenticate the
operation against the current Task/Execution envelope.

## Bridge and identity loop

`src/agent/services-bridge.js` receives named tool requests, validates the
current binding and capability contract, and routes to the Services SDK. A
failed bind is a prepare/rollback boundary: the provisional Execution is
stopped or fenced before the Bridge clears its in-memory identity.

`src/runtime/identity-task-loop.js` keeps one identity reusable on one Core
lane. It discovers or takes eligible work, binds it, runs ordered turns, and
releases only the current Execution. It must not create a second concurrent
claim for the same identity.

## What an experiment must capture

For every real run, the input snapshot should identify:

- provider and model;
- stable system prompt version/hash;
- dynamic prompt or Task-context hash;
- capability profile and service-document hash;
- tool names and schemas actually exposed;
- identity/Core/session configuration;
- whether the run used a real Agent, a fixture, or a controlled failure.

Without these fields, a later trace cannot establish whether an observed
behavior came from code, prompt, tool availability, or the model route.
