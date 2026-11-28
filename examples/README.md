# Examples and Service integrations

The five collaboration examples demonstrate different policies built on the
public `@luna-shi/murm` Runtime, Sandbox and Service APIs. Choose one mechanism,
prepare its listed dependencies, and give it a **project directory and prompt**.
A Task/Mission database, Board, chat service or Git workflow belongs to the
example that uses it.

Start with the [first SDK Harness](../docs/en/first-harness.md) for one real
Publisher and Writer, their Service handoff, a user answer and verified
artifact export. Its same default definition is used by SDK, foreground and
RPC. [HarnessSession clients](harness-session/README.md) exercise the public
protocol with a zero-Runtime fixture.

## Choose a collaboration example

| Directory | Coordination | Services created by the example | Facilities you supply |
| --- | --- | --- | --- |
| [subagents](subagents/README.md) | A root delegates to children and integrates their replies. | In-process collaboration Service. | OpenSandbox, Worker image and model endpoint. |
| [taskpool](taskpool/README.md) | Agents discover and exclusively claim Tasks against a Mission Workspace. | Task/Context stores and Workspace coordination in the run directory. | Common infrastructure; optional checker/search dependencies only when explicitly configured. |
| [peermesh](peermesh/README.md) | Peers coordinate through Board, chat and Git. | Per-run identities, repository/channel, Board process and Service adapters. | Gitea, Mattermost, pinned Board source/Python dependencies and initialized MySQL. |
| [lead-worker](lead-worker/README.md) | A Lead assigns work and integrates Worker output. | SQLite Board, scoped Git identities and adapters; optional dynamic checker service. | Gitea; Docker checker image for dynamic mode. |
| [substrate](substrate/README.md) | Peers publish, retrieve and cite contributions. | SQLite publication Service. | Common infrastructure. The explicit FATE benchmark also needs Lean/Mathlib/checker dependencies. |

PeerMesh and Lead-Worker require an enforced network allowlist for native Git.
Use an OpenSandbox deployment configured for `dns+nft`, and verify that the
Workers can reach the configured Git origin under its platform policy. See the
[deployment requirements](../docs/architecture/16-pi-opensandbox-backend.md).

## Run an example from its directory

Prepare a matching Worker, OpenSandbox connection and model route using
[Quickstart](../docs/en/quickstart.md). The source candidate provides the
Harness author API used by these examples. Pack it once from the checkout root:

```sh
npm ci --ignore-scripts
npm pack
export MURM_ARCHIVE="$PWD/luna-shi-murm-0.2.0.tgz"
```

Each example directory can be copied on its own. Install the exact archive and
build the example from its own directory:

```sh
cd examples/subagents
npm install --no-save "$MURM_ARCHIVE"
npm run check
npm run build
npm run start -- --cwd /absolute/path/to/project --prompt 'Implement and verify the requested change'
```

Use the example's README for its configuration and external facilities.
Run `murm --harness /absolute/path/to/example/dist/project.js --prompt '…'` from
the input project to use the same editable example from elsewhere. The candidate
CLI also includes each example's built-in name as a convenience. The host
captures the initial directory and writes outputs outside it by default.
Use `--config` for trusted JavaScript run configuration.

The model, executor and Sandbox environment variables are documented in
[Quickstart](../docs/en/quickstart.md). Existing scoped variables remain
fallbacks. Separate benchmarks take explicit configuration and fixtures.
See [FATE](../benchmarks/fate/README.md) and [Lead–Worker Orders](../benchmarks/lead-worker-orders/README.md).

## Smaller SDK tutorials

- [Notes](notes/README.md) demonstrates a minimal custom Service and an independently verified writer/reader host.
- [Messages](messages/README.md) demonstrates a two-Agent handoff through an
  in-process or existing HTTP Service, followed by independent file verification.
- The [GitHub issues adapter](services/github-issues/README.md) demonstrates host-side invocation of a restricted
  external CLI. It is an optional integration, not infrastructure required by
  every example.
- [Mathlib search](services/mathlib-search/README.md) is an optional domain Service used by the TaskPool and FATE
  integrations. It is unrelated to the MySQL database used by PeerMesh's Board.

## Repository boundaries

Each project owns its collaboration and Services. Its TypeScript imports the
package root and uses a local ESM project entry. The CLI built-in aliases load
the bundled copies of those same entries. See the [Harness author contract](../docs/architecture/23-project-harness.md#authoring-an-example)
and the [repository migration](../docs/designs/repository-layout.md).
