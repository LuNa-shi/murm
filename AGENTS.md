# SwarmEnv — Coding Agent Instructions

This file guides **Coding Agents developing the SwarmEnv repository**. It is not the system prompt for the research Agents running inside SwarmEnv, and it is not the runtime architecture specification.

## Start with the task

- Confirm the user-approved scope, completion conditions, constraints and whether a current research phase has been approved. Do not infer permission to change direction from historical Issues or experiments.
- For context, start at [docs/INDEX.md](docs/INDEX.md). Read the relevant parts of [architecture](docs/architecture/INDEX.md) and the affected source/tests, not every document by default.
- Resolve terminology through [GLOSSARY.md](GLOSSARY.md). New domain names, architecture labels or report section labels require explicit human confirmation before being standardized.
- Source code and versioned tool schemas describe what currently executes. [docs/STATUS.md](docs/STATUS.md) records what has evidence; an ADR records a decision, not a passing test.

## Implement within the approved boundary

1. Record the clean implementation commit, affected behavior, counterexample and expected observable outcome.
2. Develop on an isolated worktree/branch; do not work directly on `main`. A PR must deliver a testable behavior slice, not an unsupported partial contract.
3. Inspect the full affected path (Agent prompt/capability → Bridge/SDK → domain services → Runtime/runner → tests/report) where relevant. Add or update regression tests, including authorization, retries/idempotency, fencing and failure cleanup as needed.
4. Run relevant tests and, for code changes where available, `npm test` and `git diff --check`. Record exactly what ran; do not assert a check passed when it was not run.
5. Review both **Spec** (correct behavior, limits, counterexamples) and **Standards** (quality, security, compatibility and testing); report changed files, commit, findings and unresolved risks.

Detailed process: [docs/workflows/development.md](docs/workflows/development.md).

## Experiments and research progress

- Use the human-approved [phase scope](docs/phases/INDEX.md); the Phase/Experiment workflow manages **development of SwarmEnv**, not the Mission/Task of a running Agent.
- Before starting a run, register an Experiment ID, baseline/variant, exact code/fixture/provider/model/prompt/tool schemas, time/resource budget, primary observation, comparison and stop rule.
- Run only an **authorized** experiment. No unilateral paid run, changed model/provider, fixture/checker, acceptance rule, resource budget or research hypothesis.
- Keep raw traces and private state in ignored local `experiments/`. Use [experiment-analysis](.codex/skills/experiment-analysis/SKILL.md) for evidence reconstruction and [docs/workflows/experiment.md](docs/workflows/experiment.md) for the reporting/decision procedure.
- Separate **Overview** (facts) from **分析判断** (interpretation) and **下一步建议/人类决定**. Missing evidence is unknown, not zero. Task/Material activity, Core utilization and local Judge results do not independently demonstrate useful collaboration or Mission success.
- A contract bug can be fixed within approved scope. A new hypothesis, broader architecture, input change, or conflicting acceptance requirement goes back to the human owner.

## Repository boundaries and documentation

- Preserve original problem/checker semantics, execution identities, per-Execution private Workspaces, source versions and credentials. Do not alter saved experiment facts to fit a new design.
- Do not publish raw Agent dialogue, proof/candidate source, stdout/stderr, private database files, authorization tokens or personal paths.
- Current docs live under `docs/INDEX.md`. No new `archive/` directories or historical redirect stubs: recover obsolete docs by their Git commit. Documentation changes must update inbound links, skills and source references where appropriate.
- Do not merge PRs, change Issue state or initiate paid experiments unless explicitly authorized for the current task. For a docs-only PR, validate docs/links and scope; do not imply new runtime acceptance.

If a task cannot be completed, explain precisely what was done, what remains unknown and what decision is needed. Do not quietly substitute old design intentions for current code.
