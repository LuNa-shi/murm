# 文档索引

## 当前设计与实现

[AGENTS.md](../AGENTS.md)直接定义项目约束和核心设计准则。[GLOSSARY.md](../GLOSSARY.md)定义术语，[目标架构](architecture.md)说明完整运行流程。[Agent Task运行契约](20261102-agent-task-runtime-contract.md)记录四 Core、主动登记/认领、Progress Material、compaction 轮换和 Git Workspace 的已确认设计。[实现状态](implementation-status.md)单独记录实际能力，不能把文档目标误读成已经完成。

[架构复盘](reviews/task-centric-baseline.md)还原固定基线的任务轨迹；[第一阶段符合性核对表](reviews/phase-1-conformance-audit.md)按准则登记代码偏差、待复现风险与保留能力。核对范围不限于用户举例。

[第一阶段计划](plans/phase-1/README.md)只设三个完整代码sub-issues，[验收协议](validation/phase-1-acceptance.md)规定各自的匹配两小时真实运行与回归条件。数量/时延阈值均为待批准草案，不是默认运行参数。

## 开发与运行

开发入口：[workflow](agents/workflow.md)、[testing](agents/testing.md)、[issue-tracker](agents/issue-tracker.md)、[domain](agents/domain.md)。实验分析使用[experiment-analysis skill](../.codex/skills/experiment-analysis/SKILL.md)及其已同步的模板和证据地图。

[环境说明](benchmark-environment.md)、[观测说明](observability.md)、[内置服务](../services/builtin/README.md)、[Mathlib服务](../services/mathlib-search/README.md)描述当前工具用法，不覆盖目标规范；功能是否已支持需核对实现状态。

## 历史与设计决定

[归档索引](archive/README.md)保存旧设计原文，旧入口保留导航。[ADR索引](adr/README.md)说明新旧决定效力。[实验目录](experiments/)保持固定提交证据，历史结果不改写。原始人类材料见[documents说明](../documents/README.md)。

每条规则有一个权威定义。新建或新版本工程文档使用 `YYYYMMDD-标题短名.md`，例如 `20261102-agent-task-runtime-contract.md`；稳定入口文件保留原路径以避免破坏工具和链接，过时版本移入日期归档目录。旧issue笔记、research、examples与报告只作历史/参考，不与当前规范竞争。此次检查的范围与限制见[文档验证记录](reviews/documentation-draft-validation.md)。
