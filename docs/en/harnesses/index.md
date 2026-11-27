---
title: Choose a Harness
description: Compare the five collaboration mechanisms implemented in murm and find their SDK and example entry points.
section: HARNESSES
order: 6
---

## Run an ordinary project

Install the CLI and prepare the host by following [Quickstart](../quickstart.md), then launch from your project directory. The invocation directory is the default; use `--cwd` to select another project. Supply model and runtime settings via environment variables (`MURM_MODEL_URL`, `MURM_MODEL_TOKEN`, etc.) or `--config`.

```sh
cd my-project
murm --harness subagents --prompt "Fix the parser and add tests"
```

Built-in names are `subagents`, `taskpool`, `peermesh`, `substrate`, `lead-worker`, `notes` and `messages`. Configure the resources required by the selected example.

A Harness supplies the collaboration policy around a murm Runtime: which Agents to start, which Services they can call, how shared work is represented, and when the run is complete. The repository implements five different policies. They reuse Core lifecycle, isolation, input delivery and observation while keeping their coordination rules in host code and Services.

Start with the [SDK guide](../sdk.md) to embed murm in your own application. The Harnesses below are editable repository implementations and examples; their factory functions are not additional `@luna-shi/murm` package exports. TaskPool also composes the repository's existing Mission, Task, Material and Workspace stores. The other four have dedicated example launchers.

## Compare the mechanisms

| Harness | Shared state and Services | How work moves | Result |
| --- | --- | --- | --- |
| [Subagents](subagents.md) | A `collaboration` Service with named members and mailboxes | Root delegates recursively; members send notices, resume children and return results to their parent | Root's integrated response and any configured collected files |
| [TaskPool](taskpool.md) | `task`, `context` for Materials, `workspace`, optional `judge`, `mission` and `mathlib-search` | Agents choose Tasks; exclusive leases authorize one Execution; the host replaces finished or expired workers | Published Materials and saved or merged Workspace revisions |
| [PeerMesh](peermesh.md) | A soft-claim Board, Mattermost messages and Gitea | Equal peers choose branches and coordinate in chat; routers deliver events and host-verified merges update `main` | A pinned shared `main` archive, merge receipts and each peer's private archive |
| [Substrate](substrate.md) | An immutable SQLite publication store with `publish`, `search` and `visit` | Equal peers explore in parallel and explicitly cite work they use | Publications, references, read records and private work; FATE configurations add Lean checks |
| [Lead-Worker](lead-worker.md) | A SQLite `board` with role permissions, ownership and feedback, plus Gitea | A fixed team alternates lead direction and concurrent worker delivery | Verified branch files and evidence that workers read the revised direction |

## What changes when two Agents want the same work?

This question exposes the policy implemented by each Harness:

- **TaskPool** admits one owner through a lease and `fencing_version`. The winning Execution receives write access and a work-phase model permit. Unbound Agents retain only their bounded discovery permissions.
- **PeerMesh** allows overlapping `CLAIM` notes. Peers resolve overlap through the Board, channel messages and DMs.
- **Lead-Worker** records one permanent owner with transactional revision checks. The example does not expire or reassign that claim.
- **Substrate** has no claim operation. Peers may explore the same question and exchange evidence through publications and citations.
- **Subagents** lets a parent divide responsibilities and redirect members through messages or interrupts. Delegation itself does not lock files or prevent overlapping work.

These policies belong to the Harness and its Services. Core provides the same Agent lifecycle and enforces the configured permissions in each case.

## Find the runnable entry point

| Start here when you want to… | Entry point |
| --- | --- |
| Learn the SDK with two Agents and a small Service | [Messages handoff](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/README.md) |
| Delegate a task and keep talking to Root | [Subagents example](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md), one-shot or interactive |
| Run a leased task pool over existing domain stores | [TaskPool host composition](taskpool.md#running-taskpool) |
| Run a peer engineering project with chat and Git | [PeerMesh example](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/README.md), foreground JSON-line commands |
| Explore a question or run a FATE configuration | [Substrate example](https://github.com/LuNa-shi/murm/blob/main/examples/substrate/README.md) |
| Run the fixed direction-and-feedback workflow | [Lead-Worker example](https://github.com/LuNa-shi/murm/blob/main/examples/lead-worker/README.md) |

The supplied configurations have different team sizes, deadlines, dependencies and completion checks. Read the selected example's prerequisites before launching. To define another policy, follow [Build your own Harness](../build-your-harness.md).
