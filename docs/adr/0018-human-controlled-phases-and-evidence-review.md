# ADR 0018: Issue-led research decisions and evidence-driven development

- Status: Accepted for development and research governance
- Date: 2026-11-11
- Clarification: GitHub Issue is the spec; Matt engineering skills govern the engineering workflow; local notes are optional execution context.

## Context

Research development needs human control of hypotheses, objectives and observable success criteria. At the same time, requiring a human to maintain a separate Phase Charter and approve each debugging run creates duplication and slows implementation. Historically, code changes and experiment reports were not consistently tied to an approved research question.

## Decision

1. **GitHub Issue is the approved work contract.** Human reviewers decide why the issue matters, which behavior should be implemented, what outcomes should be observed, which constraints apply, and the acceptance criteria. A drafted or created Issue alone is not approval. An explicit human decision is required.
2. **Local notes are not a second spec.** Optional Issue-numbered files under [docs/phases/](../phases/INDEX.md), such as `issue-123-implementation-notes.md`, contain code-level decisions, testing seams and context pointers when long work needs them. The GitHub Issue (or accepted Agent Brief) owns the requirements. The directory has no separate Phase approval function.
3. **Matt engineering skills define the development procedure.** When installed, use `/to-spec` for GitHub Issue specs, optional `/to-tickets` for approved vertical slices and dependencies, `/implement` or `/implement-spec` for execution, `/tdd` for behavior-level tests, and `/code-review` and `/pr` for review and publication. Do not create a duplicate local specification or ticket graph.
4. **Coding Agent autonomy is bounded.** Within an approved Issue, Agents may design implementation details, write code, review, test, diagnose, fix and repeat authorized probes. Significant new research hypotheses, changed scope, criteria or budget require human approval; routine debugging does not.
5. **STATUS and Architecture have distinct cadences.** [STATUS](../STATUS.md) continuously tracks meaningful implementation and verification progress with Issue/PR/commit evidence. [Architecture](../architecture/INDEX.md) is the accepted baseline, updated when a design-changing PR is accepted for merge and reconciled at Issue closeout.
6. **Formal runs are registered within the Issue.** Approved research/acceptance experiments use `EXP-YYYYMMDD-NN`; ordinary implementation tests and bounded debug probes do not. Reports use plain **Results / Analysis / Next steps**, and do not label Agent proposals as human decisions.

## Consequences

A human can manage and review research progress directly in GitHub's web interface while Coding Agents retain durable technical implementation notes in the repository. There is no duplicated human-facing Phase plan. The Issue/Agent Brief defines **what and why**, Matt engineering skills provide **how to develop**, optional local notes preserve technical context, STATUS tracks **evidence and gaps**, and Architecture records **accepted design**.

An umbrella project phase may group several Issues without adding another approval layer. Historical runs remain historical and cannot retroactively prove acceptance.
