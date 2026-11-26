# Dynamic Lead–Worker real-model acceptance

[Issue #235](https://github.com/LuNa-shi/murm/issues/235) · [PR #251](https://github.com/LuNa-shi/murm/pull/251) · [Approved design](https://github.com/LuNa-shi/murm/blob/396289a59e8f3ce16acccea989a68ad8b0b6a3d5/docs/phases/0005-core-harness/06-lead-worker-dynamic.md)

## Registration

EXP-20261126-01 runs `orders-a`. EXP-20261126-02 repeats the same test with `orders-b`, new Run identity, Gitea facility, Agent identities and dynamic service. Both start from an external install of the archive built from `0ec6770e46614071633ab4798d662d2b0dfc3ec0`. Its SHA-256 is `4fea98e62c28b0bde0b7f8564af5af700babc68a3c9d4214f2d27743b07cc6d1`. The previous scripted native acceptance is the infrastructure baseline.

The model is `gpt_proxy/gpt-6.1-sol`. The Worker image is `sha256:dd52c55a450765f1b34820eaf269ab6f617bf16372f63515f9ee81f887bf7f26`. The checking Service uses `sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`. The gate records the prompt, task specification and oracle digests from the installed bytes before starting each Run. The user requested this model and real run. The batch uses the existing gateway allowance, with at most 150 upstream requests and 614,400 requested output tokens across the two Runs. The gateway account's existing limits apply. The gateway does not report a monetary cap or charge to this test.

Each Run allows 4 Agents, 1 generated Service, 1 CPU and 1 GiB per Worker, and a 64 MiB/4,096 inode workspace quota. Work is limited to 15 minutes per variant, upstream requests to 90 seconds, and the external cleanup budget to 80 seconds. The model gate admits at most 75 attempts per Run and requests at most 4,096 output tokens per attempt. The experiment ends at verified submission or a recorded failure, deadline or budget limit. The host collects authenticated operations, checker adoption, fixed-commit oracle results, offline replay and resource cleanup for each Run.

## Results

| Attempt | Run ID | Real model responses | Result | Cleanup |
| --- | --- | --- | --- | --- |
| EXP-20261126-01 / orders-a | `orders-3e634354128a7a` | 35 completed of 36 admitted | Both original Workers claimed separate tasks. The generated Service exited before readiness and the deployment slot retained its failed outcome. Operator stopped the Run after diagnosing the failure. | Three Agents, checking container, owned Git identities and test facility closed. |
| EXP-20261126-02 / orders-b | `orders-b5dcf545fba1ce` | 8 completed of 10 admitted | Both original Workers claimed separate tasks. Operator stopped the Run once the same launch defect was confirmed. | Three Agents, owned Git identities and test facility closed. |

The provider reported 549,737 input and 4,435 output tokens on completed requests. Three admitted requests interrupted during shutdown have unknown usage. Neither attempt reached a final submission or offline replay.

## Analysis

The acceptance launcher inherited `umask 077`. The first Service source was mounted as `0400`, which the checking container's UID could not read. A diagnostic run of the same syntax-valid bytes stayed up with readable permissions. The no-key installed-package test reproduced deployment failure under the same mask. Both original Workers in the first Run requested the task contract, which was sent to the Lead and missing from the original starter tree.

## Next steps

Use explicit read-only bind-mount modes for the generated Service and the candidate oracle. Seed the public specification and selected sample so Workers can find them after the Lead assigns work. Retest from a newly pinned package, retaining these attempts in the record.
