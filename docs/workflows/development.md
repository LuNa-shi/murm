# Development workflow — Matt engineering skills adapter

> Type: Project-specific workflow · Status: Active · Updated: 2026-11-11

The default engineering procedure is defined by the [installed Matt Pocock engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering). This file adds only SwarmEnv-specific context and verification boundaries. [AGENTS.md](../../AGENTS.md) defines human/Agent autonomy and permissions.

## Issue-first development

- **GitHub Issue is the sole requirements and acceptance source.** Use `/to-spec` to convert a design discussion into a GitHub spec Issue. Read the complete Issue, its comments, accepted Agent Brief and later human decisions.
- **`/to-tickets` is optional.** For large work, propose independently verifiable vertical slices and blocking dependencies for human review, then publish them to GitHub. An umbrella Issue with several PRs is also valid.
- The full ticket graph, implementation plans, technical decisions and cross-session handoff pointers belong on GitHub Issues/PRs (with exact commits when helpful), **not in a local `docs/phases/` or Implementation Spec**.
- Review the [accepted Architecture](../architecture/INDEX.md), [GLOSSARY](../../GLOSSARY.md), and relevant ADRs before modifying code. Current source behavior is not independent permission to change approved requirements.

## Implementation and review

- Use `/implement` for one Issue/ticket or `/implement-spec` for a ticket graph. Follow their branch, worktree, integration and review conventions.
- Use `/tdd` at pre-agreed public seams; for tricky defects use `/diagnosing-bugs`. Repeat tests, fixes and authorized diagnostic probes within Issue scope **without reporting after each iteration**.
- Run relevant tests, full suite when available, and `git diff --check`. Run `/code-review` with separate **Spec** and **Standards** findings. Use `/pr` for a concise Summary, before/after Evidence and Merge Danger.
- If a skill is unavailable, report that limitation and follow the applicable documented engineering requirements without claiming the skill ran.

## SwarmEnv verification and synchronization

- Keep exact commit, environment, provider/model, checker and input identities for substantive evidence. Do not silently change the approved Issue, fixtures, acceptance thresholds or experiment budget.
- Formal real-Agent research runs require the approval and registration described in [experiment workflow](experiment.md). Bounded in-scope debug probes and deterministic tests do not need a formal EXP ID.
- **Maintain [STATUS](../STATUS.md) in the relevant PR** whenever meaningful implementation, blocker, regression, or verification evidence changes. Record the Issue, exact tested commit, evidence level, conclusion, and remaining gap; mark unmerged work pending. Do not update after every test or duplicate Issue specifications. At Issue closeout consolidate the accepted state. See [AGENTS.md](../../AGENTS.md) for the maintenance triggers.
- Synchronize changed [Architecture](../architecture/INDEX.md) when a design-changing PR is accepted, and check accepted behavior and evidence at Issue closeout.
- Do not merge, close unrelated Issues, or run unapproved paid experiments without explicit user permission. Retire obsolete documentation through Git history, not an `archive/` directory.
