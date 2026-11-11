# Development workflow for Coding Agents

> Type: Workflow · Status: Active · Updated: 2026-11-11

The [AGENTS.md](../../AGENTS.md) file owns human/Agent authority boundaries. This document describes the practical development loop; it does not confer approval for a new research hypothesis.

## 1. Establish the contract

- Identify the human-reviewed design requirement, approved phase or assigned issue, observable success and failure cases, and explicit non-goals.
- Inspect the relevant [architecture](../architecture/INDEX.md), current source, tool schemas and tests. Current implementation is evidence of what executes, not authority to change a design requirement.
- Record the clean starting commit. If the PR head has moved, inspect its new changes before proceeding.
- If approved sources conflict, report the inconsistency; do not resolve it by silently conforming the documentation to current code.

## 2. Iterate autonomously within scope

1. Work on a dedicated branch/worktree, never directly on `main`.
2. Implement a complete behavior slice and review it against the intended contract.
3. Run focused regression/integration tests. Reproduce failures, inspect the evidence, correct the code, and rerun as needed.
4. If deterministic tests are insufficient, run a **small, bounded diagnostic probe** when its tools, environment and spending are already authorized. Keep the commit, input, result and failure evidence locally; a formal Experiment ID is not needed for ordinary debugging.
5. Repeat this loop until the implementation is supported by sufficient evidence or a real blocker is identified. No individual status report or new approval is required for every test, repair or in-scope rerun.

Bug fixes that restore the accepted behavior are delegated. A new architecture direction, hypothesis, benchmark/checker, provider/model, acceptance threshold or resource expansion is not.

## 3. Verify alignment

- Trace the affected boundaries as appropriate, including caller/Bridge/SDK/service, Runtime, prompt/schema, and tests.
- Verify both intended behavior and guardrails: authentication, execution identity, idempotency, fencing, concurrency, error handling, cleanup, privacy and costs when relevant.
- For code changes, run the relevant tests and, if available, `npm test` and `git diff --check`. Clearly identify any test not executed.
- Separate **implementation done**, **deterministic verification**, **real-Agent observations**, and **not yet validated**. Do not turn static plausibility into an acceptance claim.
- Only run a formal registered experiment when it is needed and approved under [the experiment workflow](experiment.md); a quick debugger probe is not a substitute for controlled research evidence.

## 4. Report at decision points

At a meaningful milestone or completion, report changed files and commit, intended contract, tests/probes performed, representative failures and fixes, evidence of alignment, unresolved limits, and suggested next actions. Escalate immediately if completing the task requires changing the approved scope or research hypothesis.

Unless explicitly authorized, do not merge a PR, change Issue status, start a paid run outside an approved allowance, or modify original experiment inputs or private data.

## 5. Maintain documentation

Update the current relevant specification and links when an approved design changes; do not create a second source of truth in an Issue, readme or new `archive/` directory. Recover obsolete documents from pinned Git history. New project-wide terms or report conventions need human review.
