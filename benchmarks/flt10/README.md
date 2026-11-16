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
ContextSwarm commit. `prepare_flt10.py` and `read_context.py` are SwarmEnv setup
and metadata readers. No ContextSwarm runtime, algorithm or historical solution
is an input. The retired Foundation overlay is not used.

Prepare only in ignored local storage:

```sh
python3 -B scripts/benchmarks/prepare_flt10.py \
  --source /path/to/pinned/fermats-last-theorem \
  --lean /path/to/lean-4.33.1/bin/lean \
  --output experiments/flt-setup/state/new-prepared
```

The source checkout must be clean at the pinned revision with its pinned Mathlib
packages available. The tool builds every safe frontier from source with only
those definition modules and Mathlib on `LEAN_PATH`, never the complete FLT
artifact directory. It writes per-checkpoint source/lib directories, compressed
public statement graph shards, cut manifests and a context-bound benchmark config.
`--no-build` prepares metadata only and cannot produce a runnable checker lock.
An existing output is rejected. Build failures leave diagnostic evidence there;
retry in a fresh output rather than mixing partial artifacts.

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

The first four-Core Q10 observation reached task decomposition but blocked in
large public-context transfer and the existing slow-binding lifecycle path;
see [the Q10 report](../../docs/experiments/EXP-20261116-09-flt-q10-1h.md).
Successful preparation and checker probes therefore do not yet establish a
working long-duration FLT proof run or parallel advantage. The complete graph
is recopied for each fresh Bot; immutable image distribution is a possible
follow-up, not an implemented option.
