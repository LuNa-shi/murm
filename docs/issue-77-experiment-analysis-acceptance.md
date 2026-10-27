# Issue #77 experiment-analysis skill acceptance

## Implementation

- Issue: #77
- Worktree: `codex/issue-77-experiment-analysis`
- Implementation commits: `0256f77`, `db9fbd5`, and final skill-contract commit
  `9e8d3b817bca6a14222cff78d8d6a70c5ae8cfe0`.
- Scope: Codex skill instructions, evidence map, report template, testing guidance,
  and a documentation contract test. Runtime, Controller, Core Daemon, Task,
  Material, Workspace, and Judge implementations were not changed.

## Real experiment used

- Experiment: `exp-20261027-issue70-b1-2h-c96a92d`
- Source worktree: Issue #70 task-admission worktree
- Executed implementation commit: `c96a92d14592e035415283120f9a19dabb155984`
- Route: `openai-codex / gpt-6.1-sol`
- Configuration: four Cores, two-hour timebox
- Run status: completed, solved count 0, invalid count 0

The raw experiment was copied into two independent temporary review directories.
Their existing analysis files were removed before review. Each reviewer received
only the final skill, its references, and one raw evidence copy. Neither reviewer
ran the previous npm analyzer or read the other reviewer's report.

## Independent reviewer results

Reviewer A and Reviewer B both produced a report with:

- the evidence gate and explicit diagnostic-only status;
- Orchestration, Coordination, Execution, and Tool contract answers;
- Task and Material windows;
- one bounded four-field record for every one of the 28 durable Executions;
- relative evidence references and no raw transcript, proof/candidate source,
  credentials, stdout/stderr, or unrestricted private paths.

Both reviewers independently reached the following result:

- normal selection, claim, Runtime bind, child admission, Material, and checker
  paths are demonstrated;
- child Task contracts and several child/rework checks close at child scope;
- the final root handoff remains one-way, with the root Task still OPEN and no
  root candidate acceptance;
- the final root Execution is trapped by stale fencing and repeated
  FENCED/NOT_ALLOWED responses;
- no systemic Tool contract failure is established;
- exact Controller/Daemon reconcile and wake ordering is unknown because the
  supplied copy does not contain the configured Observation database or a
  standalone Controller/Daemon stream.

The reports are therefore useful diagnostic analyses, not complete control-plane
acceptance evidence.

The committed, sanitized reviewer results are:

- [Reviewer A result](issue-77-experiment-analysis-review-a.md), generated from
  isolated local artifact `issue77-final-a-20261027`;
- [Reviewer B result](issue-77-experiment-analysis-review-b.md), generated from
  isolated local artifact `issue77-final-b-20261027`.

The full local reports were retained outside the repository during acceptance;
the committed files preserve their conclusions without raw evidence.

## Validation

- `node --test test/experiment-analysis-skill.test.js test/experiment-analysis.test.js`
- `npm test`
- `git diff --check`

Direct skill invocation for a fresh context:

```text
Use .codex/skills/experiment-analysis/SKILL.md.
Analyze the experiment directory:
experiments/exp-20261027-issue70-b1-2h-c96a92d/
```

The reviewer reports and raw experiment copies remain outside the repository.
