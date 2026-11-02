# 文档草稿：审阅范围与验证限制

日期：2026-11-02。基线为`75fca5aa647154a642d676c639c8770d1f7eb90a`。只变更Markdown文档和分析skill文字，不修改运行代码、配置、测试、锁文件或历史实验内容。

## 已核对的内容

通过GitHub连接器读取固定基线与生成后的Git树，核对运行代码、scripts、配置、fixtures、tests、package文件和历史实验目录的Git对象未变。归档复用原blob/tree，保存当时正文；原路径改为导航。报告模板与证据地图的原文另存于`docs/archive/2026-11-01/.codex/skills/experiment-analysis/references/`。

分别进行Spec与Standards自审：核心约束直接进入AGENTS；Notion目标/复盘重组为仓库Markdown；只规划三个第一阶段完整代码Issue；每项具有符合性范围、两小时真实现象、失败条件与保护要求。用户补充的全面准则核对纳入P11及23项初步核对表。

检查目标、现状、证据与待批准阈值是否分开，默认行为是否仍有隐含模板，Judge/反馈/接续的描述是否一致。新增审阅确认四 Core/Agent identity、主动 Task 登记/认领、Progress Material、compaction identity 轮换和 Git Workspace lineage，并写入[Agent Task运行契约](../20261102-agent-task-runtime-contract.md)。分析skill与两个引用文件同步采用Task主线，保留现有四个诊断问题及隐私要求。

## 限制与未执行项

容器执行git远程读取时无法解析github.com，未取得完整checkout。文档通过Git数据接口在固定父提交上发布。没有运行完整npm test，也没有完整checkout上的git diff --check；不能将文档阅读与Git对象核对表述为这些命令已通过。

未启动真实Agent、Lean或两小时实验，没有运行收益数据。未调用独立子Agent，Spec/Standards为分开自审，不是外部独立评审。代码核对为静态审计初稿，尚未逐条执行反例，不宣称全仓库已经穷尽。文档更新后已运行 `git diff --check` 和受跟踪 Markdown 相对链接检查；没有运行 `npm test`，因为本 PR 仍未修改运行代码。

归档的历史相对链接保留原状，可通过原提交恢复上下文。当前文档链接需在可用checkout中再次做自动完整校验；外部链接未作全站可用性测试。PR保持Draft，等待设计及数值门槛审阅。
