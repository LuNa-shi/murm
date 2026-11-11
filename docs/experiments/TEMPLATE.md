# EXP-YYYYMMDD-NN：<简短标题>

Status: REGISTERED / RUNNING / COMPLETE / BLOCKED / INCONCLUSIVE
所属阶段：<已批准阶段说明>
Experiment ID: <运行前在 INDEX 分配>
Repeat of / comparison to: <可选>

## 0. 预注册记录（运行前冻结）

| 输入 | 固定值 / 证据 |
|---|---|
| 实现 commit、clean 状态和文档版本 | |
| 目的、主要假设、实验类型 | |
| Baseline 与 Treatment（或探索边界） | |
| 唯一主要改变变量及不可改变内容 | |
| Fixture/Problem、Lean、Mathlib、输入 hash | |
| Provider/model、Prompt/profile/tool schema hash | |
| Core、预算、timebox、实际命令 | |
| 主判据、反证、未触发时如何判断 | |
| 证据和隐私存储位置 | |

## 1. Overview（运行事实）

实际开始/结束、输入偏离、协议与清理状态、任务与执行、Material 与 Judge、最终目标是否完成及成本。来自权威元数据和日志；没有记录就写 `unknown`，不要将推断写作事实。

## 2. Input surface 和 Process

概括每项 Execution 可见的 Task、Prompt/工具、Workspace 和 Material。使用 Task → Execution → Material/Feedback → Candidate/Judge 的时间窗，说明目标、行动、即时结果和下一步动作。区分共享 Mission 并发与独立 Task 分工。

## 3. 分析判断

对每条主要判断列出证据链接、替代原因、置信度、反证机会，分别检查实现/契约、工具与环境、Agent 选择、实验设计、研究假设。读取 Material 不代表采用，Judge FAIL 不代表系统失效。

## 4. 下一步建议和负责人决定

AI 的建议：<可验证的下一问题、最小变量变化和停止规则>

阶段负责人决定：<未审阅 / 已批准的继续或变更 / 关闭，姓名和日期>

尚未审批的建议不得写成已批准的下一轮实验。

## 5. 证据与隐私限制

列出固定提交、相对事件/行 ID、缺失数据库、无对照或不可见成本等。禁止提交原始对话、候选/证明源码、凭据、stdout/stderr 和私人绝对路径。
