# FLT10bench Q40: Galois-stable Vélu quotient

Complete the Lean theorem in `baseline/q40.lean` by replacing only the proof placeholder.

The public context is a proof-DAG cut of the pinned Anthropic FLT formalization. The repository
provides the complete statement-level framework and dependency graph as metadata, while the target
theorem and its entire transitive proof dependency cone are removed from the Lean import path. The
compiled frontier is `FLT10.DAG_q40`. Definitions are retained only when their own import closure
contains no cut proof module. Q30/Q40 additionally expose the audited statement-context module `Definitions.Def_FLTPrelim_Modularity` so the unchanged `card` namespace preamble elaborates; this module has no cut-proof import. Do not import or search `Theorems.*`, `P2M.Sol.*`, or another target.
The Judge accepts only a kernel-checked proof with no `sorry`, `admit`, unsafe code, or proof bypass.

Canonical source theorem: `WeierstrassCurve.exists_quotientDatum_of_galois_stable_primeCard`
FLT10bench score: **40/100**

The score is an ordered capability checkpoint, not an additive percentage of the final theorem.
