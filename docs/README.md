# 文档索引

## 当前设计入口

[AGENTS](../AGENTS.md)给出项目约束，[GLOSSARY](../GLOSSARY.md)定义术语，[当前架构目录](architecture/README.md)解释最新main的模块边界，[运行契约](20261102-agent-task-runtime-contract.md)规定共同Mission、主动Task、Progress/Git和identity轮换。根目录的 `architecture.md` 是第一阶段目标架构历史入口，不与当前实现说明混用。

[当前架构目录](architecture/README.md)按模块解释最新main的实现边界。[实现状态](implementation-status.md)如实区分要求与代码。[固定基线复盘](reviews/task-centric-baseline.md)保留原版本证据，[符合性审计](reviews/phase-1-conformance-audit.md)将确定问题分配给后续修复，不定义第二套规范。

## 第一阶段计划与验收

[三个Issue草案](plans/phase-1/README.md)按完整行为组织。[两小时协议](validation/phase-1-acceptance.md)规定匹配与判定，[逐项行为表](validation/20261102-phase-1-behavior-acceptance.md)连接每项实现、可观察结果、反例和证据。不得只以总利用率或单次演示验收全部功能。

## Stage、实验和历史

[Stage协作规范](stages/README.md)规定人类阶段负责人和AI执行者的边界。[Stage Charter模板](stages/stage-charter-template.md)规定每个大阶段要先拍板的内容。[实验规范](experiments/README.md)规定规范Experiment ID、Truth/Assessment/Decision报告和证据边界。以[R16示例](experiments/EXP-20261111-01-r16-example.md)查看一份完整的可读报告。

## 开发、运行和历史

开发使用[workflow](agents/workflow.md)、[testing](agents/testing.md)、[issue-tracker](agents/issue-tracker.md)和[domain](agents/domain.md)。分析工具入口是[experiment-analysis skill](../.codex/skills/experiment-analysis/SKILL.md)。

[环境说明](benchmark-environment.md)、[观测说明](observability.md)、[内置服务](../services/builtin/README.md)和[Mathlib服务](../services/mathlib-search/README.md)描述当前运行工具，不覆盖新架构要求。新功能可用性以实现状态和实际提交核对。

[实验](experiments/)、旧Issue证据、research和examples保留历史/参考身份。[归档索引](archive/README.md)保存旧正文与映射，[ADR](adr/README.md)记录重要取舍。新建工程文档使用YYYYMMDD-标题短名.md；稳定入口保留原路径，既有历史不追溯重命名。
