# 阶段 01：Sandbox、独立 Services 与 Bash CLI

> 来源与批准入口：[Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119)。本页是前置阶段的范围索引，不替代 Issue，不增加新的业务验收要求。
>
> 截至本设计基线 `008ecdb9ab64adcd8135042ff2160ec1db704952`，以下目标尚未完成第三方 sandbox 集成；不得从本页存在推断它们已经实现。

## 本阶段交付的基础

Agent 的 Pi、NuRouter、扩展、Bash 和本地子进程整体运行在第三方 sandbox。Task、Context、Judge 及启用的领域服务分别拥有外部 API、持久状态和独立重启生命周期。Bot 用 Pi 的 read/write/edit/bash 操作同一私有工作面，通过 Bash 调用统一 `swarm` CLI；不再为每个业务动作注册一个裸模型工具。

每个新 Execution 使用新 sandbox、新 Pi 和干净的私有工作副本。同 Task 再认领、同 Core 补位、异常后重启均适用。跨 Execution 的研究接续只通过已发布 Material；原始项目输入可以初始化，旧私有目录、会话、工具历史不得默认带入。审计存档保存在外部，但不开放给后继 Bot 作为研究输入。

服务接收的长期操作保存输入和请求后，由服务继续负责。CLI 断开或 sandbox 销毁不默认撤销已接受的工作；结果留存、取消与预算遵循该操作的合同。本阶段不要求新建通用作业平台。

## 接入门槛

Issue #119 推荐先验证固定版本 OpenSandbox 的 Docker 后端，重点检查 Pi 双向通信、服务网络可达性、独立持久卷、服务授权、调用幂等和可靠回收。它是候选方案，不是已通过的部署承诺。

阶段 02 对“同一 Pi 在 take 前只读、take 后可写”提出更具体的权限要求。目录权限控制需要可信进程身份，管理接口必须不能被 Bot 绕过；原始发布版本的现成 API 不等于完整保证。该需求的源码依据和真实集成门槛见 [阶段 02 运行模型](0002-task-material-workspace/01-model-and-runtime.md)。接入提供方与最小安全配置需固定版本并验证；不把扩大自研 sandbox 平台作为默认解法。

## 与阶段 02 的边界

| 阶段 01 提供 | 阶段 02 使用和补充 |
|---|---|
| 新 sandbox、新 Pi、独立工作卷、进程回收 | 有限 Bot、同一 Pi 先读后写、take/release 的业务语义 |
| 独立 Task / Context / Judge API 与 CLI | 删除 Mission Task 特例、Task 选择和排他认领规则 |
| Material 持久内容与明确发布的传输路径 | 材料复用、研究交接、质疑与纠错策略 |
| 外部身份、终态拒写、可靠请求和清理 | Workspace 主线、候选检查与条件合入 |
| 实际工具/help/prompt 与观测接入 | 完整初始行为协议、按需 skills 和协作评估 |

新增主动 release、未完成退出策略、自动发布策略和 Workspace 主线业务不追溯变成 #119 的隐藏前置条件。本阶段也不凭借容器创建成功或 HTTP 200 宣告交付；以 #119 的端到端验收和批准范围为准。

阶段 02 的 Workspace 主线版本必须以 Material 公开并记录来源，因此不会通过“共享 main”的名称重新引入旧 Execution 私有文件继承。见 [Workspace 方案](0002-task-material-workspace/03-workspace-and-integration.md)。
