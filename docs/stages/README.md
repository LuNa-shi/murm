# Stage-controlled collaboration

A Stage is the unit of human control. A Stage has one dedicated worktree and a
human-approved charter. It may contain implementation commits and several
experiments, but it has one primary hypothesis and one explicit decision owner.

## Human/AI boundary

| Decision or action | Owner |
|---|---|
| Primary hypothesis and why it matters | Human |
| Scope, non-goals, allowed variables and stop conditions | Human |
| Architecture interpretation and final causal judgment | Human, with AI evidence support |
| Implementation inside the approved scope | AI |
| Bug fixes that restore the approved contract | AI |
| Deterministic tests, probes and registered runs | AI |
| Truth report and evidence index | AI draft; human review before stage decision |
| New architecture direction or changed hypothesis | Human decision; new or amended charter |

AI must stop and report a change proposal when a finding changes the stage's
hypothesis, acceptance condition, fixture, provider/model, resource budget or
architecture boundary. It must not silently widen the worktree.

## Stage lifecycle

1. The human writes and approves a Stage Charter.
2. AI maps the relevant architecture and records the implementation baseline.
3. AI implements only the chartered change in the Stage worktree.
4. Each run receives a new canonical `EXP-YYYYMMDD-NN` ID and a pre-run
   registration.
5. AI produces a Truth report, then an evidence-backed Assessment draft.
6. The human reviews the report and decides: continue, revise the charter,
   close the Stage, or start a new hypothesis.

One experiment may discover a bug. That bug can be fixed within the charter if
it is a contract or implementation defect. If fixing it changes what the
experiment is testing, stop the run, record the discovery, and create a new
experiment registration or Stage decision.

Use [`stage-charter-template.md`](stage-charter-template.md) for new work.
