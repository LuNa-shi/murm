# FLT10bench Q80: Modularity of the Frey curve

Complete the Lean theorem in `baseline/q80.lean` by replacing only the proof placeholder.

The public context is a proof-DAG cut of the pinned Anthropic FLT formalization. The repository
provides the complete statement-level framework and dependency graph as metadata, while the target
theorem and its entire transitive proof dependency cone are removed from the Lean import path. The
compiled frontier is `FLT10.DAG_q80`. Definitions are retained only when their own import closure
contains no cut proof module. Do not import or search `Theorems.*`, `P2M.Sol.*`, or another target.
The Judge accepts only a kernel-checked proof with no `sorry`, `admit`, unsafe code, or proof bypass.

Canonical source theorem: `FreyPackage.frey_isModular`
FLT10bench score: **80/100**

The score is an ordered capability checkpoint, not an additive percentage of the final theorem.
