---
title: Choose a Harness
description: Compare the five built-in multi-agent patterns in murm, run them with one command, or adapt them to build your own team.
section: BUILT-IN HARNESSES
order: 10
---

A **Harness** defines how a multi-agent team divides work, shares information, and decides when the job is done.

`murm` ships **five complete multi-agent patterns** (`Subagents`, `TaskPool`, `PeerMesh`, `Substrate`, and `Lead-Worker`), plus two minimal starters (`notes` and `messages`). All of them share the exact same Sandboxes, Host Gateway, and Trace Viewer — only their Services and orchestration rules differ.

> **How to use them**: run any built-in directly via `murm --harness <name>`, or inspect `examples/` and `src/harnesses/` to adapt them. To build your own from scratch, see [Build a Swarm Harness](../build-your-harness.md).

## Run in one command

Once [Quickstart](../quickstart.md) is done, launch against any project folder:

```bash
cd my-project
murm --harness subagents --prompt "Fix the parser and add tests"
```

Built-in names: `subagents`, `taskpool`, `peermesh`, `substrate`, `lead-worker`, `notes`, `messages`. (`subagents`, `taskpool`, `notes`, and `messages` only need your model environment variables; `peermesh`, `substrate`, and `lead-worker` also use external facilities such as Gitea or Mattermost.)

## Five collaboration patterns at a glance

| Harness | How the team collaborates | Shared Services | Final output |
| --- | --- | --- | --- |
| **[Subagents](subagents.md)** | **Hierarchical delegation**: `/root` splits goals, spawns child Agents on demand, exchanges mailbox messages, and integrates results | Member tree & mailbox (`collaboration`) | Integrated final reply and collected files |
| **[TaskPool](taskpool.md)** | **Competitive task queue**: workers start read-only, claim exclusive timed tasks to unlock writes, and rotate cleanly on finish or timeout | Task queue (`task`), shared notes (`context`), versioned workspace (`workspace`), optional `judge` | Published findings and merged workspace revisions |
| **[PeerMesh](peermesh.md)** | **Flat engineering team**: no central manager — peers declare what they're working on without locks, coordinate in chat, and open personal-branch PRs verified by the host | Shared board, team chat/DMs (Mattermost), and Git (Gitea) | Host-verified `main` branch and per-peer Git archives |
| **[Substrate](substrate.md)** | **Shared citation store**: no queues or DMs — equal peers explore in parallel, publish immutable findings to SQLite, and build on each other via explicit citations | Append-only SQLite store (`publish` / `search` / `visit`) | Findings, citation graph, and files (plus optional Lean proof checks) |
| **[Lead-Worker](lead-worker.md)** | **Directed feedback loop**: one Lead sets direction while workers claim subtasks and ship Git commits; the board enforces reading feedback before new directions and reading directions before delivery | Transactional SQLite board + Git (Gitea) | Byte-verified Git deliveries and feedback records |

## What happens when two Agents want the same work?

- **TaskPool**: **Strictly exclusive**. Only the winning Agent unlocks file writes and continues using the model; others stay read-only and pick another task.
- **PeerMesh**: **Advisory board, negotiated in chat**. Multiple peers can register overlapping areas without locking and coordinate via channels or DMs.
- **Lead-Worker**: **First-come permanent claim**. A SQLite transaction locks one permanent owner per subtask with no timeout or reassignment.
- **Substrate**: **No claims at all**. Peers explore freely and cite earlier findings to build cumulative progress.
- **Subagents**: **Split by the parent**. The parent divides responsibilities and guides or interrupts children directly.

## Designing your own MAS from requirements

When none of the five built-in templates fits your task verbatim, work backward from four concrete design choices:

| Design decision | What your task needs | Recommended pattern |
| --- | --- | --- |
| **1. Shared state & Services** | Lightweight local experiments / transactional history & citation queries / existing Python, Go, or verifier services | Plain TS class (`createInProcessAdapter`) / host SQLite Service / external HTTP Service (`createHttpJsonAdapter`) |
| **2. Communication style** | Open-ended knowledge sharing / explicit parent-child handoffs / urgent mid-turn course corrections | Shared blackboard or citation store / directed mailbox turns / `send({ mode: 'steer', wakeIfIdle: false })` so idle agents aren't woken unnecessarily |
| **3. Division of labor & conflicts** | Strict single-writer edits / flat peer negotiation / open parallel exploration | Read-only start + timed exclusive lease + `files.replace({ writable: true })` / personal Git branches + PR verification / unrestricted exploration + explicit citations |
| **4. Control loop & verification** | No hung waits, no empty deliveries, no leaked containers | Always bound turns with a timeout and fail fast on `error` / unexpected `exit`; verify `settled.outcome === 'completed'`, **independent business deliverables**, and **`receipt.cleanup === 'complete'`** separately |

> **Ready to build one?** See **[Build a Swarm Harness](../build-your-harness.md)** for a complete, verified multi-agent Research Swarm implementing all four principles.
