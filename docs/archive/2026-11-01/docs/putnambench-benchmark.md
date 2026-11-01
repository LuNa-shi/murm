# PutnamBench benchmark

一个问题对应一个隔离项目目录、一个 SQLite 数据库、一个 Root Task 和最多四个可复用 Agent Core slot。项目开始时不创建固定 proof child。Agent 通过 Task list 发现工作并主动创建所需的子 Task。

题目文件来自锁定的 PutnamBench checkout。题目和 Lean/Mathlib/checker 元数据写入 Root Workspace；答案和 solution-derived input 不进入初始化 Workspace。Context Service 只保存运行中产生的 Material。

实验报告保存项目 hash、Task/Execution/Workspace lineage、Judge verdict、版本、计时和审计分类。原始 evidence 留在实验目录，报告不输出 candidate source、proof text、raw transcript、stdout 或 stderr。
