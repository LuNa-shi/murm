# murm glossary

These terms describe the current implementation. Read [How murm works](docs/en/concepts.md) for the relationships and the [implementation manual](docs/architecture/INDEX.md) for exact behavior. TaskPool terms apply to that Harness and its domain Services; they are not prerequisites for using the Core SDK.

## Core and SDK

| Term | Meaning |
| --- | --- |
| **Harness** | The host application that composes Profiles, Services and a collaboration policy. It chooses when to create Agents, route work, check results and finish. |
| **Core** | The reusable library exposed through the `@murm/core` package. Its primary public entries cover Runtime, Services and the OpenSandbox backend. |
| **Runtime** | One live Core instance managing its Agents, capacity, authenticated Service access, input delivery, observation and cleanup. |
| **Run** | One execution of a Harness, identified and recorded through a Runtime. A Harness adds its own business outcome and evidence. |
| **Agent** | A Runtime-owned execution identity with its own Sandbox, working directory and Session. A settled Agent can receive another input. |
| **Profile** | A named Agent configuration containing its prompt, model, image, Service permissions and optional control/file settings. Runtime creation captures its definition. |
| **Backend** | The execution and resource integration used by the Runtime. The public OpenSandbox factory selects the Pi or Codex executor and returns a handle claimed by one Runtime. |
| **Executor** | The Agent implementation running inside the Sandbox: Pi or Codex. Capabilities such as context fork differ between executors. |
| **Sandbox** | An Agent's isolated execution environment, allocated through OpenSandbox. The supported deployment uses Docker-backed OpenSandbox on the same host. |
| **Worker** | The container image and guest-side programs that implement the murm execution protocol, tools and selected executor. |
| **Slot** | One unit of a Runtime's configured Agent capacity. An idle or settled Agent still occupies it; confirmed cleanup releases it. |
| **Session** | An Agent's conversation and executor context retained across input turns. A Session is distinct from the current execution activity. |
| **Working directory** | An Agent's project files, private by default. A Harness can explicitly select a shared workspace or publish files through its Services. |
| **Service** | A named capability with a manifest, operations and an adapter. It may hold collaboration state or connect an existing application. |
| **Bridge** | The trusted host boundary that authenticates Agent calls, discovers permitted operations, validates requests and invokes Service adapters. |
| **Model gateway** | The host path for configured model requests, credentials, access checks and traces. It is separate from Service routing. |

## Inputs, observations and results

| Term | Meaning |
| --- | --- |
| **Request ID** | A caller-supplied identity for an operation that supports deduplication. Retry an uncertain request with the same identity and parameters. |
| **Input receipt** | The result of submitting input: accepted, unknown, or conditionally not accepted. An accepted receipt describes admission, not task correctness. |
| **Steer** | Input offered while the Agent is working, subject to the executor's supported steering modes. It is the default `send` mode. |
| **Follow-up** | Input queued for a subsequent execution opportunity. The API spelling is `followUp`. |
| **Settled** | The executor has stopped automatically continuing its current activity. The Agent, Session and Slot remain; the Harness still decides whether the task succeeded. |
| **Observation cursor** | The Runtime-scoped sequence used to join a snapshot to live updates or resume within the retained event window. It is not durable process restart. |
| **Business outcome** | The Harness's decision that its job completed, failed or was cancelled. It is recorded separately from cleanup and artifact verification. |
| **Artifact verification** | A host check of exported results. `finalizeRun` records whether the configured check passed, failed, timed out or was not requested. |
| **Cleanup receipt** | A statement of confirmed execution/resource cleanup and anything pending or retained. A timeout does not prove that a resource was destroyed. |

See the [SDK guide](docs/en/sdk.md), [Run lifecycle](docs/en/run-lifecycle.md) and [types reference](docs/en/reference/types.md) for the actual method signatures and status values.

## TaskPool domain

TaskPool organizes work through a Mission and exclusive Task ownership. The current contracts are described in [Mission and Task](docs/architecture/03-mission-task.md), [Services](docs/architecture/04-services.md) and [Workspace](docs/architecture/05-workspace-continuity.md).

| Term | Meaning |
| --- | --- |
| **Mission** | The shared objective, resource boundary and final acceptance scope. A Mission is not taken as a Task. |
| **Task** | A bounded responsibility with its own objective, deliverable and completion conditions. It has at most one current executor. |
| **Execution** | The authorized interval in which one Agent owns a taken Task, including its finalization and cleanup. This domain object differs from a Core execution observation. |
| **Take** | Acquiring exclusive current responsibility for an eligible Task. Proposing a Task does not reserve it. |
| **Finish** | Ending the current Execution with an explicit outcome such as done, incomplete, blocked or cancelled. |
| **Material** | Versioned, immutable shared research content or attachments with production and use provenance. Publication alone does not establish usefulness or truth. |
| **Workspace** | The Mission's public project repository, including current main and immutable saved revisions. It is distinct from an Agent's private directory. |
| **Revision** | An immutable Workspace file version with explicit ancestry. Revision numbering alone does not establish ancestry. |
| **Main** | The current shared integration revision. Saving a revision does not advance main. |
| **Candidate** | An ordinary proposed file at a fixed Workspace revision and path, not an additional stored entity. |
| **Judge / CheckResult** | A checker and its result tied to immutable inputs and a configured checking environment. A diagnostic pass is separate from Task completion and Mission acceptance. |
| **Mission submission** | A fixed final delivery selected for acceptance, containing current main and an explicit Material selection. |
| **Handoff** | Continuing through public Task state, Materials and saved files after an earlier Agent ends. |
| **Dependency** | A genuine prerequisite for a Task, rather than a proposal-origin or management relationship. |
| **Dispute** | A reasoned question about a particular Material claim or section. |
| **Supersession** | Explicit replacement of a whole Material by a self-contained successor while retaining history. |

GitHub development Issues and PRs are engineering records, separate from research Tasks and Missions. The word “goal” can describe an objective; it does not introduce another Core object. Pending design terms belong in their Issue-linked design until the corresponding API is implemented.
