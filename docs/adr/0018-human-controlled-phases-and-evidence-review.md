# ADR 0018: 人工控制阶段与证据审阅

- Status: Accepted for documentation workflow
- Date: 2026-11-11

## Context

The project accumulated many implementation commits and experiment reports,
but the work unit, tested hypothesis and evidence boundary were often implicit.
An Agent could produce a plausible trace analysis and immediately widen the
implementation without a human decision about the next question.

## Decision

使用人类批准的阶段说明作为一个worktree的控制点。阶段负责人选择主要假设、允许变更、对照、验收条件和停止规则。阶段内每次运行都使用规范的`EXP-YYYYMMDD-NN`并在运行前登记。

AI可以在阶段说明范围内实现和修复缺陷、运行测试和实验、起草报告。假设、架构边界、输入/模型/资源配置或验收条件发生变化时，必须由人类决定。

实验报告分开写Overview（运行事实和过程概况）、分析判断和下一步决定。experiment-analysis skill负责证据关联和分析草稿，不是因果结论的权威。

## Consequences

项目获得架构、实现和证据之间的稳定连接。需要新假设时，迭代可能变慢，但一串提交不能再在没有明确问题和可审阅结果的情况下冒充进展。历史实验保持历史身份，不按新ID或新报告格式改写。
