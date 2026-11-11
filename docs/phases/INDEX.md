# Issue-linked implementation specs

> Type: Coding Agent working documentation · Status: Active · See [ADR 0018](../adr/0018-human-controlled-phases-and-evidence-review.md)

**GitHub Issues are the human-facing unit of development approval and planning.** A typical Issue is the scope of one implementable and verifiable stage of work. We do not require a separate Phase proposal, title, charter or approval document.

## Single source of approved intent

The human-reviewed GitHub Issue defines:
- **Why:** the problem, evidence, significance and priority.
- **What:** expected behavior, scope and non-goals.
- **Observe:** phenomena to demonstrate, acceptance criteria and meaningful counterexamples.
- **Permission:** constraints, allowed tests/experiments, resource allowance and decisions that must return to the human owner.

An Issue draft prepared by a Coding Agent is a proposal until the human explicitly approves it. The Issue's GitHub conversation or a clearly linked human instruction can record that approval. An explicit material change to its scope requires human review; an Agent must not silently change an Issue to fit its implementation.

## Implementation specs for Coding Agents

The `docs/phases/` directory stores **optional technical specifications organized by GitHub Issue number**, for example:

`docs/phases/issue-123-implementation-spec.md`

Start from [issue-implementation-spec-template.md](issue-implementation-spec-template.md) when an Issue is complex enough to benefit from durable technical notes. The file records the relevant Issue URL, an approved scope reference, current code baseline, proposed implementation, affected modules, test/evidence plan, progress and remaining gaps.

This spec is **derived from the Issue** and exists for the Coding Agent, not as another human-facing source of product requirements. Technical approaches may change without permission if the approved outcome remains intact. Never duplicate the full Issue or claim that an implementation spec itself approved a new hypothesis.

A small Issue may need no local spec. An umbrella research phase may contain multiple linked Issues; it does not acquire an independent approval process.

## Workflow and lifecycle

1. The human provides a problem; a Coding Agent may draft a GitHub Issue for review. Approval of the Issue establishes intended scope and success criteria.
2. The Coding Agent links its PR/worktree and optional Issue-numbered spec, translates objectives into technical work, implements and repeatedly tests within authorized limits.
3. [STATUS.md](../STATUS.md) tracks meaningful implementation and evidence milestones using Issue and commit links. Diagnostic runs within approved limits do not need a new Issue or a formal experiment registration.
4. Formal research runs, where necessary, use the approved Issue and [experiment workflow](../workflows/experiment.md).
5. When a design-changing PR is merged, update [architecture/](../architecture/INDEX.md) for that accepted change. At Issue closeout, confirm Architecture, STATUS, spec and GitHub evidence are aligned.

If the Issue changes materially, update the implementation spec and rerun affected tests. If a spec exposes an unapproved architecture or research-direction change, propose it in the Issue and stop only the out-of-scope work.

## Current active specs

This documentation refactor creates no new project development Issue or approved implementation spec. Add entries here by **Issue number and GitHub link** when actual specs are needed. Closed specs can be removed from the working tree once the accepted design and evidence have been reflected in Architecture/STATUS and the GitHub record; Git retains their history.
