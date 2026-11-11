# 06. Observability and evidence

> Type: Architecture · Status: Current implementation boundary; verify against source and run evidence.

Observability is a projection of recorded events, **not** the authority for Task, Execution, Material, Workspace or Judge state. A dashboard may expose what happened but does not automatically explain research progress.

## Essential distinctions

- Published Material, read Material, and evidence that a successor **acted on** Material are different observations.
- Concurrent Executions of a shared Mission Task do not prove useful independent Task decomposition.
- A Task marked complete, a local Candidate passing Judge, and satisfying the original Mission are distinct outcomes.
- `protocol_valid=true` does not prove mathematical or collaborative progress.
- Missing evidence is `unknown`, not zero.
- Source inspection, deterministic tests, bounded probes and real-Agent runs support different claims.

## Using evidence during development

The approved design defines intended behavior; source code shows what executes; tests and observations establish what is verified. Coding Agents may run and repeat tests or permitted diagnostic probes autonomously to close implementation gaps. A **new research hypothesis** or changed experimental scope is a human decision.

For a formal experiment, follow the [experiment workflow](../workflows/experiment.md) and [template](../experiments/TEMPLATE.md). Report **Results** (observed facts), **Analysis** (what they support and what remains uncertain), and **Next steps** (Agent proposals and explicit human decisions). The [experiment-analysis skill](../../.codex/skills/experiment-analysis/SKILL.md) provides supporting diagnosis; it does not approve research directions or substitute for the domain authority.
