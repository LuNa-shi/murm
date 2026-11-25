# EXP-20261125-18 — ScaleMAS 30-minute GPT-6.1 Sol run

Status **REGISTERED** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202). Follows the [startup attempt](EXP-20261125-17-scalemas-gpt-comparison.md) and compares with the [observed K3 run](EXP-20261125-16-scalemas-intermediate-sharing.md).

## Setup

Run the same FATE-H #2 with four peers in shared mode. The owner requested switching from K3 to GPT-6.1 Sol. The prior GPT startup attempt allocated no Runtime and made no model request. This revision admits the exact approved GPT pair through the installed example. The shipped configuration still selects K3. The installed Runtime, FATE driver, Worker backend, startup renderer, Bridge, FATE services, substrate and checker modules used by the run were checked against the K3 package. Their compiled bytes match in the compared modules. [K3 setup and inherited frozen values](EXP-20261125-16-scalemas-intermediate-sharing.md#setup)

| Field | Frozen value |
| --- | --- |
| Implementation | `c468ce034b2747ee9fe934f0affa4a11476f4a5c`. Installed `@swarmenv/core@0.2.0` tarball SHA-256 `453a6b3308e35c1de6b9ec844c011531f2932e58dc1a7299edaee73be2e787ab`. |
| Model | Live `gpt_proxy/gpt-6.1-sol` via its configured Responses provider route. The authenticated model catalog listed the exact model. |
| Prompt SHA-256 | Model developer text `9ebdf19cc52e3625e14ed5ebd7a1ea1ac0bf0a98fb530618a5073fd430a58b83` and separate user input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`, both identical to the K3 run. |
| Launch | Launcher SHA-256 `800e17e49d9d0d3a2866c601ca63b4777f1939ccfaa2c67ae78e028fa5fe6e30`. GPT configuration SHA-256 `e15b7e3e02401a0dde01da655e219dcff917e39a56a4fc0dbf788ae4d2077ff0`. Inherited 30-minute wrapper SHA-256 `aaff234ff2fe2f61fe95809c483c73323f52499fb83a7153c18ea7f6874b2b00`. |
| Time and stop | Same 1,800-second work limit from readiness, passive 900-second checkpoint, ordinary earlier peer settlement and separate setup, scoring and cleanup bounds. |

Check all first requests and the actual provider response. Compare the first 17m37.200s with the K3 run and report the rest of the GPT interval separately. Record successful shared searches, repeat searches after an empty result, distinct publication receipts, cross-peer deliveries and substantive downstream use. An adoption claim requires the delivery evidence, the recipient's model context and the later proof work, with independent scoring reported separately. The selected model and its provider route differ. There is one observed group per model.
