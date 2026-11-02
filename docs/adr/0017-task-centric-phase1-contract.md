# ADR 0017：以一致的Task-centric规范指导第一阶段修复

- Date: 2026-11-02
- Status: Proposed（本PR合并时依据审阅接受）

## 背景

主入口、旧ADR与领域草案同时描述父子树、扁平任务和不同Judge流程，编码者可能根据不同文件实现不相容的行为。Notion中的目标和后续用户修正尚未成为仓库中的统一规范。

## 决定

核心约束直接保存在根AGENTS.md，术语只在GLOSSARY.md定义，目标运行方式只由docs/architecture.md展开。实现状态、证据复盘和Issue草案分开。旧设计正文保留原blob归档，原链接只导航，历史实验不改写。

第一阶段聚焦三个完整闭环：工具式Judge迭代、自主持续任务供给、反馈与研究接续。四个 Core 默认对应四个可工作的 Agent identity；每个 Agent 在开始独立工作前先登记 Task，可自己认领或留在队列。Execution 限时，Progress Material 负责 checkpoint/handoff，compaction 上限触发 identity 轮换，文件工作通过 Git Workspace lineage 接续。各代码Issue通过自身匹配两小时真实运行和必要回归；文档PR不冒充行为修复。

## 取舍

少量完整Issue使每次改动能够单独验证，但范围比横向API任务更大，需在Issue内分步测试和审阅。显式区分目标与现状增加一份状态表，却避免文档领先于代码时误导使用者。保留历史跳转增加少量导航文件，但保护原有链接和设计来源。

## 后果

#107中的重试门禁持久化要求不能继续直接执行；待正式整理时保留服务一致性与准入等问题，移除门禁要求。此PR不修改GitHub Issue状态。未来策略变化先明确更新规范，不以实现细节反向定义领域模型。具体接口和实现必须与[Agent Task运行契约](../20261102-agent-task-runtime-contract.md)保持一致；不支持 Git Workspace 的部署组合不能作为目标实现启动。
