# Repository ownership and example extraction

This implementation plan accompanies the repository-cleanup PR. Its audit baseline is
[`main@207be635`](https://github.com/LuNa-shi/murm/tree/207be6356c16e5fb60c4b3c5b236d7a98383f991).
The first section describes changes implemented in that PR. The later sections are
the remaining migration work, with concrete completion criteria. They are not claims
that the examples are already independent packages.

The public contract stays one package, `@luna-shi/murm`, with a root SDK import.
Ordinary Harness input remains a project directory and an initial prompt. Resource
configuration is separate from task input. Linux is the supported installation target
for this work; there is no macOS implementation or test requirement.

## Why the current layout needs work

The repository has accumulated three overlapping products: a reusable Core, a
collection of runnable collaboration applications, and an earlier TaskPool research
system. Many implementations already obey the Core boundary, but their locations,
names, documentation and package contents do not communicate that boundary.

The audit found these concrete problems:

| Area | Finding at the audit baseline | Required correction |
| --- | --- | --- |
| Historical documentation | `docs/experiments` still tracks 100 files. | Remove them from the maintained tree; cite fixed Git history for necessary evidence. |
| Developer documentation | `docs/agents` repeats AGENTS, glossary and development workflow. | Consolidate the useful conventions into AGENTS. |
| Installation | Current-source guides combine the v0.2.0 release installer with newer setup flags. | State the exact candidate being installed and tested. |
| Architecture | Some chapters still describe private packaging, public subpaths, `observe`, single-use Sandbox configuration, or unavailable management APIs. | Reconcile descriptions with executable exports and current implementations. |
| Default deployment | `deploy/builtin-services` is an incomplete legacy Task/Context/Judge/Catalog recipe; setup does not start it. | Put it with TaskPool and explain its limitations. |
| Optional search | `deploy/mathlib-search` is Lean/Mathlib search, not a default platform service. | Keep implementation, resources and image recipe together as an optional Service. |
| Example ownership | Three complete collaboration implementations live under `src/harnesses`, separate from their example entrypoints. | Move them into their owning examples. |
| Generic host | `foreground-host.ts` switches on PeerMesh/TaskPool despite living under `shared`. | Put concrete mode dispatch in CLI code. |
| Source language | TaskPool prompts, guidance and CLI examples still contain Chinese text. | Translate executable instructions, comments and diagnostics into English. |
| SDK boundary | `src/sdk` is largely the older TaskPool service protocol, while the public SDK is `src/core/index.ts`. | Extract or retire the domain protocol; do not present it as a second general SDK. |
| Published package | The tarball includes source, compiled tests and build inputs to support local Worker builds and acceptance tests. | Narrow this deliberately after the runtime/build dependency graph is separated. |

Core does not currently import TaskPool's Task, Material, Judge or database
implementations. It still knows TaskPool's CLI aliases through
`src/cli/service-command.ts`, and several shared utilities remain outside Core.
Directory cleanup therefore improves ownership without establishing complete
semantic independence.

## Changes in the cleanup PR

| Previous location | Location after this PR | Responsibility |
| --- | --- | --- |
| `src/harnesses/peermesh/` | `examples/peermesh/harness/` | Peer lifecycle, routing, provisioning, adapters and delivery. |
| `src/harnesses/lead-worker/` | `examples/lead-worker/harness/` | Board, ownership, team coordination, Git delivery and dynamic services. |
| `src/harnesses/substrate/` | `examples/substrate/harness/` | Generic and paper-oriented publication/retrieval mechanisms. |
| `src/harnesses/shared/` | `src/harness/` | Common project input, host/RPC, reporting and cleanup support. |
| `src/harnesses/shared/foreground-host.ts` | `src/cli/foreground-harnesses.ts` | Older CLI dispatch for TaskPool and PeerMesh. |
| PeerMesh HTTP/resource helpers | `src/harness/http.ts`, `src/harness/owned-resources.ts` | Shared host-side request and resource ownership policy. |
| `examples/bridge-services/` | `examples/messages/` | A two-Agent Messages Service handoff tutorial and runnable `messages` alias. |
| `examples/bridge-services/gh-issues.ts` | `examples/services/github-issues/index.ts` | A read-only adapter around an existing host application. |
| `src/services/mathlib-search/`, its Dockerfile and server script | `examples/services/mathlib-search/` | An optional reusable Service for TaskPool and the FATE benchmark. |
| `deploy/builtin-services/` | `examples/taskpool/deploy/service-hosts/` | Explicit compatibility recipes, outside default installation. |

The builtin CLI aliases keep their names. A builtin alias is a convenience lookup
of an ordinary example module; it does not give the implementation a place in Core.
Source imports, compiled paths, Docker COPY inputs, tests, generators and maintained
documentation move with their owners in this PR.

The documentation cleanup removes historical reports and redundant Agent documents.
Required historical links point at the audit commit, so the original observations
remain inspectable. Architecture remains the implementation manual, including
currently executable compatibility paths and full prompt references.

The Putnam benchmark previously read its launch registration from deleted Markdown
under `docs/experiments`. It now reads an explicitly selected private registry.
Registration, model matching, a clean pinned implementation and immutable Worker
image checks remain mandatory. This change does not authorize a research run.

### What this PR does not establish

The examples still use private `src/harness` support, and TaskPool still imports
its domain implementation from `src`. Moving the three implementations makes
ownership visible; it does not yet make copying one example into another repository
sufficient. The following work closes that remaining boundary.

## Extract the domain system and simplify Core internals

Make this one implementation Issue/PR, including source changes, runtime migration,
tests, package inputs and architecture updates. No separate design PR is required.

### TaskPool owns its domain

| Current implementation | Target owner | Migration detail |
| --- | --- | --- |
| `src/task/*`, `src/storage/schema.ts` | `examples/taskpool/services/task/` | Preserve Task/Execution schema, fences, ownership and admission. |
| `src/context/context-service.ts`, `context-schema.ts` | `examples/taskpool/services/material/` | Preserve immutable Material state, notices and receipts. |
| Execution/Mission Workspace modules, manager, public reads/publication and contracts under `src/runtime` | `examples/taskpool/services/workspace/` | Preserve revisions, ancestry, read-only preparation and controlled publication. |
| Mission submission/access and manual review under `src/runtime` | `examples/taskpool/services/mission/` | Preserve selected immutable inputs, acceptance and replayable receipts. |
| `src/replay/service-history.ts`, service commit/peer schemas | TaskPool-local persistence support | Preserve stored data and recovery semantics; replay is not a generic Core object. |
| `src/agent/agent-contract.ts`, TaskPool service catalog | TaskPool prompts and service manifests | Keep complete English prompt text and send-path documentation. |
| `src/judge/*` and Judge schema | TaskPool Judge service plus explicit Lean benchmark support | Separate reusable Lean verification from TaskPool lifecycle integration. |
| Domain hosts/peers under `src/sdk`, associated scripts | TaskPool service deployment | Rename according to actual ownership; retire duplicate registries when their last caller is migrated. |
| Legacy runtime, ServicesBridge and capability profiles | Remove after caller review, or retain only under an explicitly owned compatibility fixture | They must not become another generic `Runtime`. |

There are two real dependencies to extract before moving all these files:

1. `src/runtime/workspace-repository.ts` also seeds Git repositories for the common
   project host. Extract its generic Git/files operation first. `src/harness` must
   not import TaskPool after the move.
2. `src/judge/lean-source-policy.ts` is used by the Substrate FATE checker. Put the
   checker and pinned FATE setup under `benchmarks/fate/` or a declared optional
   checker package, keeping the normal Substrate example free of Lean prerequisites.

The old Service protocol includes role-bound declarations and transport behavior.
Do not expose it wholesale from Core just to make private imports disappear.
Mathlib Search must either use the public Service adapter contract directly or own
its explicit optional server dependency. It must not silently depend on TaskPool's
entire transport stack.

### Core owns implementation infrastructure

Group Core's model catalog, request validation and gateway implementations under
`src/core/model/`; group provider, Worker transport and resource integration under
`src/core/sandbox/`; group shared file capture/transfer under an explicit files
module. Keep executable Worker entrypoints separate from imported library helpers.
Moving functions must preserve resource ownership, timeout, unknown-result,
authorization and cleanup behavior.

`src/cli/swarm-cli.ts` and Core startup currently embed TaskPool command names and
aliases. Make discovery and invocation follow Service manifests, with the generic
`swarm service invoke <service> <operation>` path available for any Service. Keep
domain conveniences in TaskPool-owned configuration. Core retains its actual
builtin `agent` Service; an Agent lifecycle/control service belongs to Core.

Completion criteria:

- No TaskPool business implementation remains at the source root.
- Core and the common Harness host have no dependency path to an example, Judge,
  Task/Material database, or domain command catalog.
- Existing TaskPool database/Workspace fixtures retain the same stored contracts
  and meaningful lifecycle/recovery assertions.
- A new Service with unrelated names is discoverable and callable without editing
  the Core prompt renderer or CLI alias table.
- No obsolete runtime/protocol compatibility path remains solely because a test
  imports it; intentional compatibility has a named consumer and documented scope.

## Make each example an independent SDK consumer

Deliver this as one implementation Issue/PR after the dependency extraction. The
five mechanism examples and future additions should all use the same package
shape and acceptance procedure.

| File/directory in an example | Purpose |
| --- | --- |
| `package.json`, `tsconfig.json` | Declare the released SDK and required dependencies; provide local build/start/check commands. |
| `main.ts` or `project.ts` | Consume the initial directory and prompt; compose the public SDK. |
| `harness/` | The mechanism's scheduling, routing and result policy. |
| `services/` | Service manifests, adapters and business state owned by this example. |
| `prompts/` | Complete mechanism prompts when separate files improve readability. |
| `deploy/` | Only services needed by this example, with image/source and ownership documented. |
| `README.md` | One runnable path from this directory, required configuration, observations, outputs and cleanup. |

Expose the minimal author-facing Harness contract from the package root (currently
`ProjectHarness`, its context/result and initial project contract are private).
Separate generic host implementation from author-facing operations. Only promote
a helper into the public API when independent Harness authors need it; small
example-specific reporting and checking functions can remain local.

An example may import Node, declared dependencies, its own source and the public
SDK. It may not import `../../src`, `dist/src`, another collaboration example, or
checkout-only fixtures. Optional reusable services belong to explicit packages
or endpoints. They are listed as dependencies instead of found through sibling
filesystem paths.

Move fixed task fixtures, Orders oracles and paper benchmark setup into
`test-support/` or `benchmarks/` with their owning runner. They continue testing the
same mechanism, but do not become ordinary user input requirements.

### Deployment and packaging acceptance

`deploy/` contains common OpenSandbox configuration and the shared Worker image.
The actual Core `agent` Service and simple in-process example services need no
extra Docker deployment. Gitea, Mattermost, MySQL/Board and dynamic checker
containers remain explicit example dependencies.

Each externally deployed service documents its endpoint, health/readiness check,
credentials, data persistence, creator/cleanup ownership, and whether it has a
published image. Provide an example-local setup/start command when the repository
can provision that service. Existing externally supplied services are checked and
connected without claiming ownership or destroying them on Run close.

Publish prebuilt images only through an explicit release workflow and validated
version/digest. The current workflow publishes Worker variants; it does not publish
images for the legacy TaskPool hosts or Mathlib Search. Keep source-build recipes
honest until such artifacts exist.

Separate the minimal SDK/CLI package payload from developer-only tests, benchmark
fixtures and Worker build contexts. Before removing source from the tarball,
replace or package the exact build context required by setup's Worker fallback.
`npm pack --dry-run` alone cannot prove an installed runtime still works.

Acceptance must use the actual candidate archive in a temporary directory outside
the checkout:

1. Copy each example, install its declared dependencies and the candidate SDK, then
   build it with no repository source tree available.
2. Launch from the example directory and from another project directory, using a
   different initial prompt and files. Reach dependency preflight without hidden
   source imports or a required workload file.
3. Exercise input capture, first and later Agent files, event/status/input routing,
   deadlines, failure receipts and cleanup through controlled integration tests.
4. Verify the mechanism-specific observable path: delegation/reply, exclusive
   take/handoff, peer coordination/Git delivery, publication/retrieval, and
   Lead–Worker ownership/feedback respectively.
5. Run bounded real-model collaboration checks only within authorized resources.
   Report these separately from type checks, controlled responses and dependency
   preflight. A package that merely imports is not end-to-end acceptance.

## Documentation ownership after migration

Keep README as the product/install entry; `docs/en` and `docs/zh` are the website's
single user-guide source. Keep architecture for current behavior, call order,
failure/cleanup and complete generated prompt/API/storage references. Example
READMEs explain local setup and mechanism-owned Services. AGENTS contains
development instructions, not a competing product specification.

Maintain only active future designs under `docs/designs`. When their implementation
lands, reconcile useful reasoning into the manual and retire superseded prose
through Git history. Experimental reports and progress belong with the relevant
Issue/PR and explicitly requested research artifacts, rather than being mixed back
into the maintained SDK documentation.
