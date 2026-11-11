# ADR 0017：共同 Mission 与 Task-centric 分工

- Status: Recorded design decision; original phase-one proposal archived in Git history. Current behavior and evidence must be checked against source and [STATUS](../STATUS.md).
- Origin: 2026-11-01 to 2026-11-05, PR #110 and related task-centric revisions.

## Context

早期父子审批树、扁平 Task 和 Judge 重试门禁同时存在，且固定任务路线与任务数量配额限制了自主分工。共同目标、独立责任、Execution 授权和 Session 容量一度混为一体。

## Decision

- Mission 表达共享研究目标；共享 Mission Task 允许多个独立 Execution。普通 Task 代表有明确交付边界的分工，通常只允许一个有效 Execution。
- Agent 决定是否登记独立工作，Runtime 管理物理资源；没有普通 Task 可认领时可以继续共同 Mission。
- 不设置任务数量配额；总预算、容量及超时仍可限制执行。Judge 是可迭代检查工具，局部 PASS 不替代共同目标完成。
- Progress Material 引用真实版本，文件通过 Execution 私有本地 Git 工作面保存，handoff 与 identity rotation 不得抹除已有成果；保存失败需明确记录实际损失。
- 具体注册/切换、检查、权限与接续行为以 [当前架构](../architecture/INDEX.md) 和对应源码为准。

## Consequences

降低中央审批与任务供给瓶颈，同时增加重复探索、分工与汇聚质量难以判断的风险。实验必须分开观察共享 Mission 并发、独立 Task 分工以及成果是否真正被接续。本 ADR 不再维护 S1–S3 的具体 Issue 清单、两小时验收门槛或旧实现状态。
