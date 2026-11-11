# Experiment workflow

> Type: Workflow · Status: Active · Updated: 2026-11-11

**Two activities must be kept separate.** Implementation testing checks whether code matches an **already approved** contract. Research experiments investigate a **human-approved** hypothesis or exploratory question. Human review is needed to choose which research questions are worth pursuing, not after each debug iteration.

## A. Implementation checks and diagnostic probes

Coding Agents may run tests, controlled failure reproductions, and small diagnostic probes without a new approval **when they remain within the assigned behavior, environment and explicitly authorized cost/time limits**.

- Iterate: inspect the implementation, form a *debugging explanation* for a mismatch, fix it, test again, and collect evidence.
- Record enough input/version and output information to reproduce consequential failures and final checks; ordinary debugging does not require an `EXP-YYYYMMDD-NN` registration.
- Do not send a standalone report after every test or probe. Summarize the results at milestones, completion or when an out-of-scope decision is needed.
- If a diagnostic suggests a new research idea, propose the idea and its potential value to the human owner. **Do not launch a research investigation of that new hypothesis until it is approved.**
- Tool calls or paid probes are only authorized if their spending and other limits were explicitly delegated; ordinary permission to edit code does not authorize unbounded model usage.

## B. Approved research experiments

### 1. Approve the question and limits

The human phase owner approves the hypothesis's value/priority, research objective, allowable implementation and experimental variables, provider/model/fixture, budget and stop rules. A phase may approve several controlled repetitions or an exploratory matrix, but the Agent cannot independently redefine the research question.

### 2. Register formal runs

Assign `EXP-YYYYMMDD-NN` (UTC; allocated in [the index](../experiments/INDEX.md)) before each formal run. Freeze the clean implementation commit, comparison, fixture/Lean/Mathlib, model/provider, prompt/schema/profile identities, Core/timebox/budget, measurements and success/failure criteria. A repeated run has a new ID and links to its predecessor.

Registering a run does **not** mean the human must approve every execution or receive a report immediately. Runs inside the approved matrix and budget may proceed autonomously. A changed research hypothesis, unapproved variable or budget requires new approval.

### 3. Execute and analyze

Keep raw Agent logs, Workspace state, credentials and proof/candidate contents in ignored local `experiments/`. Preserve Task/Execution/Session/Core/Material/Judge IDs and their source/revision links. Do not silently replace an unavailable model, checker or fixture; mark the run BLOCKED or explicitly register a changed run.

Use [experiment-analysis](../../.codex/skills/experiment-analysis/SKILL.md) and the [report template](../experiments/TEMPLATE.md) to summarize observed results, explain what the evidence supports (including competing explanations), and identify uncertainties. A missing record is unknown, not zero. Separate mathematical success, protocol validity, and useful downstream collaboration. Activity counts alone do not demonstrate progress.

### 4. Human decision and follow-up

The Agent may investigate implementation failures and rerun within the **same approved** experiment plan. At a meaningful conclusion, provide a consolidated evidence-backed assessment and suggested next steps. Only the human owner decides whether to adopt a new hypothesis, change the experiment's purpose, revise the architecture or close the research phase.

Do not retroactively present a historical run as preregistered or revise thresholds after seeing the outcomes. Update the [experiment index](../experiments/INDEX.md) and [status snapshot](../STATUS.md) only with grounded claims.
