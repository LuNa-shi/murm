# Issue tracker: GitHub

> Configuration for Matt Pocock's engineering skills · Active

**Issues and specs live in the murm GitHub repository:** [LuNa-shi/murm](https://github.com/LuNa-shi/murm). Use an authorized GitHub integration or `gh` CLI. Never publish a murm Issue into the upstream `mattpocock/skills` repository.

## Reading and writing

- The [Phase 0005 Core / Harness design on main](../designs/core-harness/README.md) is the authority for this stage. Derived Issues cite the exact design revision and track implementation and evidence. Update the design through review before synchronizing affected Issues.
- Read an Issue's **body, comments, labels, and linked tickets** before starting. Outside Phase 0005, the `/to-spec` Issue body is the spec; when `/triage` provides an accepted **Agent Brief** comment, use that brief and any later approved updates as the execution contract.
- `/to-spec` publishes a spec Issue, generally using the `ready-for-agent` label. Publishing an Issue or adding that label describes readiness; a human instruction or approval is still required before **executing a new research hypothesis** or spending unapproved resources.
- `/to-tickets` publishes complete vertical-slice GitHub Issues only after its proposed split and blocking relationships have been reviewed. Prefer GitHub sub-Issues and native blocked-by relationships; when unavailable, use explicit `Parent: #N` and `Blocked by: #N` links.
- A one-Issue implementation with multiple PRs is also valid; do not force `/to-tickets`.
- A design Issue may link an active design under `docs/designs/` and a documentation PR. Treat the explicitly approved revision as part of that Issue's contract. A review draft is not an implementation assignment; preserve pending decisions and report acceptance/progress on GitHub.
- An explicit user request to use `/implement-spec` may authorize the ticket and branch state changes defined by that skill. Outside such authorization, do not merge PRs, close Issues, or change their labels/state unilaterally.

## GitHub CLI references

```sh
gh repo view --json nameWithOwner
gh issue view <number> --json number,title,body,labels,comments
gh issue list --state open --label ready-for-agent
gh issue create --title "..." --body-file /path/to/spec.md
gh issue comment <number> --body-file /path/to/comment.md
```

For native sub-Issues and blocking edges, use the operations supported by the installed `gh` version. Always check the target repository before publishing.

## Roles and repository conventions

**PRs as a request surface: no.** PRs are implementation/review artifacts; triage of new work starts from Issues unless the user explicitly asks to review a particular PR.

The canonical triage-state mapping lives in [triage-labels.md](triage-labels.md). Domain vocabulary and decisions are configured in [domain.md](domain.md). For multi-PR Issues, report implementation progress and verification links in the Issue comments; do not close the parent merely because a partial PR merged.

