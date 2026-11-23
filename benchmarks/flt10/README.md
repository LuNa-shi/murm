# FLT10bench inputs

This is the complete ten-checkpoint `flt10bench-proof-dag-cut-v1` ladder from
[nustarai/ContextSwarm](https://github.com/nustarai/ContextSwarm/tree/3e529ef2cd337a1b829fe280c7360cb3dd95b35c/benchmarks/FLT10bench).
Q10 and Q20 are checkpoints one and two; Q100 is the complete FLT target.
Scores label ordered capability checkpoints, not additive percentages of FLT.

Only the unsolved baseline, problem text and metadata are copied, byte-for-byte.
`upstream-integrity.json` retains the upstream hashes. `projection-contract.json`
records the exact safe module source hashes, frontier and cut digest generated
from Anthropic's FLT checkout `aa2d8b34692b16c70f699536de0d8e75b9a3e9ef`.
The original metadata's logical source revision `f44bd7c1...` remains unchanged;
it is distinct from the physical Anthropic checkout used to build the projection.

`LICENSE`, `NOTICE` and `ATTRIBUTION.md` come from the upstream source bundle.
The statement graph builder in `scripts/benchmarks/` is copied from the same
ContextSwarm commit. `read_context.py` reads the retained metadata.
The original operator preparation commands and source-building procedure are
preserved in the [research preparation scripts](https://github.com/LuNa-shi/SwarmEnv/tree/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/scripts/benchmarks).
Existing input manifests and checker projections remain pinned to their original
source, Mathlib and Lean revisions. This directory retains those inputs for the
legacy loader and checker while Phase 0005 migration continues.

Use SwarmEnv's artifact lock tool with `benchmarkProfile: "flt10-dag-v1"`, the
checkpoint number, its `projectionRoot`, pinned Mathlib library roots and the
unchanged Comparator/lean4export deployment. Add only that checkpoint's `lib`
to `libraryRoots`. The trusted sources JSON also needs `flt` at the pinned source
checkout. Each checkpoint needs its own lock and deployment config.

The regular benchmark CLI accepts `--benchmark-root` as an alias for the legacy
`--putnambench-root`. Point it to the pinned ContextSwarm source checkout used by
`config/flt10.json`. All actual execution uses SwarmEnv's existing OpenSandbox,
independent services, Core, Task, Material, Workspace and Judge paths. Supply
`MATHLIB_SEARCH_SOURCE_ROOT` from this FLT Mathlib checkout; do not expose complete
FLT solution sources to the search service. Formal run authorization, registration,
preflight and cleanup follow `docs/workflows/experiment.md`.

The first four-Core Q10 observation blocked before proof work; see
[the Q10 report](../../docs/experiments/EXP-20261116-09-flt-q10-1h.md). The follow-up
repair keeps the complete graph in Workspace, transfers initial files through
the existing authenticated worker preparation path, renews preparation leases,
and preserves discovery settlement across binding. Q10 must pass a real
edit/Judge/feedback cycle and bounded observation before Q20 resumes. Passing
setup tests alone does not establish parallel advantage.

## Root-only Workspace variant

Issue [#135](https://github.com/LuNa-shi/SwarmEnv/issues/135) adds the separate
`flt10-subtree-v1` input/submission profile. Its original preparation selected
**Q20 only** by default and deferred Q100. The original ladder above remains
available for reproducibility.

The existing public fixture contains one root theorem, its reduced statement
foundation and neutral task instructions. Its private extraction facts and
reference proofs stay outside Bot inputs. Reproducing the original source
preparation uses the research scripts linked above.

A successful preparation means the initial `sorry` project compiles and preserves
the elaborated target. It does **not** establish solvability. Configure a
`flt10-subtree-v1` checker with that checkpoint, foundation manifest digest and
compiled foundation, then create its artifact lock. A complete private witness
must pass `scripts/validate-benchmark-witness.mjs` under that deployment, with a
separate actual visibility audit, before attaching the private receipt to the
benchmark config. Missing or stale validation prevents timed startup. See
[run configuration](../../docs/architecture/07-run-configuration.md) for the
receipt contract. Agent proofs may add modules, definitions and lemmas; the
final checker still verifies the original mathematical target and proof axioms.
