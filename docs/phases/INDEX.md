# Human-controlled research phases

> Type: Research governance · Status: Active · Based on [ADR 0018](../adr/0018-human-controlled-phases-and-evidence-review.md)

A **phase** governs research and development of SwarmEnv, not the internal Mission/Task lifecycle of research Agents running in SwarmEnv.

## Human responsibility

The human phase owner decides which research hypotheses are valuable and important, sets their priority, and approves the question or exploratory boundary, the intended design, experiment controls, allowable resources and stop conditions. An Agent may propose hypotheses and show why they might matter; proposals are not approval.

A phase may include an approved set of implementations, tests and experiment runs. The human can delegate a bounded spending allowance and a repeatable experiment matrix so routine work does not require repeated authorization.

## Coding Agent autonomy

Within approved scope, an Agent can inspect current code, implement requirements, identify bugs, write tests, repeatedly fix failures, and use previously authorized diagnostic probes. It may also execute and analyze registered runs covered by the approved matrix and budget. It should collect evidence of alignment rather than request permission at each iteration.

If a finding suggests the intended design is wrong or a new hypothesis is worth pursuing, the Agent presents the evidence, alternatives and expected impact; the human decides whether to revise or start a phase. Changes in fixture, provider/model, research outcomes, acceptance, resources or architecture that affect the study cannot be made silently.

## Phase flow

1. A human approves a [phase description](phase-template.md), which records research priorities, acceptance conditions and delegated autonomy.
2. The Agent identifies discrepancies between approved design and current code, then autonomously implements and tests within the boundary.
3. When approved research runs are needed, the Agent registers formal experiment IDs and runs the authorized matrix.
4. The Agent consolidates observations and limitations; the human reviews hypotheses and makes the next research decision.

A phase can authorize exploration of a bounded set of candidates but must not be represented after the fact as a clean single-variable causal study unless it was designed that way.

## Current phase registry

This documentation cleanup does not itself approve a new research phase or retrospectively register an earlier run. Add approved, owner-signed phase records here as they are created; no implicit default phase is approved by this index.
