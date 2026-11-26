# murm documentation

Start with the user guides to run a Harness or build your own. The English and Chinese Markdown files are the website's content source: editing a guide here updates the corresponding published page when the site is rebuilt.

## Start using murm

| Goal | English | 中文 |
| --- | --- | --- |
| Understand what murm provides | [Overview](en/overview.md) | [文档总览](zh/overview.md) |
| Run your first Harness | [Quickstart](en/quickstart.md) | [快速上手](zh/quickstart.md) |
| Understand Runtime, Agent, Profile and Service | [How murm works](en/concepts.md) | [工作原理](zh/concepts.md) |
| Embed murm in a TypeScript application | [Use the SDK](en/sdk.md) | [使用 SDK](zh/sdk.md) |
| Add a Service and choose a control loop | [Build your Harness](en/build-your-harness.md) | [构建自己的 Harness](zh/build-your-harness.md) |
| Compare the five collaboration mechanisms | [Harnesses](en/harnesses/index.md) | [协作机制](zh/harnesses/index.md) |
| Follow input, execution and cleanup | [Run lifecycle](en/run-lifecycle.md) | [运行生命周期](zh/run-lifecycle.md) |
| Look up public calls and types | [API](en/reference/api.md) · [Types](en/reference/types.md) | [API](zh/reference/api.md) · [类型](zh/reference/types.md) |

## Understand or change the implementation

[Architecture](architecture/INDEX.md) is the current implementation manual. It explains the SDK, backend, Harnesses, domain Services and retained compatibility paths, including errors, storage, prompts and cleanup. Start with the [system overview](architecture/00-overview.md), then follow the chapter for the behavior you need. [GLOSSARY.md](../GLOSSARY.md) keeps general SDK terms separate from TaskPool-specific terms.

| Reference | Purpose |
| --- | --- |
| [Development](workflows/development.md) | Build, validate and contribute changes. |
| [Coding Agent instructions](../AGENTS.md) | Project-specific work rules, permissions and documentation requirements. |
| [Agent configuration](agents/domain.md) · [Issue tracker](agents/issue-tracker.md) | Domain and execution-record conventions. |
| [Trace Viewer](operations/trace-viewer.md) | Inspect saved and active Run records. |
| [Website implementation](architecture/22-website.md) | Content loading, links, bilingual build and deployment. |
| [Research context](PROJECT.md) · [Experiment workflow](workflows/experiment.md) | Research questions, resources and evidence standards. |
| [Third-party notices](third-party-notices.md) | Attribution and licenses. |

## Current behavior and planned changes

The user guides describe the supported public surface. The architecture manual describes how the current tree implements it. Source code and generated references establish exact fields and defaults; tests and experiments establish what was verified. Changes to this baseline need corresponding documentation in their implementation PR.

Human-approved Issues and explicit user instructions define the intended next change and its acceptance. An Issue can link a reviewed design, but a target design is not an implemented API. The [dynamic Lead-Worker extension](designs/dynamic-lead-worker.md), tracked in [#235](https://github.com/LuNa-shi/murm/issues/235), is one such pending design; current Profiles and Service access remain fixed when a Runtime is created.

Earlier numbered phase plans, migration inventories and superseded ADRs have been retired from the working documentation. Their exact versions remain in [Git history before this cleanup](https://github.com/LuNa-shi/murm/tree/fb457bbfc8fc038ac8f2cfbbcfd1ab4a4e655b02/docs). This does not change the acceptance or resource permissions of an ongoing Issue.

## Historical evidence

[Experiment reports](experiments/INDEX.md) remain because they record what a particular run actually did. Keep their original implementation, model, inputs, failed attempts and limitations intact. Links to retired designs point to fixed Git revisions. Historical observations and old acceptance targets do not override the current SDK contract.
