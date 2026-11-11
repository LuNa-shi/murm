# `EXP-YYYYMMDD-NN`: `<short title>`

Status: `REGISTERED | RUNNING | COMPLETE | BLOCKED | INCONCLUSIVE`

所属阶段：`<阶段说明链接>`

Legacy ID: `<optional historical name>`

## 1. Run card and evidence boundary

| Field | Value |
|---|---|
| Canonical experiment ID | |
| Code commit and clean state | |
| Architecture/document baseline | |
| Fixture/problem and input hash | |
| Provider/model | |
| Prompt/profile/tool schema hashes | |
| Core/resource/timebox | |
| Started/ended | |
| Evidence sources | |

State what is present, what is external, and what is unavailable. Missing
evidence is `unknown`, not zero.

## 2. Overview

Record only facts supported by metadata, authoritative state, Runtime/Service
events, Workspace manifests and Judge records. Include the final protocol,
mathematical and cleanup outcomes separately.

## 3. Input surface

Describe what each Execution received: Task contract, initial context, prompt
layers, capability profile, service documentation, Workspace contract and
available Material. Include hashes or stable references instead of private
payloads.

## 4. Process

### Task windows

For each Task: proposal/admission, claims, responsibility, outputs,
consumers, completion/block state and unresolved lineage.

### Execution windows

For each meaningful window: target, action, immediate result and next effect.
Keep Session, Execution, Core and Workspace identities separate.

### Feedback and Judge

Show candidate identity/content binding, CheckResult, feedback read, subsequent
route change and any notification delivery/handling receipt.

## 5. 分析判断

Separate these hypotheses:

- implementation/contract defect;
- provider/tool/environment failure;
- Agent action or research strategy;
- experiment design or confound;
- architecture/hypothesis failure.

For each claim list evidence, alternative explanations, confidence and what
would falsify it. Do not infer hidden reasoning from prose.

## 6. 下一步决定和实验

由人类阶段负责人记录决定。下一次实验必须写明一个主要假设、一个变化变量和预先登记的停止规则。

## 7. Privacy and limitations

List redactions, external databases, missing events, unknown costs and any
comparison that was not paired. Never publish credentials, raw conversations,
proof/candidate source or unrestricted private paths.
