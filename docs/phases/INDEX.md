# 人工控制的研究阶段

> Type: Research governance · Status: Active · Source: [ADR 0018](../adr/0018-human-controlled-phases-and-evidence-review.md)

阶段用于控制 **SwarmEnv 项目开发实验**，不等于运行时 Agent 的 Mission 或 Task。阶段负责人批准问题、核心假设/探索范围、允许改变的代码与实验变量、预算、停止条件，并指定独立 worktree。

AI 可以在批准范围内实现、修复合同内 Bug、做确定性测试、执行已获授权的实验、形成 Overview 与分析草稿。改变假设、验收标准、fixture、provider/model、预算、架构边界或对外承诺，应先提出范围变更，不能静默执行。

## 标准循环

1. 人类批准 [阶段说明模板](phase-template.md)。
2. AI 固定代码和文档基线，识别相关契约及待验证行为。
3. AI 在独立 worktree 开发；每次运行先登记 Experiment ID。
4. AI 给出可追溯事实与分析，再提交下一步建议。
5. 人类决定继续、修订、结束阶段，或开启新阶段。

一个阶段以主要研究问题为中心；探索阶段可明确声明多个候选探索，不应伪装成单变量因果证明。缺少已批准的阶段不代表 Coding Agent 可自行选择新的研究方向。

## 当前阶段

本次文档整理不创建/批准下一阶段，也不追溯把旧运行编入新的阶段记录。后续新增阶段说明在此索引并指定实际负责人、状态和 worktree；目录中不存在一份默认批准的空白阶段。
