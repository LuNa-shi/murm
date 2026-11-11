# ADR 0018: Human-controlled stages and evidence review

- Status: Accepted for documentation workflow
- Date: 2026-11-11

## Context

The project accumulated many implementation commits and experiment reports,
but the work unit, tested hypothesis and evidence boundary were often implicit.
An Agent could produce a plausible trace analysis and immediately widen the
implementation without a human decision about the next question.

## Decision

Use a human-approved Stage Charter as the control point for a worktree. The
Stage owner chooses the primary hypothesis, allowed changes, comparison,
acceptance conditions and stop rules. Every run inside the Stage receives a
canonical `EXP-YYYYMMDD-NN` ID and a pre-run registration.

AI may implement and repair defects inside the charter, run tests and
experiments, and draft reports. A change to the hypothesis, architecture
boundary, input/model/resource configuration or acceptance condition requires a
human Stage decision.

Experiment reports separate Truth (observed facts), Assessment (evidence-backed
interpretation) and Decision (the Stage owner's next action). The
experiment-analysis skill supplies evidence joins and diagnostic drafts; it is
not the authority for causal conclusions.

## Consequences

The project gains a stable link between architecture, implementation and
evidence. Iteration may become slower when a new hypothesis is needed, but a
series of commits can no longer masquerade as progress without a stated
question and a reviewable result. Historical experiments remain historical;
they are not rewritten to fit the new ID or reporting format.
