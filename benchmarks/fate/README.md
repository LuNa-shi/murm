# FATE Substrate benchmark

FATE is an explicit, separately configured benchmark. Its pinned model,
checker/toolchain dependencies and resource limits below do not apply to the
[ordinary project example](../../examples/substrate/README.md). The benchmark retains its own strict configuration.

## FATE publication and checking protocol

A configuration with `fate` selects `fate-run.ts` instead of the generic fixed-round runner. It adds the `fate` Service (`search_mathlib`, `check_lean`, `submit`) and uses `benchmarks/fate/paper-substrate.ts` for publication. Publish requests contain `sub_task`, `artifact`, `rationale` and `refs`; visits take an `addresses` array; retrieval combines normalized BM25 with citation weights. The generic example uses `content`, `references` and a single `address` with a simpler ranking rule. Inspect `swarm service view substrate` in the run you started before composing a request.

## FATE-M with K3

The FATE-M configuration uses the dedicated FATE entry. It freezes problem 1, gives each of four peers the original Lean and natural-language statements, and independently checks every final submission. Shared library, private library and no library are the three conditions. Each group starts after its peers are ready and runs for at most 30 minutes. No host request count, token or cost quota is imposed on K3. The task Service still limits each peer to ten working Lean checks.

The host needs Linux with Bubblewrap, `prlimit`, Git, the pinned Lean 4.28.0 toolchain and the frozen FATE-M workspace with compiled dependencies. Keep the project and toolchain controlled by the host and outside agent directories. The pinned upstream preparation commands are:

```sh
git clone https://github.com/frenzymath/FATE-M.git fate-m
git -C fate-m checkout --detach 4eb33c8ccd0ff058b461cd763cc406509129743f
elan toolchain install leanprover/lean4:v4.28.0
(cd fate-m && lake exe cache get)
```

From a consumer directory containing the installed murm tarball, set `MURM_FATE_PROJECT` to that workspace and `MURM_FATE_LEAN` to the installed Lean toolchain directory. Set `MURM_SUBSTRATE_RUN` to a fresh ID, `MURM_SUBSTRATE_IMAGE` to the reviewed worker image, and `MURM_SUBSTRATE_MODEL_URL` and `MURM_SUBSTRATE_MODEL_TOKEN` to the approved K3 endpoint and credential. The model URL includes its Responses route. Optional lifecycle settings are listed in the ordinary project example. `MURM_SUBSTRATE_OUTPUT` defaults to `./experiments/substrate-fate`.

```sh
example=node_modules/@luna-shi/murm/dist/benchmarks/fate
node "$example/main.js" --fate-prepare "$MURM_FATE_PROJECT" "$MURM_FATE_LEAN"
node "$example/main.js" --fate-matrix "$example/fate-config.js"
node "$example/main.js" --fate-rescore "$MURM_FATE_PROJECT" "$MURM_FATE_LEAN" \
  "./experiments/substrate-fate/${MURM_SUBSTRATE_RUN}-shared/fate-frozen-candidates.json"
```

For a single condition, set `MURM_FATE_MODE` to `shared`, `private` or `none`, then pass the configuration file directly. The matrix uses an independent directory for each condition, in that order, and stops launching groups if a prior group's cleanup is pending. A run ID cannot overwrite earlier evidence. Preparation and rescoring make no model calls. Formal runs require the repository's frozen experiment registration.

`fate-result.json` records task/peer state, score, end reasons, model usage, Core Trace and cleanup, and points to the frozen candidate bundle. A final candidate is a Lean term such as a `by` proof, with any helper lemmas declared locally inside the proof. Sources, candidate contents, peer journals and raw tool results are private run evidence. See the [architecture chapter](../../docs/architecture/19-substrate-harness.md#fate-paper-alignment-configurations) for the current checker, publication and scoring contracts. Experiment reports pin the implementation and evidence for a particular run.

## FATE-H with K3

The shipped FATE configuration selects `kimi_proxy/k3`. An explicit host configuration can also set the selected `models` entry to `provider: 'gpt_proxy', model: 'gpt-6.1-sol'` and supply that provider's Responses URL and host credential.

Set `MURM_FATE_BENCHMARK=FATE-H` and `MURM_FATE_PROJECT` to the prepared workspace for FATE-H #2. Freeze [FATE-H at `17967b3`](https://github.com/frenzymath/FATE-H/tree/17967b3118082adfba7c5a5fc03b5f4a53717b59) and run `lake exe cache get` in that workspace. It uses the same Lean 4.28.0 and dependency source revisions as FATE-M. Pass `FATE-H` after the project and toolchain paths in `--fate-prepare`. A frozen bundle selects its own benchmark during rescoring, and the supplied project must match it.

```sh
export MURM_FATE_BENCHMARK=FATE-H
node "$example/main.js" --fate-prepare "$MURM_FATE_PROJECT" "$MURM_FATE_LEAN" FATE-H
node "$example/main.js" --fate-matrix "$example/fate-config.js"
```

This configuration gives four peers up to 45 minutes of work and samples progress after 30 minutes. `fate-work-checkpoint.json` is host-only and records timestamps, peer state, candidate digests and tool/substrate evidence if the group is still working. If the group ends early, `fate-result.json` records `not_reached` and its actual closeout. Checkpoint capture does not send a wake or change the work deadline.

## FATE-X #31

Prepare [FATE-X at `a6fb49e`](https://github.com/frenzymath/FATE-X/tree/a6fb49ee85fd05bb8ce9fc66e1c66797b5a0592d) with `lake exe cache get`. It uses the same Lean 4.28.0 and Mathlib revision. Point `MURM_FATE_PROJECT` at that workspace, then select FATE-X in the launcher and preparation steps. The checker uses the full original `Problem31.UFD_of_ge_5` declaration with its local definitions. The default work window is 30 minutes.

```sh
export MURM_FATE_BENCHMARK=FATE-X
node "$example/main.js" --fate-prepare "$MURM_FATE_PROJECT" "$MURM_FATE_LEAN" FATE-X
node "$example/main.js" --fate-run "$example/fate-config.js"
```

A host configuration can set `fate.verifiedCompletion: true` for a sustained attempt. The first task input tells the peer its work window. To finish early, the peer must first get `passed` from `check_lean` on the exact proof it submits. After an unfinished natural reply, the host continues the same Session only while its remaining Service and Lean-check allowances still permit a verified submission. A peer with an already checked proof can use its last Service operation to submit the same bytes.
