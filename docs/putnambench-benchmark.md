# PutnamBench 4-core benchmark

The benchmark protocol is defined in [ADR 0008](adr/0008-putnambench-four-core-project-benchmark.md). This document covers
operational setup and report handling. Each formalized problem is an isolated project. A project
owns one SQLite database, one root Task, four child proof Tasks, four private
Runtime Workspaces, four Pi session directories, and one redacted report.
Agents share the problem statement and later feedback through Context Service
Materials. They do not share private Workspace files or session state.

The locked configuration in
[`config/putnambench-12.json`](../config/putnambench-12.json) contains twelve
recent B-part formalizations from PutnamBench commit
`a635813f5edf297d928f9bd5ef8324a26bdde09c`. The runner reads only the pinned
formalization source. It rejects a source path that looks like a solution or
candidate file and requires the formalization to retain its `sorry` theorem
placeholder. No known candidate is part of the benchmark input.

Build the pinned Lean project before launching real agents:

```sh
cd /path/to/PutnamBench/lean4
lake build
```

Run one four-core pilot with a private report directory:

```sh
node scripts/run-putnambench-benchmark.mjs \\
  --problems config/putnambench-12.json \\
  --putnambench-root /path/to/PutnamBench \\
  --problem putnam_2025_b1 \\
  --cores 4 \\
  --timebox-ms 3600000 \\
  --project-parallelism 1 \\
  --report-dir /tmp/swarmenv-putnambench-pilot
```

Run the full selection in bounded project groups:

```sh
node scripts/run-putnambench-benchmark.mjs \\
  --problems config/putnambench-12.json \\
  --putnambench-root /path/to/PutnamBench \\
  --cores 4 \\
  --timebox-ms 3600000 \\
  --project-parallelism 3 \\
  --report-dir /tmp/swarmenv-putnambench-rerun
```

`--putnambench-root` is the checkout root containing `lean4/`. The runner
requires a NuRouter/Pi model through `--model` or `NUROUTER_PI_MODEL`; the
provider defaults to `NUROUTER_PI_PROVIDER` or `openai`. Each project runs to
its timebox unless the library caller explicitly enables early stop after a
verified solution. Each project has an independent deadline and cleanup path.
A failed project is recorded and does not cancel its siblings.

Benchmark Agent Cores run with only the `swarmenv_call` extension. Pi built-in
tools, skills, prompt templates, and context files are disabled. The report
records tool event names and hashes, but never writes raw Pi transcripts,
candidate contents, or proof text to the repository. A candidate containing
`sorry`, `admit`, or `axiom`, or any non-SwarmEnv tool event, invalidates the
project and cannot count as a solution.

Reports contain source and input hashes, Task/Execution IDs and states,
Material and candidate counts, Judge verdict classes, turn/error counts,
version information, isolation facts, and audit flags. The report directory
should remain private because project SQLite databases and Pi sessions are
retained for post-run audit.
