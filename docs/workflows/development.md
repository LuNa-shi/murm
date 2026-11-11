# Development workflow for Coding Agents

> Type: Workflow · Status: Active · Updated: 2026-11-11

The [AGENTS.md](../../AGENTS.md) file defines human/Coding Agent authority. **A human-approved GitHub Issue is the primary requirement and acceptance contract**. An optional Issue-numbered [implementation spec](../phases/INDEX.md) describes how the Agent intends to implement it.

## 1. Establish the Issue contract

1. Understand the problem and why it matters, expected observable behavior, counterexamples, constraints, evidence requirements and allowed resources from the GitHub Issue.
2. If asked to plan work, draft the Issue for human review **before** implementing a significant new research direction. A created Issue is not automatically approved. Record explicit approval through the Issue or linked human instruction.
3. Read [accepted architecture](../architecture/INDEX.md), current code, tool schemas and tests. Record the starting clean commit and any approved Issue changes to the baseline.
4. Create `docs/phases/issue-<number>-implementation-spec.md` from the [template](../phases/issue-implementation-spec-template.md) when a complex Issue benefits from a durable technical plan. The plan may be updated autonomously but cannot override Issue goals.

## 2. Implement and diagnose independently

- Use a dedicated branch/worktree. Implement an end-to-end behavior slice, including required interfaces and regression coverage.
- Follow **implement → self-review → test/probe → diagnose → fix → retest**. Run focused tests and bounded probes as needed within approved provider/model, time, cost and task scope.
- Do not request permission or file a human-facing report for each debugging iteration. Preserve consequential version/input/result evidence and summarize at milestones.
- If the Issue's approved contract is internally inconsistent or requires a new research hypothesis, modified acceptance condition or broader architecture, return the question to the human in the Issue instead of silently widening the spec.

## 3. Verify alignment and report

- Check requirements and counterexamples against code paths and observed behavior, including authorization, fencing, concurrency, version binding, error handling, cleanup and privacy where applicable.
- Run relevant tests; for code changes when available run `npm test` and `git diff --check`. Record skipped checks honestly.
- Update [STATUS.md](../STATUS.md) on meaningful implementation or verification progress, with Issue/PR/commit/test links and unresolved limitations.
- PRs should link the approved Issue and optional implementation spec. At a milestone, present a consolidated evidence-based summary rather than raw debugging logs.
- A verified implementation does not automatically mean the scientific hypothesis is supported; distinguish deterministic correctness, real-Agent observations and unvalidated claims.

## 4. Design synchronization and closeout

The GitHub Issue remains the human review surface. When a design-changing PR is accepted for merge, bring its accepted contract and behavior into [Architecture](../architecture/INDEX.md); ordinary internal refactors that do not change architecture need no unnecessary rewrite. At Issue closeout, check STATUS, architecture, relevant ADRs and links for consistency.

Do not merge PRs, close or change Issues, or start external paid runs without authorization. Do not maintain obsolete docs in `archive/`; Git history provides historical versions.
