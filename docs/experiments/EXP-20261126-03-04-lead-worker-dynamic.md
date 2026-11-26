# Dynamic Lead–Worker real-model recovery

[Issue #235](https://github.com/LuNa-shi/murm/issues/235) · [PR #251](https://github.com/LuNa-shi/murm/pull/251) · [Initial attempts](EXP-20261126-01-02-lead-worker-dynamic.md)

## Registration

EXP-20261126-03 repeats EXP-20261126-01 with `orders-a`. EXP-20261126-04 repeats EXP-20261126-02 with `orders-b`. Each starts with a new Gitea facility, Run, team and checking Service. Both install the same archive built from `df459980f33132051ff0bbc4c0e8281b27542681`, SHA-256 `fca2e84d8f89e1ad9d28121080bfc63891fe2cf868c7ff7c3434fd7575c522e2`, outside the repository. This revision fixes read-only mount access under `umask 077` and makes the public specification and sample available in the initial Git project. The independent oracle is unchanged. Both attempts use the restrictive umask that reproduced the failure.

The provider, GPT-6.1 Sol model, Pi Worker and checking images, Agent and Service counts, and per-container resource limits match the initial registration. The gate pins the digests of the installed oracle, specification and role prompts. The model gateway admits at most 52 requests per recovery Run and requests at most 4,096 output tokens per admission. With the 46 admissions from the initial pair, the upper bound remains 150 admissions and 614,400 requested output tokens. Unknown usage still counts toward admission. Only the existing account allowance is used. The two recovery work windows are limited to 12 minutes each. Upstream request and facility cleanup limits remain 90 and 80 seconds, respectively. The run terminates at verified submission, failure, deadline or effective budget limit.

The expected observations remain Lead-directed work, dynamic checking Service and member, original Worker authorization transitions, feedback applied in the final Git revision, independent evaluation and removal of owned resources. The second run uses the same candidate and a distinct public input variant. The host records both outcomes.

## Results

| Attempt | Run ID | Sustained progress | Missing at the request ceiling |
| --- | --- | --- | --- |
| EXP-20261126-03 / orders-a | `orders-b4a3028e595246` | Both original Workers delivered verified files. Lead deployed the Service, registered the Profile, admitted the checker, confirmed the original Worker was denied, and granted access. The checker completed its Git report and the Lead cited its feedback in a new direction. | Post-grant Worker call, revoke and fresh denial, adopted file in a final submission, independent oracle and offline replay. |
| EXP-20261126-04 / orders-b | `orders-59f24dca2f077e` | Both original Workers delivered verified files. Lead deployed the Service, registered the Profile, admitted the checker, confirmed the original Worker was denied, and granted access. The checker completed its Git report. The original Worker successfully called the Service at access version 1 and delivered the probe artifact. | Revoke and fresh denial, Lead-confirmed feedback adoption, final submission, independent oracle and offline replay. |

The host's independent Service probes passed valid input and duplicate plus malformed input in both Runs. The dynamic checker also issued its own successful calls with valid and mixed inputs. Each Run used 52 admissions and received 52 completed GPT-6.1 Sol responses before the gateway rejected further requests at its configured ceiling. The recovery pair used 1,423,637 input and 24,271 output tokens. Across the initial and recovery pairs, 150 requests were admitted and 147 completed. Observed usage is 1,973,374 input and 28,706 output tokens. Three interrupted requests from the initial pair have unknown usage.

Both original close receipts were pending after two Agents per Run left linked Git worktrees in their required exports. The operator later archived those four workspaces and verified deletion through the OpenSandbox lifecycle, removed both checking containers, revoked owned temporary Git credentials, prohibited login for all eight temporary accounts, and removed both Gitea test containers and networks. The retained workspaces and Git data are in private evidence storage. The original receipts remain pending in the result and the physical recovery has separate receipts.

## Analysis

The revised package resolved the Service deployment failure under the restrictive umask. Both Runs demonstrate dynamic member admission and business-level Git collaboration. One Run captured a Lead direction citing checker feedback. The other captured a successful post-grant call by the original Worker. The model reached the request ceiling in each case before revocation or an independently checked final Git submission.

The earlier checker prompt recommended a linked worktree as a way to test the frozen commit. It conflicted with required artifact collection, which rejects Git common-directory and other external dependencies. The pending state kept the Sandboxes, checking Service and Git facility available while exports were unresolved. Physical recovery was manual and supplies no evidence of automatic normal-path cleanup.

## Next steps

Use a disposable archive of the reviewed commit for scratch testing and keep the primary repository self-contained. The revised prompt also asks the Lead to confirm checker access after revocation. The next L3 batch requires an approved request allowance and two new Runs of the same final candidate. The four attempts above supply partial integration evidence and no L3 pass.
