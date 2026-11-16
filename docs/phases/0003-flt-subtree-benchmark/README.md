# Phase 03: FLT root-only proof reconstruction

Target design linked to [Issue #135](https://github.com/LuNa-shi/SwarmEnv/issues/135).
The owner authorized the root-only direction, all-checkpoint support and use of
SwarmEnv's existing Workspace/Task/Material/Judge coordination. The latest
execution priority is **Q20 only**, one problem at a time; Q100 verification and
experiments are deferred. Implementation and validation status belong to the
Issue/PR, not this design attachment.

## Task and information contract

A checkpoint is a root of a proof dependency DAG, informally a subtree. Supply
one unchanged root statement with one `sorry`, public Mathlib, and genuine
foundation definitions/instances required to express that statement. Supply no
original helper-theorem catalog, proof DAG, cut manifest, completed proof,
downstream result, or previous run. Agents create their own definitions, lemmas,
files and decomposition in Workspace; the current initial revision is `0.1`.

Preserve semantic foundations instead of replacing them with opaque assumptions.
Use Lean declaration facts (`typeDeps` versus `valueDeps`) and parser-reported
source spans to subtract unrelated declarations. Constructors, generated
companions, instance resolution and lexical scope must survive. Definitions can
require small proofs: retain the real required proof, count that supplied
context, and never insert foundation `sorry` to make compilation succeed.

## Stable runtime interface

Benchmark configuration supplies its identity, problems, target declaration,
initial public manifest and instruction path. The checker adapter supplies the
pinned toolchain, reduced foundation and final validation policy. The runner
must not need a new benchmark-name branch or hard-coded problem count. No
Core scheduling, Task selection or Material coordination policy changes.

Agents may import their own project modules. Final checking locks the root's
mathematical meaning and trusted basis, rather than its textual preamble.
Development checks may expose explicit holes and diagnostics; final acceptance
requires a complete source project, original theorem/type comparison, permitted
transitive axioms and kernel replay. Internal services and Mathlib remain
available; private answers and external network remain unavailable.

## Readiness

Record four distinct results: initial compilation, root/foundation identity,
private complete witness under the same public dependencies, and visibility
checks. The witness is submitted helper source, never an extra trusted proof
library. Bind its final receipt to the target, public context and checker lock.
No formal run starts without all gates. Resource failures and incomplete
validation remain explicit; source failure is not evidence of an impossible
problem. The current focus is obtaining this evidence for Q20.

The new profile is an input/submission variant, not the previous
`proof_dag_cut_v1` benchmark. Preserve earlier reports without relabeling their
results. See [primary-source research](02-research.md); current implementation
is documented in [run configuration](../../architecture/07-run-configuration.md).
