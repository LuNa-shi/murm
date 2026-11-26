# Dynamic Lead–Worker time-bounded acceptance

[Issue #235](https://github.com/LuNa-shi/murm/issues/235) · [PR #251](https://github.com/LuNa-shi/murm/pull/251) · [Previous attempts](EXP-20261126-03-04-lead-worker-dynamic.md)

## Registration

EXP-20261126-05 runs `orders-a`. EXP-20261126-06 uses the same procedure and candidate with `orders-b`, a new Run and fresh facilities. Both install the archive for `cbcb790f1273b327f0ae565b5dac4ca13a394390` outside the checkout. The archive SHA-256 is `6b086760894ec16f18f60a4bdd3d57d3a91ad4d32e7d6f00a7ca2f462a29078e`. This candidate directs verification of fixed commits in disposable archive trees. The host test driver accepts an omitted request cap and still checks that each Agent received a real completion. The task, oracle, tests for collaboration and deployed package remain fixed across the pair.

The owner directed the use of `gpt_proxy/gpt-6.1-sol` and a time bound in place of the previous request-count policy. Each Run has a 15-minute work deadline and at most four Agents and one generated Service. The Worker and checking image IDs and CPU, memory, workspace, per-response output, transport and cleanup settings match the previous registration. The model gateway uses the existing account, with no configured aggregate request or total token cap for these two Runs. Request counts and observed usage are recorded from the provider receipts. Each Run stops at trusted completion, failure or deadline. The host evaluates the full dynamic collaboration, independent final program and physical cleanup criteria separately.

## Results

| Attempt | Run ID | Provider admissions | Disposition |
| --- | --- | ---: | --- |
| EXP-20261126-05 / orders-a | `orders-0100a9a3613f3e` | 33 | Operator stopped the active Run when the owner selected a ProgramBench workload. The Lead completed Service deployment, Profile registration and checker admission. |
| EXP-20261126-06 / orders-b | `orders-0d16ea4e2fb9c0` | 0 | The sequential driver began setup. The operator stopped it before model requests. |

Both Runs reported complete cleanup and the physical Worker inventory was empty. The first attempt recorded 29 completed responses with 268,716 input and 7,155 output tokens. Four interrupted streams have unknown usage. Neither Run submitted a final candidate.

## Analysis

The installed example configuration and evidence pin had no request ceiling. The task change ended this batch before the deadline. These attempts add no L3 pass.

## Next steps

Use the ProgramBench Pastel instance already pinned for Issue #209. Review the workload change through the Phase 0005 design PR before starting new real-model acceptance. Keep these order attempts as version-bound evidence.
