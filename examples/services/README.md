# Optional Service examples

These directories show how an application supplies an additional capability.
They are separate from the five collaboration mechanisms listed in
[the examples index](../README.md), and none is required by default SDK setup.

| Example | What it demonstrates | Deployment |
| --- | --- | --- |
| [GitHub issues](github-issues/README.md) | A public SDK adapter invokes a scoped, read-only host CLI operation. | Install and authenticate `gh` on the application host. No extra container. |
| [Mathlib Search](mathlib-search/README.md) | A domain search provider used by TaskPool and the Substrate FATE benchmark. | Explicit source-built HTTP provider with Loogle or a pinned source tree. |

For a small runnable two-Agent example using the current Service API, start with
[Messages](../messages/README.md). It demonstrates registration, per-Profile
grants, an in-process adapter and an existing HTTP JSON v2 service.

The Mathlib example retains the older HTTP JSON v1 service-bundle protocol.
Its implementation and recipe are grouped here, but extracting its private
server dependencies is part of the [remaining migration](../../docs/designs/repository-layout.md).

See [Services](../../docs/en/services.md) for the supported public SDK contract.
