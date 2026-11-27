# Development workflow — Matt engineering skills adapter

> Project-specific workflow · Updated: 2026-11-26

The default engineering procedure is defined by the [installed Matt Pocock engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering). This file adds only murm-specific context and verification boundaries. [AGENTS.md](../../AGENTS.md) defines human/Agent autonomy and permissions.

## Current baseline and intended changes

Read the [architecture manual](../architecture/INDEX.md), [SDK guide](../en/sdk.md) and [GLOSSARY](../../GLOSSARY.md) for the current implementation. The [Phase 0005 Core / Harness design on main](../designs/core-harness/README.md) governs target requirements and acceptance for that stage. Review changes to that design before synchronizing affected Issues. In other stages, human-approved Issues define intended changes and acceptance. Read the relevant Issue's full discussion and linked design before implementing it.

Keep approvals, dependencies, progress and evidence on the Issue/PR. A large change may use a reviewed design in `docs/designs/`, with its exact revision linked from the Issue. Mark future behavior explicitly. Once implemented, reconcile the behavior into Architecture and retire superseded requirements through Git history.

Use `/to-spec` and optional `/to-tickets` when those installed skills fit the requested workflow. One Issue with multiple implementation PRs is also valid. The [pending dynamic Lead-Worker design](../designs/dynamic-lead-worker.md) illustrates the boundary between a reviewed target and current SDK behavior.

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

## Repository CI checks

[CI](../../.github/workflows/ci.yml) runs on PRs targeting `main` and pushes to
`main`. It uses Linux and Node.js 24. A newer push to a PR cancels the previous
run for that PR. Its jobs are `Core CI`, `Trace Viewer CI` and `Website CI`. Branch protection
is configured separately in GitHub; the workflow itself does not establish
those settings. The owner approves merges.

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

Trace Viewer tests run inside **Core CI** via `npm test`. For **Website CI**,
run `npm ci` inside `website/`, then
`BASE_PATH=/murm SITE_URL=https://luna-shi.github.io npm run build`. The job
checks for both `dist/index.html` and `dist/zh/index.html`. The Pages workflow
deploys the merged site separately.

## Documentation changes

The website renders `docs/en/` and `docs/zh/` directly. Write relative Markdown file links so a guide works in GitHub; the site's Markdown transform converts them to routes at build time. Update both locales, navigation and any affected example README when changing a public entry point.

Keep the current architecture explanation beside its implementation. The SDK guide introduces a runnable workflow; API pages describe public exports; architecture chapters explain ownership, call order, state, failures and cleanup. Source links support these explanations. Avoid importing an internal helper in an example advertised as an installed SDK consumer.

## murm verification and synchronization

- Keep exact commit, environment, provider/model, checker and input identities for substantive evidence. Do not silently change the approved Issue, fixtures, acceptance thresholds or experiment budget.
- Use Kimi K3 (`PI_PROVIDER=kimi_proxy`, `PI_MODEL=k3`) by default for real Agent tests during development. When a formal experiment or acceptance run pins a different model, use the approved configuration for that run.
- Formal real-Agent research runs require the approval and registration described in [experiment workflow](experiment.md). Bounded in-scope debug probes and deterministic tests do not need a formal EXP ID.
- **Keep implementation progress and verification evidence in the originating GitHub Issue/PR.** At meaningful milestones, link the exact tested commit, evidence level and result, remaining gaps and next decision. Do not file separate updates after each debugging attempt. At Issue closeout, summarize the accepted behavior and unresolved limitations in the Issue/PR, and reconcile affected Architecture.
- Update the affected [Architecture](../architecture/INDEX.md) in the implementation PR: the owner must be able to understand the changed runtime without reading code. Include full prompt changes, state/contract/default/error effects and code-to-chapter mappings. Run `npm run docs:generate`, review its diff, then `npm run docs:check` and `git diff --check`. At Issue/stage closeout, reconcile the complete flow with the final merged revision and evidence; regeneration alone does not establish semantic accuracy.
- Do not merge, close unrelated Issues, or run unapproved paid experiments without explicit user permission. Retire obsolete documentation through Git history, not an `archive/` directory.

