# ADR 0018：人工控制阶段与证据审阅

- Status: Accepted for documentation / research workflow
- Date: 2026-11-11

## Context

工程提交和实验很多，但主要问题、允许变量和因果证据边界有时隐含在聊天和旧 Issue 里。Agent 在未形成可审阅结论前可能继续扩大修改范围。

## Decision

由人类负责人通过 [阶段说明](../phases/INDEX.md) 批准一个阶段的问题、假设或探索边界、工作树、修改权限、对照、预算与停止条件。AI 负责范围内实现、测试、运行和整理证据；改变主要假设、架构边界、fixture、provider/model、资源预算或验收条件必须重新由人类决定。

阶段内每次新运行使用 `EXP-YYYYMMDD-NN`，按 UTC 在运行前登记。报告以 **Overview（事实与过程概况）—分析判断—下一步建议/负责人决定** 组织。`experiment-analysis` Skill 负责证据关联与草稿，不能替代人的研究方向决定。

## Consequences

实验结果可追溯到具体提交、输入和批准范围。探索可能需要多个候选，但必须明确标记为探索而不是事后伪装的严格对照。历史运行不追溯改写成已预注册实验；本 ADR 也不改变运行时代码或自动证明系统已有益处。
