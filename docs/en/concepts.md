---
title: Core Concepts
description: A 2-minute tour of the six building blocks in murm and how a multi-agent run flows from start to finish.
section: GET STARTED
order: 2
---

Every multi-agent system built on `murm` combines the **six building blocks** shown above around your own **Harness** application.

## The six building blocks

| Building block | What it does in one sentence | Deep dive |
| --- | --- | --- |
| **Sandbox** | Runs each Agent in an isolated OpenSandbox container with its own private workspace and resource limits. | [Sandboxes](sandbox.md) |
| **Runtime** | The live control plane (`createRuntime()`) for one run: manages Agents, syncs files, streams events, and cleans up safely. | [Runtime](runtime.md) |
| **Agent & Profile** | A **Profile** defines a role (prompt, model, image, permissions); an **Agent** is a persistent session created from it that keeps context across turns. | [Agents & Profiles](agents.md) |
| **Host Gateway** | The single trusted boundary outside containers: keeps model API keys on the host and checks caller identity, permissions, and schemas on every Service call. | [Host Gateway](gateway.md) |
| **Services** | Shared host capabilities — blackboards, task pools, Git, or verifiers. Agent A writes through a Service, Agent B reads it, enabling cross-sandbox collaboration. | [Services & Permissions](services.md) |
| **Trace Viewer** | Records every model call, tool action, Service handoff, and exported file; launch `murm trace` to scrub and zoom the timeline in your browser. | [Trace Viewer](trace-viewer.md) |

Your **Harness** is simply the host-side program you write: it defines the Profiles, registers the Services, schedules when Agents act, and decides when the job is done.

A module can expose the same **Harness** to the SDK, foreground CLI and RPC. The caller manages one Run through **HarnessSession**. Your Harness uses one or more **Runtimes** if its work needs Agents. Each Runtime manages its own Agents, permissions and resources. [Build the first SDK Harness](first-harness.md).

## What happens during a typical run

1. **Set up the stage**: Your Harness defines Sandbox limits, role Profiles, and shared Services (such as a shared findings board), then calls `createRuntime()`.
2. **Spawn agents and assign work**: Call `runtime.spawn()` to boot isolated Agents and `runtime.send()` to give them tasks. Agents start idle and never spend tokens until you send input.
3. **Collaborate across sandboxes**: Each Agent works locally inside its own container using file and shell tools. Whenever it wants to share findings or message peers, it runs the `swarm` CLI — Host Gateway verifies its identity and permissions, executes the Service, and returns the result.
4. **Observe, verify, and close cleanly**: Your Harness watches progress via `runtime.onEvent()`, triggers follow-ups if needed, and calls `runtime.close()` when done. Runtime archives every session, trace, and artifact before deleting containers, ready to inspect in `murm trace`.

---

**Next:** walk through each building block in order, starting with **[Sandboxes](sandbox.md)**.
