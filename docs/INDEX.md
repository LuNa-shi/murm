# murm documentation

Start with the user guides to run a Harness or build your own. The English and Chinese Markdown files are the website's content source: editing a guide here updates the corresponding published page when the site is rebuilt.

## Start using murm

| Goal | English | 中文 |
| --- | --- | --- |
| Understand what murm provides | [Overview](en/overview.md) | [文档总览](zh/overview.md) |
| Run your first Harness | [Quickstart](en/quickstart.md) | [快速上手](zh/quickstart.md) |
| Build a 2-minute mental model | [Core Concepts](en/concepts.md) | [核心概念](zh/concepts.md) |
| Master the 6 core building blocks | [Sandboxes](en/sandbox.md) · [Runtime](en/runtime.md) · [Agents](en/agents.md) · [Gateway](en/gateway.md) · [Services](en/services.md) · [Trace Viewer](en/trace-viewer.md) | [Sandbox](zh/sandbox.md) · [Runtime](zh/runtime.md) · [Agent](zh/agents.md) · [Gateway](zh/gateway.md) · [Services](zh/services.md) · [观测与调试](zh/trace-viewer.md) |
| Build a parallel Swarm step by step | [Build a Swarm Harness](en/build-your-harness.md) | [实战：构建 Swarm Harness](zh/build-your-harness.md) |
| Compare the five collaboration patterns | [Choose a Harness](en/harnesses/index.md) | [选择 Harness](zh/harnesses/index.md) |
| Look up SDK exports, CLI flags & types | [API](en/reference/api.md) · [CLI](en/reference/cli.md) · [Types](en/reference/types.md) | [API](zh/reference/api.md) · [CLI](zh/reference/cli.md) · [类型](zh/reference/types.md) |
| Track the latest release & changelog | [Latest (v0.2.0)](en/latest.md) · [Changelog](en/changelog.md) | [最新版本](zh/latest.md) · [更新日志](zh/changelog.md) |

## Understand or change the implementation

[Architecture](architecture/INDEX.md) is the current implementation manual. It explains the SDK, backend, Harnesses, domain Services and retained compatibility paths, including errors, storage, prompts and cleanup. Start with the [system overview](architecture/00-overview.md), then follow the chapter for the behavior you need. [GLOSSARY.md](../GLOSSARY.md) keeps general SDK terms separate from TaskPool-specific terms.

| Reference | Purpose |
| --- | --- |
| [Development](workflows/development.md) | Build, validate and contribute changes. |
| [Coding Agent instructions](../AGENTS.md) | Project-specific work rules, permissions and documentation requirements. |
| [Engineering record conventions](../AGENTS.md#engineering-record-conventions) | Issue scope, evidence and triage conventions. |
| [Trace Viewer](operations/trace-viewer.md) | Inspect saved and active Run records. |
| [Website implementation](architecture/22-website.md) | Content loading, links, bilingual build and deployment. |
| [Research context](PROJECT.md) · [Experiment workflow](workflows/experiment.md) | Research questions, resources and evidence standards. |
| [Third-party notices](third-party-notices.md) | Attribution and licenses. |

## Current behavior and planned changes

The user guides describe the supported public surface. The architecture manual describes how the current tree implements it. Source code and generated references establish exact fields and defaults; tests and experiments establish what was verified. Changes to this baseline need corresponding documentation in their implementation PR.

The [Core / Harness design](designs/core-harness/README.md) retains reviewed, version-bound decisions and acceptance criteria. Read it with the applicable Issue and later explicit owner decisions; older first-release limits do not override those changes. The design index links the [dynamic Lead-Worker contract](designs/dynamic-lead-worker.md) and CLI/TUI work in [#252](https://github.com/LuNa-shi/murm/issues/252). Current implementation belongs in Architecture; remaining acceptance stays in the original Issue/PR. Design updates, code, migration, tests and documentation are reviewed together in the implementation PR.

The [repository implementation plan](designs/repository-layout.md) distinguishes the cleanup already implemented from remaining TaskPool domain extraction, the public Harness author contract, and independent example packaging. The five collaboration mechanisms live under their owning `examples/` directories; `src/harness/` holds common host support. CLI aliases load example modules and do not make those policies part of Core. See [examples](../examples/README.md) and [deployment ownership](../deploy/README.md) for their actual dependencies.

Superseded plans from earlier phases, migration inventories and superseded ADRs remain in [Git history before this cleanup](https://github.com/LuNa-shi/murm/tree/fb457bbfc8fc038ac8f2cfbbcfd1ab4a4e655b02/docs).

## Historical evidence

Current documentation covers supported behavior and active development. Historical experiment reports are retained at [their last tracked revision](https://github.com/LuNa-shi/murm/tree/207be6356c16e5fb60c4b3c5b236d7a98383f991/docs/experiments), with their original implementation, model, inputs, failures and limitations. New run registrations and reviewed conclusions belong in the originating Issue/PR; raw evidence remains in ignored local directories. See the [experiment workflow](workflows/experiment.md). Historical observations do not override the current SDK contract.
