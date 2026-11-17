# Prove2Me and FLT subtree benchmark research

Research date: 2026-11-16. This document records primary-source findings and their implications for the owner-requested Q10–Q100 subtree variant. It is a design attachment, not evidence that the proposed generator or any checkpoint has passed. Requirements and approval remain in the linked GitHub Issue; the owning design links that Issue.

## Primary-source findings

### Prove2Me's task model

The correct name is **Prove2Me**. Its paper separates immutable theorem statements from proof submissions. A statement carries a preamble and ends in `by sorry`; a submitted proof must inhabit the same type. Missions audit their goal and required definitions, while Agents introduce intermediate lemmas. Proof-sketches can depend on open child statements, and only become complete when those children are proved. The paper also describes curated milestones and a reusable theorem corpus. Consequently, the owner-requested variant that reveals only one root and its required definitions deliberately supplies fewer structural hints than an ordinary curated Prove2Me mission. [Paper, sections 3–4](https://arxiv.org/html/2608.28433v2)

Prove2Me's public proof guide distinguishes `SKETCH_ACCEPTED` from `ACCEPTED`, rejects importing one's own target, and records dependencies on open children. It pins verification to the target's environment. This makes a useful distinction for SwarmEnv: compiling a revision that contains unresolved `sorry` is developmental feedback; it cannot establish Mission acceptance. [Proof guide at inspected revision](https://github.com/prove2me/prove2me_workspace/blob/79097e0d1fbab732ebf38ac23e7e5a700080c9c4/references/prove.md)

The existing-project upload guide recommends extracting an elaborated declaration graph with separate `typeDeps` and `valueDeps`, then retaining source context by deleting unselected declaration spans. It explicitly warns against regex-based splitting. Constructors, generated companions, private declarations and instances require special handling. A theorem used inside a definition must retain its actual proof: replacing it with a theorem stub would introduce `sorryAx` into consumers. These are extraction techniques, not a requirement to reproduce Prove2Me's server or task-selection protocol. [Upload guide](https://github.com/prove2me/prove2me_workspace/blob/79097e0d1fbab732ebf38ac23e7e5a700080c9c4/references/upload_full_project.md)

Two upstream scripts expose those facts: the declaration extractor reads types and values from the elaborated environment, while the source oracle re-elaborates a file to locate declaration/proof boundaries and constant-reference ranges. They are version-sensitive engineering inputs; compatibility must be tested with this fixture rather than assumed. [Declaration extractor](https://github.com/prove2me/prove2me_workspace/blob/79097e0d1fbab732ebf38ac23e7e5a700080c9c4/scripts/extract_decl_graph.lean), [source oracle](https://github.com/prove2me/prove2me_workspace/blob/79097e0d1fbab732ebf38ac23e7e5a700080c9c4/scripts/extract_sketch_info.lean)

### The released FLT artifact

The pinned FLT repository organizes definitions, theorem wrappers and proof implementations separately. Its verifier checks the final theorem against a Mathlib-only challenge and permits the three standard Lean axioms. The root FLT statement therefore admits a challenge with Mathlib and the elementary quantified formula, without exposing the intermediate theorem catalog. The official README reports that full-proof comparator replay took about 14h46m with roughly 230 GB peak memory, while some build modules needed up to 36 GB. Those measurements do not predict every subtree, but rule out assuming that the current short 4 GiB checking policy already accommodates a full Q100 witness. [Pinned README](https://github.com/anthropics/fermats-last-theorem/blob/aa2d8b34692b16c70f699536de0d8e75b9a3e9ef/README.md), [Mathlib-only challenge](https://github.com/anthropics/fermats-last-theorem/blob/aa2d8b34692b16c70f699536de0d8e75b9a3e9ef/verification/comparator/Challenge.lean), [verifier configuration](https://github.com/anthropics/fermats-last-theorem/blob/aa2d8b34692b16c70f699536de0d8e75b9a3e9ef/verification/comparator/config.json)

### Existing FLT10bench and the requested change

ContextSwarm's pinned FLT10bench removes a target's transitive proof-import cone while publishing the complete statement-level framework and module dependency metadata. It preserves safe definition modules, keeps the imports/statement fixed, and asks for replacement of one proof placeholder. The requested root-only Workspace variant changes both information exposure and permitted submission structure. Its results need a distinct profile/version rather than being reported as unchanged upstream benchmark results. [Pinned benchmark contract](https://github.com/nustarai/ContextSwarm/blob/3e529ef2cd337a1b829fe280c7360cb3dd95b35c/benchmarks/FLT10bench/README.md), [provenance](https://github.com/nustarai/ContextSwarm/blob/3e529ef2cd337a1b829fe280c7360cb3dd95b35c/benchmarks/FLT10bench/PROVENANCE.md)

## Recommended application to SwarmEnv

The following is engineering analysis for the owner's stated research goal. These recommendations are not claims that Prove2Me or current SwarmEnv already implements this variant.

### Define the task by its root and trusted statement foundation

For each checkpoint, extract the exact elaborated root type. Compute the project declarations needed to express that type, then include the complete implementations needed to make those declarations meaningful. Preserve required structures, their fields and constructors, notation, instances and necessary proof-valued fields. Iterate until the foundation and target compile in a clean projection with only approved public packages mounted.

A source file importing a proof module does not by itself prove that every declaration in that file needs that proof. Declaration-level extraction can retain a required definition while removing unrelated lemmas from the same file. Conversely, simply copying all `Definitions.*` files is too broad: a definition implementation can carry substantive proof dependencies. The generator should report that transitive foundation and must not hide a missing dependency behind a new assumption.

Do not apply the upstream upload guide's broad instance-root rule blindly to the entire FLT corpus: that rule targets faithful transplantation of a whole project. For this information-reduction benchmark, start from participating foundation modules, add the instances needed for elaboration, and prove the emitted result works. Retaining every project instance could reintroduce unrelated mathematical structure.

Do not replace required definition bodies with opaque constants, axioms or `sorry`. That changes the meaning or assumptions of the task. A checkpoint whose foundation requires a substantial proved result needs that fact explicitly included and counted as supplied context, or needs extraction work before it can be marked ready.

### Keep the original proof subtree operator-private

A mathematical proof is generally a DAG, not a literal tree: shared lemmas may serve multiple branches. Use the original value-dependency closure to build a private reference witness and provenance record. Do not publish that closure's internal node names, helper statements, source files, original import edges, milestone descriptions or generated graph to research Agents.

The initial public project should expose the target, its foundation, a neutral task description, and instructions for editing/checking a multi-file project. It should not expose the original module layout as a scaffold. Agents may invent their own definitions, intermediate statements and files; Task and Material retain the explanation and handoff roles of the existing framework.

### Distinguish four validation outcomes

1. **Initial compilation:** the exact public foundation and single root `sorry` compile. This validates syntax, elaboration and basic context availability only.
2. **Statement identity:** a trusted challenge confirms the root type and all definitions that give it meaning agree with the approved target. Renaming a helper or adding imports must not bypass this check.
3. **Constructive witness:** a private complete source project proves that root using the same foundation and public package allowlist. Its helper files are witness submissions, not extra trusted library dependencies. Clean compilation, axiom checking and the production final verifier must pass before calling a selected checkpoint runnable.
4. **Visibility and resource checks:** the public manifest, image, search responses and sandbox cannot expose private witness files, proof catalogs or previous runs. Resource/time failures remain explicit blockers; they cannot be converted into a proof PASS or silently resolved by increasing an approved budget.

The same witness can establish logical solvability while being far beyond a one-hour model run. Report those as different properties. The official Q100 resource figures make that distinction material: keep the generator capable of all ten tasks, but validate Q20 first under the owner's latest priority; Q100 validation is deferred. Do not claim that every full witness fits a checking policy until measured.

### Permit development and enforce complete final acceptance

Allow new Lean modules and imports among those modules. Partial revisions may contain explicit unresolved obligations for developmental checks, with their warnings visible. Final acceptance must rebuild a fixed source tree, reject unresolved assumptions, compare the root with its trusted challenge, and check its transitive proof. A helper that imports a `sorry` root cannot close that root: ordinary compile success is not sufficient, and any remaining `sorryAx` must reject.

Keep this behavior in the benchmark preparation and checking interfaces. The existing Core, Bot, Task, Execution, Material and Workspace coordination loop need not be replaced by Prove2Me's DAG-resolution server. Record the input profile, public manifest, foundation identity, checker identity and private witness verdict separately for every checkpoint.

## Source and evidence limits

The Prove2Me workspace revision inspected here is `79097e0d1fbab732ebf38ac23e7e5a700080c9c4`; its live guides may change. The FLT revision is `aa2d8b34692b16c70f699536de0d8e75b9a3e9ef`, and the existing ContextSwarm benchmark revision is `3e529ef2cd337a1b829fe280c7360cb3dd95b35c`. No Prove2Me account was created, no platform submissions were made, and no external proof service or paid model was invoked during this research. No reference proof body is reproduced here.
