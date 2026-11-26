# Development workflow — Matt engineering skills adapter

> Type: Project-specific workflow · Status: Active · Updated: 2026-11-12

The default engineering procedure is defined by the [installed Matt Pocock engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering). This file adds only murm-specific context and verification boundaries. [AGENTS.md](../../AGENTS.md) defines human/Agent autonomy and permissions.

## Phase 0005: design first, Issues track execution

For the Core / Harness stage, the owner’s 2026-11-23 instruction makes the [complete design on main](../phases/0005-core-harness/README.md) the sole authority for target requirements, scope, decisions and acceptance. First merge the documentation through a reviewed PR, then derive the spec Issue and independently verifiable tickets from that exact version. Issues track dependencies, implementation and evidence. If a ticket summary differs from the design, reconcile the ticket; requirement changes go through the authoritative design PR and then update affected tickets. Notion is source material for the migration. This exception does not alter resource/research/publication permissions or declare the proposed API implemented.

## Issue-first development for other stages

- **GitHub Issue is the sole requirements and acceptance source.** Use `/to-spec` to convert a design discussion into a GitHub spec Issue. Read the complete Issue, its comments, accepted Agent Brief and later human decisions.
- **`/to-tickets` is optional.** For large work, propose independently verifiable vertical slices and blocking dependencies for human review, then publish them to GitHub. An umbrella Issue with several PRs is also valid.
- Keep the ticket graph, approvals, progress and cross-session handoff pointers on GitHub Issues/PRs. Substantial stage designs may use numbered [phase documents](../phases/INDEX.md) as versioned Issue attachments, reviewed through a corresponding PR. Link the exact approved revision in the Issue; distinguish confirmed direction, proposed detail, implemented behavior and verified outcomes.
- Review the [accepted Architecture](../architecture/INDEX.md), [GLOSSARY](../../GLOSSARY.md), and relevant ADRs before modifying code. Current source behavior is not independent permission to change approved requirements.

## Implementation and review

Use Node.js 22.19 or newer and install the locked development dependencies with
`npm ci`. Run `npm run typecheck` for the strict source and tooling check and
`npm run build` to refresh the JavaScript and declarations under `dist/`.
`npm test` and `npm run docs:check` build before running. Local host commands run
the compiled entry points under `dist/scripts/`. See
[TypeScript build and installation](../architecture/07-run-configuration.md#typescript-build-and-installation).

- Use `/implement` for one Issue/ticket or `/implement-spec` for a ticket graph. Follow their branch, worktree, integration and review conventions.
- Use `/tdd` at pre-agreed public seams; for tricky defects use `/diagnosing-bugs`. Repeat tests, fixes and authorized diagnostic probes within Issue scope **without reporting after each iteration**.
- Run relevant tests, full suite when available, and `git diff --check`. Run `/code-review` with separate **Spec** and **Standards** findings. Use `/pr` for a concise Summary, before/after Evidence and Merge Danger.
- If a skill is unavailable, report that limitation and follow the applicable documented engineering requirements without claiming the skill ran.

## Required GitHub checks

[CI](../../.github/workflows/ci.yml) runs on PRs targeting `main` and pushes to
`main`. It uses Linux and Node.js 24. A newer push to a PR cancels the previous
run for that PR. The `main` ruleset is configured in GitHub after the checks
pass on Actions. It requires a PR and the `Core CI`, `Trace Viewer CI` and
`Website CI` checks. The owner approves merges.

**Core CI** checks the PR's whitespace, installs locked dependencies, runs
`npm run typecheck` and runs `npm test`, including the architecture check. To
reproduce the cold-cache sequence from the repository root, use a fresh cache
and install the packed Core in a temporary consumer before running tests.

```sh
(
  set -e
  package_dir=$(mktemp -d)
  trap 'rm -rf -- "$package_dir"' EXIT
  export npm_config_cache="$package_dir/npm-cache"
  npm ci --no-audit --no-fund
  npm run typecheck
  npm pack --loglevel=error --pack-destination "$package_dir"
  npm install --prefix "$package_dir/consumer" --prefer-offline --omit=dev --ignore-scripts --no-audit --no-fund "$package_dir"/*.tgz
  npm test
)
```

`npm ci` can fetch the locked tarballs without caching the registry metadata that
an offline installation of the packed Core needs. The temporary consumer seeds
that metadata in the same cache used by the tests. The package tests still
install offline.

**Trace Viewer CI** runs `npm --prefix trace-viewer test`. For **Website CI**,
run `npm ci` inside `website/`, then
`BASE_PATH=/murm SITE_URL=https://luna-shi.github.io npm run build`. The job
checks for both `dist/index.html` and `dist/zh/index.html`. The Pages workflow
deploys the merged site separately.

## Design-stage documentation

For Phase 0005, apply the design-first authority and sequence above. For other stages, create a design Issue plus a documentation PR when the owner requests a new stage. The Issue states the problem, scope, user outcomes, decisions and acceptance. Its phase attachment explains the full target model, workflows, permissions, prompts/skills, failure behavior, verification plan and migration in reviewable chapters. Do not label a design as ready for runtime implementation merely because its documentation has been published.

During design review, keep current Architecture accurate to current code and link the target design. After implementation begins, each runtime PR updates the affected manual and references. Keep pending choices and evidence in the Issue/PR; do not maintain a duplicate local progress ledger. A change to a reviewed requirement must be made visible in the Issue and the document revision together.

## murm verification and synchronization

- Keep exact commit, environment, provider/model, checker and input identities for substantive evidence. Do not silently change the approved Issue, fixtures, acceptance thresholds or experiment budget.
- Use Kimi K3 (`PI_PROVIDER=kimi_proxy`, `PI_MODEL=k3`) by default for real Agent tests during development. When a formal experiment or acceptance run pins a different model, use the approved configuration for that run.
- Formal real-Agent research runs require the approval and registration described in [experiment workflow](experiment.md). Bounded in-scope debug probes and deterministic tests do not need a formal EXP ID.
- **Keep implementation progress and verification evidence in the originating GitHub Issue/PR.** At meaningful milestones, link the exact tested commit, evidence level and result, remaining gaps and next decision. Do not file separate updates after each debugging attempt. At Issue closeout, summarize the accepted behavior and unresolved limitations in the Issue/PR, and reconcile affected Architecture.
- Update the affected [Architecture](../architecture/INDEX.md) in the implementation PR: the owner must be able to understand the changed runtime without reading code. Include full prompt changes, state/contract/default/error effects and code-to-chapter mappings. Run `npm run docs:generate`, review its diff, then `npm run docs:check` and `git diff --check`. At Issue/stage closeout, reconcile the complete flow with the final merged revision and evidence; regeneration alone does not establish semantic accuracy.
- Do not merge, close unrelated Issues, or run unapproved paid experiments without explicit user permission. Retire obsolete documentation through Git history, not an `archive/` directory.

