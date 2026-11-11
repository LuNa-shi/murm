# ADR 0018: Human-controlled research phases and evidence review

- Status: Accepted for research and documentation workflow
- Date: 2026-11-11
- Clarified: 2026-11-11 (Coding Agent autonomy within an approved phase)

## Context

Research progress was previously driven by a series of implementation commits and experiment reports with sometimes implicit hypotheses, acceptance criteria, and ownership of the next research decision. Requiring human approval for *every* implementation test would also interrupt productive debugging without protecting research direction.

## Decision

**Human ownership:** A human-reviewed design and approved [research phase](../phases/INDEX.md) determine intended behavior, which hypotheses are worth testing, their importance and priority, allowed scope, research experiments, budgets and stop conditions. Coding Agents may propose hypotheses and supply supporting evidence but may not independently select a new research direction and execute it.

**Delegated implementation:** Within an approved scope, Coding Agents independently implement, review, test, diagnose, fix and retest. Deterministic checks and bounded diagnostic probes inside an expressly authorized environment and spending allowance do not require a new approval or per-run report.

**Formal experiments:** Each formal research or acceptance run receives a preregistered `EXP-YYYYMMDD-NN` ID. Runs that are part of a human-approved matrix and resource allowance may proceed without per-run review. Changing a research hypothesis, approval boundary, fixture/checker, provider/model, acceptance criteria or budget requires another human decision.

**Evidence and reporting:** Separate observed results from interpretation and recommendations. Use the plain section headings **Results**, **Analysis**, **Next steps**, without inventing another set of formal truth/decision objects. Recommendations that require human approval remain pending until the owner decides.

## Consequences

Coding Agents can iterate efficiently toward a human-reviewed design, using code changes and reproducible tests as evidence of alignment. Human attention is reserved for significant research choices and permission boundaries. Old experiments remain historically accurate; they are not retroactively treated as preregistered. This ADR changes development governance, not runtime Agent autonomy or research performance.
