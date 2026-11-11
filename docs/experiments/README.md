# Experiment records

An experiment is one registered run inside a human-approved Stage. The primary
record is a readable report with separate Truth, Assessment and Decision
sections. Raw conversations, candidate/proof source, credentials and private
state remain in ignored local evidence directories.

## Canonical ID

New experiments use:

```text
EXP-YYYYMMDD-NN
```

The date is UTC. `NN` is the next non-reused sequence for that UTC date. The
sequence is allocated before the run in [`INDEX.md`](INDEX.md). A rerun receives
a new ID and links to the earlier run with `repeat_of` or `comparison_to`.

The ID does not encode Issue, model, result or implementation commit. Those
belong in the registration metadata. Existing directories such as
`issue-113-2h-20261104-r12-finalization` are historical IDs and are not renamed
by this convention.

## Required report sections

1. Run card and evidence boundary
2. Truth: immutable inputs, environment and observed outcome
3. Input surface: prompt, Task/Execution entry, tools, services, Workspace
4. Process: Task windows, Execution windows, Material/feedback windows and
   Judge sequence
5. Assessment: causal hypotheses, alternatives, confidence and unknowns
6. Decision: what the Stage owner should do next
7. Evidence index and privacy limitations

Use [`report-template.md`](report-template.md). The current
`experiment-analysis` skill supplies useful evidence joins, but its output is a
draft appendix rather than the Stage decision.
