# SwarmEnv

SwarmEnv is a research environment for autonomous collaboration among multiple Agents. Agents can work on a shared Mission, define independent Tasks, exchange versioned Materials, and use Judge, Workspace and Runtime capabilities to check and continue their work.

The Phase 0005 refactor provides a programmable Core and Environment modules. Dedicated mathematical benchmark launchers and embedded datasets are preserved in the research branch.

## Start here

| Reader / question | Document |
|---|---|
| Research purpose and open questions | [PROJECT.md](docs/PROJECT.md) |
| Coding Agent instructions and permissions | [AGENTS.md](AGENTS.md) |
| Current documentation map | [docs/INDEX.md](docs/INDEX.md) |
| Current Core / Environment stage requirements | [Phase 0005 authoritative design](docs/phases/0005-core-environment/README.md) — full Core, Environment and delivery plan |
| Human-reviewed development task | Derived GitHub Issue for Phase 0005; approved Issue contract for other stages |
| Implementation decisions and handoff for an Issue | The originating **GitHub Issue / PR** |
| Complete proposed stage design and review order | [docs/phases/INDEX.md](docs/phases/INDEX.md), linked to its design Issue and PR |
| Complete current implementation, prompts and interfaces | [docs/architecture/INDEX.md](docs/architecture/INDEX.md) |
| Development and experiment workflows | [Development](docs/workflows/development.md) · [Experiments](docs/workflows/experiment.md) |
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |

For the Core / Environment stage, the [Phase 0005 design on main](docs/phases/0005-core-environment/README.md) is the sole source of target requirements, scope and acceptance. Its Issues cite the design revision and track implementation, dependencies and evidence; requirements change through the design PR first. Notion pages are migration sources. The design is not a claim that the new APIs are implemented. Other stages retain the human-approved Issue as their requirements contract. Resource and publication authorization stays explicit. Each implementation PR updates the affected Architecture, and stage closeout reconciles the manual, final code and evidence.

## Implementation map

- `src/agent/` — Pi Agent adapter, prompts, capability profiles, Services Bridge
- `src/task/`, `src/context/`, `src/judge/` — authoritative domain state
- `src/runtime/` — Execution processes, resources and Workspaces
- `src/observability/` — event/state inspection
- `scripts/`, `config/`, `services/`, `test/` — operation, configuration, integrations and tests

Operational references: [built-in services](services/builtin/README.md), and [Mathlib Search](services/mathlib-search/README.md).

## Evidence and history

The [implementation manual](docs/architecture/INDEX.md) documents the pinned runtime baseline, and the [experiment index](docs/experiments/INDEX.md) links version-bound observations. [EXP-20261116-04](docs/experiments/EXP-20261116-04-workspace-project-1h.md) records whole-Workspace collaboration and trusted acceptance for the implementation merged in PR #128. Its early success does not establish one-hour endurance or a matched collaboration benefit; older reports retain their own outcomes. Implementation progress and outstanding checks belong in the relevant GitHub Issue/PR.

Obsolete documentation remains accessible from the [fixed Git history tree](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs). This working tree does not recreate an `archive/` directory. Ignored raw experiment data may not exist in Git history.

