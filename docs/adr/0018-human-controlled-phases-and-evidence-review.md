# ADR 0018: Issue-led research decisions and evidence-driven development

- Status: Accepted for development and research governance
- Date: 2026-11-11
- Clarification: GitHub Issue as the human-facing approval unit; local specs are for Coding Agent execution.

## Context

Research development needs human control of hypotheses, objectives and observable success criteria. At the same time, requiring a human to maintain a separate Phase Charter and approve each debugging run creates duplication and slows implementation. Historically, code changes and experiment reports were not consistently tied to an approved research question.

## Decision

1. **GitHub Issue is the approved work contract.** Human reviewers decide why the issue matters, which behavior should be implemented, what outcomes should be observed, which constraints apply, and the acceptance criteria. A drafted or created Issue alone is not approval. An explicit human decision is required.
2. **Implementation specs are agent working notes.** Files under [docs/phases/](../phases/INDEX.md) are named after Issue numbers, such as `issue-123-implementation-spec.md`, and contain concrete implementation proposals, affected modules, test plans and evidence links. They do not compete with GitHub Issue content or need a second Phase approval.
3. **Coding Agent autonomy is bounded.** Within an approved Issue, Agents may design implementation details, write code, review, test, diagnose, fix and repeat authorized probes. Significant new research hypotheses, changed scope, criteria or budget require human approval; routine debugging does not.
4. **STATUS and Architecture have distinct cadences.** [STATUS](../STATUS.md) continuously tracks meaningful implementation and verification progress with Issue/PR/commit evidence. [Architecture](../architecture/INDEX.md) is the accepted baseline, updated when a design-changing PR is accepted for merge and reconciled at Issue closeout.
5. **Formal runs are registered within the Issue.** Approved research/acceptance experiments use `EXP-YYYYMMDD-NN`; ordinary implementation tests and bounded debug probes do not. Reports use plain **Results / Analysis / Next steps**, and do not label Agent proposals as human decisions.

## Consequences

A human can manage and review research progress directly in GitHub's web interface while Coding Agents retain durable technical implementation notes in the repository. There is no duplicated human-facing Phase plan. The Issue defines **what and why**, the spec describes **how**, STATUS tracks **evidence and gaps**, and Architecture records **accepted design**.

An umbrella project phase may group several Issues without adding another approval layer. Historical runs remain historical and cannot retroactively prove acceptance.
