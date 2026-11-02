---
name: experiment-analysis
description: Analyze a SwarmEnv experiment from local evidence, follow Task proposal, execution and updates, and evaluate the registered phase-one acceptance conditions.
---

# SwarmEnv experiment analysis

Read `AGENTS.md`, `docs/validation/phase-1-acceptance.md` and the originating Issue before judging acceptance. Write only `<experiment-directory>/analysis/experiment-analysis.md`; do not modify raw evidence. The report is Task-centric: trace why each relevant Task exists, its executions/materials, and feedback-driven changes. The four questions below are diagnostic lenses inside that account, not instructions to recreate a parent-child architecture.

## Evidence gate

Record implementation commit and clean state, fixture/environment, model/provider, prompt/config/schema identity, resource limits, timebox and actual start/end. Inspect raw Agent JSONL, Runtime/Service events, authoritative Task/Execution state and necessary Material/Workspace/Judge evidence. Missing sources are `unknown`, not zero activity. Mark incomplete comparisons `diagnostic-only` and identify the limitation.

Use schemas serialized in the run or source at its exact implementation commit; otherwise write `schema unavailable`. A source path never exercised in the run is `source-verified only`. Preserve stable IDs. Unmatched or reusable-Core records cannot be silently assigned to the newest Session. Never infer hidden model reasoning.

### 1. Orchestration question

Did a concrete Task pass through creation/admission, claim, Runtime binding and release/reopening using one authoritative identity? Explain broken transitions and competing causes. Separate effective Task execution from selection, waits, tool-only waiting and cleanup.

### 2. Coordination question

Build a **Task window** from proposal through all executions and updates, and a **Material window** from production through intended recipient, read, decision and subsequent work. A read alone proves neither reuse nor value. Distinguish self-checkpoints from cross-Task delivery, and preserve separate recipient decisions.

Historical labels such as `closed at child scope` only describe old run evidence. They do not prescribe current parent review. Under the task-centric model, delivery acceptance, producer completion and Mission success have distinct meanings. A real handoff differs from forced expiry without a Handoff Material.

### 3. Execution question

For each Task, reconstruct the durable Execution and Session identities in temporal order. Do not rewrite historical IDs or assume attempt_no is a Task-wide sequence. State predecessor/continuation evidence and unknown lineage. Within a meaningful work window summarize Target, Action, Immediate result and Next effect. Cite observed actions without exporting transcripts or proof/candidate source.

Check whether a successor uses earlier results rather than repeats work, and whether feedback is processed before terminal state. Preserve voluntary handoff, controlled process interruption, ordinary recovery and run-end cleanup as different causes.

### 4. Tool contract question

For every recorded request/response pair in the relevant evidence, compare request, service outcome, returned information and Agent reaction. Group normal calls compactly; list mismatches individually with expected result, actual result and operational effect. Keep checker infrastructure failures separate from mathematical source failures. Repeat checks require exact target/content/environment identity; replay or cache hits are not additional research iterations.

## Phase-one acceptance

Use the Issue's preregistered baseline and treatment, denominators, eligible events, minimum coverage, thresholds and guardrails. Report PASS/FAIL/INCONCLUSIVE/BLOCKED. Do not infer success from zero errors without exercised opportunities. Do not change thresholds after observing results, count filler tasks, count whitespace-only candidates, or equate delivered with processed.

Keep natural behavior and controlled interventions separate. Attach concise Task evidence chains for S1 checks, S2 task formation or S3 feedback/continuity as applicable. Report all runs and actual costs/unknowns; preserve mathematical outcomes separately. A paired single run demonstrates a case, not a universal effect.

## Privacy and output

Use relative evidence references and event/row IDs. Sources outside the experiment use `<external>/<basename>` with commit/database identity. Never publish credentials, authorization headers, raw conversations, hidden reasoning, proof source, candidate source, stdout/stderr or private absolute paths. Keep unknown links explicit. The historical report template remains usable as a set of diagnostic questions, but Task continuity and the current Issue's acceptance contract determine the current narrative.
