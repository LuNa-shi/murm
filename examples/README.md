# Examples and Service integrations

The five collaboration examples demonstrate different policies built on the
public `@luna-shi/murm` Runtime, Sandbox and Service APIs. Choose one mechanism,
prepare its listed dependencies, and give it a **project directory and prompt**.
A Task/Mission database, Board, chat service or Git workflow belongs to the
example that uses it.

## Choose a collaboration example

| Directory | Coordination | Services created by the example | Facilities you supply |
| --- | --- | --- | --- |
| [subagents](subagents/README.md) | A root delegates to children and integrates their replies. | In-process collaboration Service. | OpenSandbox, Worker image and model endpoint. |
| [taskpool](taskpool/README.md) | Agents discover and exclusively claim Tasks against a Mission Workspace. | Task/Context stores and Workspace coordination in the run directory. | Common infrastructure; optional checker/search dependencies only when explicitly configured. |
| [peermesh](peermesh/README.md) | Peers coordinate through Board, chat and Git. | Per-run identities, repository/channel, Board process and Service adapters. | Gitea, Mattermost, pinned Board source/Python dependencies and initialized MySQL. |
| [lead-worker](lead-worker/README.md) | A Lead assigns work and integrates Worker output. | SQLite Board, scoped Git identities and adapters; optional dynamic checker service. | Gitea; Docker checker image for dynamic mode. |
| [substrate](substrate/README.md) | Peers publish, retrieve and cite contributions. | SQLite publication Service. | Common infrastructure. The explicit FATE benchmark also needs Lean/Mathlib/checker dependencies. |

PeerMesh and Lead-Worker still select strict local Docker isolation because their
Profiles request an enforced network allowlist for native Git. They need the
[documented strict-host capabilities](../docs/architecture/16-pi-opensandbox-backend.md).
The generic OpenSandbox API Provider does not currently advertise that capability.
The other project examples use the normal API policy unless their supplied
configuration selects another supported policy.

## Run an example from its directory

Install dependencies and build once in the checkout root:

```sh
npm ci --ignore-scripts
npm run build
```

Follow [Quickstart](../docs/en/quickstart.md) to prepare OpenSandbox and the Worker,
then provide a model route. For the default Pi executor:

```sh
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_TOKEN='your-token'
export MURM_MODEL_PROVIDER='openai'
export MURM_MODEL_ID='gpt-5.4'
cd examples/subagents
node ../../dist/scripts/murm.js --harness subagents \
  --cwd /absolute/path/to/project --prompt 'Implement the requested change and verify it'
```

Change the example directory and Harness name together. A consumer with the CLI
installed can run `murm --harness <name> --prompt '...'` directly in its project.
The CLI captures the initial directory and stores run output outside it by
default. A separate workload file is not required. `--config` selects trusted
JavaScript run configuration; it does not replace the project input.

Common model, executor and Sandbox environment variables are described in
[Quickstart](../docs/en/quickstart.md). The examples retain their scoped variables
as fallbacks. Existing benchmark/fixed-task entrypoints have their own explicit
configuration and should not be confused with `murm --harness`.
The three older scoped model endpoint variables keep their historical Kimi K3
defaults when no common model URL is selected; explicit provider/model settings
override those defaults.

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

Concrete collaboration policy and its Services belong beside the example.
The CLI's built-in names are convenience loaders for these modules; they do not
make a mechanism part of the Core SDK. The current checkout builds examples
with the main package. Some project-host and TaskPool domain dependencies are
still repository-internal, so copying just one directory is not yet a supported
standalone package installation. See the [repository cleanup plan](../docs/designs/repository-layout.md) for the
remaining extraction and package verification work.
