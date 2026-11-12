# SwarmEnv — research context

> Type: Research context · Status: Ongoing research · Updated 2026-11-12

SwarmEnv is an experimental platform for understanding autonomous collaboration among multiple Agents. Agents can assume independent responsibilities toward a shared objective, produce traceable contributions, and allow subsequent Agents to verify, extend, revise or integrate those contributions.

## Two project goals

First, build a clear, reusable Agent Swarm environment and operating strategy. Pluggable external Services must be separated from the concrete compute units that invoke them. Task-centered organization provides division of work, observable progress and the input to a bounded Execution. Material-centered storage preserves reusable intermediate outputs and their origin; the relation between a Task, its inputs and its contributions must be explicit. Workspace manages the project's common baseline and private execution working copies. Its main branch accumulates integrated progress.

Second, demonstrate useful autonomous operation: Bots should propose and choose worthwhile work, make local progress, preserve sourced knowledge, find and continue others' contributions, correct mistakes and advance the shared project. A framework that exposes these operations does not by itself establish that its Bots use them well.

The [Phase 02 design](phases/0002-task-material-workspace/README.md) turns these goals into a proposed model and reviewable policies. Git branches and working copies are an engineering substrate for its first version. Research value must come from measured improvements in coordination, reuse, correction and cumulative outcomes; it is not established by renaming familiar infrastructure.

## Open research questions

- Under what conditions do Agents independently define useful work instead of repeatedly exploring the same shared objective?
- When does a published and read Material actually become an input to later research activity?
- When do Judge feedback or peer corrections produce a meaningful change in approach rather than repetition?
- Can greater parallel capacity or computational budget improve accumulated results, quality or efficiency, rather than just increasing activity counts?
- Can fresh, bounded Bots continue a research process through explicit Materials without inheriting private conversations, and at what reconstruction cost?
- Can a shared Workspace accumulate compatible, verified contributions while keeping integration delay and semantic conflict under control?

These are open research questions, not proven conclusions or permission to hard-code a particular mathematical route, scheduler or prompt strategy.

## Current experimental setting

PutnamBench, Lean/Mathlib and existing multi-Core execution paths are the primary current testbed. The long-term goal is a transferable collaboration system; problem-specific mathematical strategies are not default architectural requirements.

The **next approved work objective** lives in a human-reviewed GitHub Issue, which specifies why the task matters and the behavior and evidence expected. Coding Agents follow the approved Issue, its comments and explicitly accepted design revision, and record substantive implementation and verification progress in the Issue/PR. Numbered [phase documents](phases/INDEX.md) explain proposed changes. The complete current implementation is described in [Architecture](architecture/INDEX.md), updated in implementation PRs and reconciled at stage closeout.
