# Collaboration quality is verified global progress

Status: proposed. SwarmEnv evaluates a multi-Agent collaboration by the
verified, parent-relevant progress it produces under a fixed task and resource
budget, with lifecycle integrity and recoverability as hard validity gates.
Activity, child count, raw Agent time, and queue utilization remain diagnostic
signals; they cannot substitute for a root outcome or a provenance-preserving
handoff that changes the root path.

## Decision

The primary comparison is a vector rather than an opaque collaboration score:

1. **Outcome:** Root Task completion and time-to-root-pass under the fixed
   budget.
2. **Verified progress:** accepted child results, new Judge evidence, and
   parent actions that can be reconstructed from Task, Execution, Material,
   Workspace, and CheckResult facts.
3. **Information conversion:** delivered Handoffs that the parent consumes and
   converts into a later root-relevant action.
4. **Resource and coordination cost:** Agent time, waiting, dispatch delay,
   wake delay, service activity, and Judge time, reported separately.
5. **Integrity:** provenance, lease, fencing, wait-condition, and process
   lifecycle invariants.

A run is not declared better because it has more Tasks, turns, Materials, or
active Cores. A swarm advantage requires a paired root-only comparison on the
same problem distribution, model, toolchain, timebox, and resource budget.

## Consequences

Reports can distinguish a useful child result from a completed but unused local
branch. A problem with no independent route does not fail the scheduler, and a
busy scheduler does not prove that the mathematical route improved. Analysis
can attribute a regression to missing work supply, handoff non-consumption,
parent review delay, route lock-in, or coordination cost using event order and
domain state rather than model-generated explanations.

The vector is intentionally not collapsed into one weighted score. Different
iterations may improve success probability, wall-clock time, resource cost, or
reliability independently; a single score would hide those trade-offs and
make optimization targets arbitrary.
