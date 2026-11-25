# Native acceptance evidence boundary

The shipped package contains the ordinary TaskPool, PeerMesh, Notes, Subagents, Substrate and lead/helper entry points and their controlled conformance tests. It no longer contains the experiment-only hour matrix, timed model meter, hour scheduling/verification modules, Subagents hour entry/configuration/artifact verifier, or their dedicated runner fixtures. There is no hour-run CLI or matrix factory to configure. The ordinary staged Subagents and lead/helper interfaces remain host-programmable business workflows; they neither implement an hour scheduler nor declare long-run acceptance.

## Retained original evidence

Phase Harness §10.2 requires each acceptance record to retain its actual prompts, Profile/manifest versions, model configuration, input provenance, Service operations, results and cleanup evidence. Removing an experimental runner does not alter or rerun those records. The authoritative five-run record remains [Issue #185](https://github.com/LuNa-shi/SwarmEnv/issues/185), with per-attempt receipts and independent checks. The original source remains available at these exact Git commits:

| Original direction | Exact original source | Existing evidence |
| --- | --- | --- |
| PeerMesh, eight Agents | `7643cf195d013797b222f4c273c0d7c88efd04d0` | [Original PeerMesh record](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7124839747) |
| Lead/helper, four Agents | `30c3035e9d96af1b711d07ca637d74d3bd3e39f2` | [Original Lead/helper record](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7126614478) |
| Substrate, six Agents | `47b33a965f1f2a1c4df2707953612482d0ee3256` | [Original Substrate record](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7126892228) |
| TaskPool, four concurrent Agents and one replacement | Core `7643cf195d013797b222f4c273c0d7c88efd04d0`; host `e3880641427dbc13ed4eb4628fe85da70f145565` | [Original TaskPool record](https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7127873712) |
| Subagents, one parent and three children | `7ac891bb707bd4e4a97b84693fb750d4bbf7cf85` | Five-run closeout in [Issue #185](https://github.com/LuNa-shi/SwarmEnv/issues/185) |

These are version-bound original proofs, not acceptance runs of subsequent code changes. Raw receipts, private databases, model conversations and source/stdout artifacts remain in the original ignored evidence locations; this manual copies none of them. TaskPool's original proof used fixed public host revisions with live capture disabled. The maintainer-operated Q8 installation/use gate remains distinct from these five model runs.

## Supported workflows and verification

Ordinary [PeerMesh](18-peermesh-harness.md), [Substrate](19-substrate-harness.md), [lead/helper](20-lead-worker-harness.md), [Subagents and reporting](17-harness-reporting.md) and [TaskPool](02-execution.md) retain their existing authority, stable requests, explicit input routing, staged work, failure handling and required export/cleanup contracts. Generic native lifecycle diagnostics, test-support tools and scoped third-party notices remain. The source inventory and generated prompt references cover only code present in this tree.

Lead's optional staged checker response now uses the domain-neutral fixed rejection code `STAGE_CANDIDATE_REJECTED`, with the existing nonempty correction instruction and original absolute deadline. Strict `true` accepts; an exception, malformed response or any other rejection code remains fail-closed. It retains the original completed Board task and immutable Git commit before admitting the same helper's fresh correction. This removes the deleted experiment verifier's label without changing stage capacity, permissions, input identity or deadline policy.

The offline package-containment regression installs the actual package outside the checkout, checks that removed runner paths are absent, and imports preserved ordinary and staged modules without allocating resources. Controlled Core/Bridge/CLI regressions retain the ordinary staged correction and explicit negative cases. These local checks establish distribution and behavior boundaries, not new native or model acceptance. Any future real experiment needs its own frozen source, package/image, host recipe, independent review and retained evidence; checking out an old harness alone does not bind its relative imports to a newer package.
