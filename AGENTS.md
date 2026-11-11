# SwarmEnv — Coding Agent Instructions

These instructions apply to **Coding Agents developing SwarmEnv**, not research Agents running within it. They define human/Agent authority and project-specific constraints. The installed **Matt Pocock engineering skills** define the default engineering workflow.

## Sources of authority

1. **Human-approved GitHub Issue or accepted Agent Brief:** what matters, what to build, observable outcomes, acceptance criteria, constraints and non-goals. Read the full Issue, linked tickets, comments and later human decisions. A draft or `ready-for-agent` label alone does not authorize a new research hypothesis or unapproved spending.
2. **Accepted Architecture and ADRs:** the existing system baseline and durable decisions. An approved Issue can change the baseline within its explicit scope; an unreviewed code path or local note cannot.
3. **Matt engineering skills:** authoritative procedures for specification, ticket planning, implementation, testing, review and PR preparation **when installed**. Follow the skills rather than reproducing their steps or creating a parallel workflow.
4. **Current source and tests:** code and schemas show what runs; tests and experiments show what has been verified. [STATUS.md](docs/STATUS.md) tracks evidence, not new requirements.

Start at [docs/INDEX.md](docs/INDEX.md), read the relevant [Architecture](docs/architecture/INDEX.md) and [GLOSSARY.md](GLOSSARY.md), then inspect the affected source and tests. Do not load all project documents by default.

## Human decisions and Agent autonomy

Humans judge the **value and priority of research hypotheses**, approve the Issue's intended behavior, acceptance criteria and experimental/resource boundaries. An Agent may suggest a new hypothesis and support it with evidence, but must not select and run that new research direction without approval.

Within the approved Issue and resource limits, Coding Agents may design implementation details, edit code, test, diagnose, fix and retest independently. **Do not ask for approval or send a separate human report after every implementation test or debug probe.** Use an isolated branch/worktree, not `main`.

Escalate any material change to the research hypothesis, requirements, acceptance criteria, architecture scope, benchmark/checker/fixture, provider/model or budget. A task or local technical note cannot silently expand the Issue. Paid or external-resource probes require explicit permission or a pre-approved allowance.

## Matt engineering workflow

Use the **installed** skills when applicable; do not claim to have invoked an unavailable skill.

- **`/to-spec`** publishes the spec in GitHub Issues, using the domain glossary and applicable ADRs. Do not duplicate that spec in `docs/phases/`.
- **`/to-tickets`** is optional for large work: propose complete vertical slices and blocking edges, obtain human agreement, then publish GitHub sub-Issues/dependencies. A single umbrella Issue with several commits/PRs is also valid.
- **`/implement`** works an Issue or ticket, using **`/tdd`** at agreed public seams, and finishing with **`/code-review`**.
- **`/implement-spec`** executes a ticket dependency graph on an integration branch with separate implementer branches/worktrees where supported. GitHub owns ticket state; do not replicate its task graph locally.
- **`/diagnosing-bugs`** supports disciplined reproduction and regression testing. **`/code-review`** checks **Spec** (against the originating Issue/accepted Agent Brief) separately from **Standards** (repo conventions and code quality).
- **`/pr`** summarizes the change, before/after evidence, and Merge Danger (door and blast radius).

Explicitly invoking a skill authorizes its normal agreed tracker/branch actions within the user's request, **not** a new research direction, altered experiment budget, or unrelated merge. Do not merge PRs or close unrelated Issues without authorization.

## Project-specific verification and closeout

- Pin the implementation commit; verify the complete affected flow when needed: Agent prompt/capability, Bridge/SDK, domain services, Runtime/runner, tests and reports. Preserve identity, fencing, idempotency, checker integrity, privacy and cleanup boundaries.
- Run focused tests and, for code changes when available, `npm test` and `git diff --check`. Report checks not run; a passing test cannot substitute for an approved contract.
- Formal experiments follow [the experiment workflow](docs/workflows/experiment.md) and use [experiment-analysis](.codex/skills/experiment-analysis/SKILL.md). Ordinary in-scope tests and bounded diagnostic probes do not require formal EXP IDs or per-probe reports.
- At meaningful milestones, update [STATUS](docs/STATUS.md) with Issue/PR/commit links and evidence. When design changes are accepted for merge, synchronize the affected [Architecture](docs/architecture/INDEX.md); verify alignment at Issue closeout.
- Report **Results**, **Analysis** and **Next steps**. Distinguish observed facts, alternative explanations and human decisions. Counts of Tasks, Materials, Judge calls or busy Cores do not independently prove useful collaboration.
- Keep raw Agent conversations, proof/candidate source, credentials, stdout/stderr, private databases and personal paths out of committed reports. Keep raw evidence in ignored local `experiments/`.
- Do not recreate `archive/` folders, obsolete redirects or `CONTEXT.md`; recover obsolete docs from pinned Git history.

## Agent skills

### Issue tracker
GitHub Issues and sub-Issues are the spec/ticket source. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels
See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs
Single-context repository: root [GLOSSARY.md](GLOSSARY.md) and [docs/adr/](docs/adr/INDEX.md). See [docs/agents/domain.md](docs/agents/domain.md).
