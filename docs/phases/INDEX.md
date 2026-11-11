# Issue-linked implementation notes

> Type: Optional Coding Agent working context · Status: Active · Compatible with [Matt Pocock's engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering)

**The GitHub Issue is the spec and the human-facing review surface.** For an Issue created by `/to-spec`, the Issue body contains the Problem Statement, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope, and further notes. An accepted `/triage` Agent Brief in the Issue comments may provide a more focused execution contract. Read the full Issue and its comments; prefer explicit, later human-approved decisions over superseded text.

There is **no second mandatory Phase Charter or local Implementation Spec**. The `docs/phases/` directory is only for optional **Issue-numbered implementation notes** that help Coding Agents preserve code-level decisions across sessions, subagents, or several PRs. Such notes are not another source of product requirements, do not require separate approval, and must not copy the Issue body.

## Follow the installed engineering skills

| Work | Preferred skill | Durable source |
|---|---|---|
| Turn discussion into an approved specification | `/to-spec` | GitHub spec Issue |
| Break a large spec into complete, dependent slices (if useful) | `/to-tickets` | GitHub sub-Issues and blocking edges |
| Implement one Issue or one slice | `/implement` | Source branch, tests, PR |
| Implement a ticket graph | `/implement-spec` | Integration branch, ticket branches/worktrees and Issue graph |
| Test and debug | `/tdd`, `/diagnosing-bugs` | Tests at agreed public seams and reproducible evidence |
| Review and publish | `/code-review`, `/pr` | Spec/Standards findings, before/after evidence and merge risk |

Use the names and behavior of the **installed** skills; this file is a navigation adapter, not a replacement implementation of those skills. A `ready-for-agent` label indicates a work item is prepared for implementation, but does not by itself authorize a paid experiment or new research hypothesis.

## Two valid implementation shapes

- **One umbrella Issue, several commits or PRs:** Keep the Issue's overall acceptance contract and collect milestones in its discussion, as in [Issue #111](https://github.com/LuNa-shi/SwarmEnv/issues/111). No ticket split is required.
- **One spec Issue, multiple dependent tickets:** When `/to-tickets` is appropriate, use vertical, independently verifiable slices with explicit blocking edges. `/implement-spec` consumes that graph and may use a shared integration branch with fresh implementer worktrees. Do not also create an unrelated task graph in local Markdown.

Only create a local file such as `docs/phases/issue-123-implementation-notes.md` when the technical context is too large to recover cheaply from code, commits and the GitHub Issue. Start from [issue-implementation-notes-template.md](issue-implementation-notes-template.md). For small Issues, omit it entirely.

## Authority and closeout

- **Issue/approved Agent Brief:** what behavior is wanted, why, its boundaries and acceptance.
- **Local implementation notes:** where the code work is, what implementation decisions were tried, agreed test seams, pointers to tickets/worktrees/commits and open engineering questions.
- **[STATUS](../STATUS.md):** meaningful implementation and evidence milestones across Issues.
- **[Architecture](../architecture/INDEX.md):** accepted design synchronized when design-changing PRs merge and checked at Issue closeout.

If an implementation choice changes the approved behavior or research direction, propose it in the GitHub Issue for human review. Retire no-longer-needed local notes from the working tree when their durable decisions and evidence have been linked; Git preserves the history.
