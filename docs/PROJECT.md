# SwarmEnv：研究定位

> Type: Research context · Status: Active discussion · Updated: 2026-11-11

SwarmEnv 是用于研究多智能体自主协作的实验系统。Agent 能够在一个共同目标下形成独立责任，产生可追溯的局部成果，并由后续 Agent 检查、接续、修正或整合。

## 当前研究问题

1. Agent 在什么条件下会提出真正有用的独立工作，而不是不断重复共同目标？
2. 局部 Material 被发布、读取后，能否成为下一次工作的输入，形成可验证的下游行动？
3. Judge 反馈或同伴纠错何时导致有意义的路线变化，而不是重复尝试？
4. 系统增加执行容量与计算预算时，能否提高可积累成果、质量或效率？怎样排除单纯活动数量增长造成的假象？

这些是待检验问题，不是确定的结论，也不授权添加特定 Prompt、调度器或数学套路。

## 当前试验环境

已有 PutnamBench、Lean/Mathlib 与四 Core 实验路径，用于验证系统机制。研究目标是可推广的 Swarm 协作机制；数学任务是当前测试载体，不应将题目特定的推理流程写死成通用架构。

具体模块见 [architecture/INDEX.md](architecture/INDEX.md)。已见证据和未知项见 [STATUS.md](STATUS.md)；下一阶段的假设和资源必须通过 [phases/INDEX.md](phases/INDEX.md) 对应的获批阶段说明确定。
