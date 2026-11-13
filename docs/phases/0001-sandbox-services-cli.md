# 阶段 01：Sandbox、独立 Services 与 Bash CLI

> 来源与批准入口：[Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119)。本页是前置阶段的范围索引，不替代 Issue，不增加新的业务验收要求。
>
> 本次现状对照为 main [`e6f97bc0d56709f94374a5f824c8e2cd9c312cb2`](https://github.com/LuNa-shi/SwarmEnv/commit/e6f97bc0d56709f94374a5f824c8e2cd9c312cb2)。该版本已包含 OpenSandbox provider / worker、独立服务部署和 Bash CLI 的实现切片；这不等于本页全部生命周期目标或真实环境验收已完成。原设计基线 `008ecdb9ab64adcd8135042ff2160ec1db704952` 的“尚未接入”只描述历史版本。

## 本阶段的目标基础

Agent 的 Pi、扩展、Bash 和本地子进程整体运行在第三方 sandbox。当前 OpenSandbox 接入使用 direct Pi，不要求 NuRouter；兼容部署若使用额外路由器，也须记录其实际版本与运行边界。Task、Context、Judge 及启用的领域服务分别拥有外部 API、持久状态和独立重启生命周期。Bot 用 Pi 的 read/write/edit/bash 操作同一私有工作面，通过 Bash 调用统一 `swarm` CLI；不再为每个业务动作注册一个裸模型工具。

每个新 Bot 使用新 sandbox/Pi，先经只读服务浏览项目；成功 take 后在同一环境的固定路径准备唯一 E 工作目录，一个 Bot 对应零或一个 E。Task 完成、handoff 或超时后销毁 Bot 环境；同 Task 再认领、同 Core 补位使用新 Bot。跨 E 通过公开 Task、Material 和 Workspace revision 接续，不带入旧私有目录、会话或工具历史。审计存档保存在外部，但不开放给后继 Bot 作为研究输入。

服务接收的长期操作保存输入和请求后，由服务继续负责。CLI 断开或 sandbox 销毁不默认撤销已接受的工作；结果留存、取消与预算遵循该操作的合同。本阶段不要求新建通用作业平台。

## 接入门槛

Issue #119 的当前实现已接入 OpenSandbox 及其 worker，并提供独立服务的部署入口。真实环境仍须固定版本、镜像和配置，验证 Docker 后端的 Pi 双向通信、服务网络可达性、独立持久卷、服务授权、调用幂等和可靠回收。具体实现与边界见 [执行](../architecture/02-execution.md)、[服务](../architecture/04-services.md) 和 [启动配置](../architecture/07-run-configuration.md)；文件存在或 mock 通过不代表这些部署条件已经验收。

最新 #119 的目标范围已纳入“同一 Pi 在 take 前只读、take 后可写”的运行合同，阶段 02 给出业务语义与具体授权顺序。当前按 E 创建 sandbox、复制输入和回收环境的接入，不能自动证明完整的 take 前 Bot 阅读期、固定路径授权和 finish 清理合同。目录权限控制需要可信进程身份，管理接口必须不能被 Bot 绕过；原始发布版本的现成 API 不等于完整保证。该需求的源码依据和真实集成门槛见 [阶段 02 运行模型](0002-task-material-workspace/01-model-and-runtime.md)。接入提供方与最小安全配置需固定版本并验证；不把扩大自研 sandbox 平台作为默认解法。

## 与阶段 02 的边界

| 阶段 01 提供 | 阶段 02 使用和补充 |
|---|---|
| 每 Bot 新 sandbox/Pi、take 前后权限、一个 Bot 最多一 E、进程回收 | Task/Material/Workspace 的业务规则和整套协作验收 |
| 独立 Task / Context / Judge API 与 CLI | 删除 Mission Task 特例、Task 选择和排他认领规则 |
| Material 持久内容与明确发布的传输路径 | 材料复用、研究交接、质疑与纠错策略 |
| 外部身份、终态拒写、可靠请求和清理 | Workspace 主线、候选检查与条件合入 |
| 实际工具/help/prompt 与观测接入 | 完整初始行为协议、按需 skills 和协作评估 |

#119 落实已确认的 Bot 生命周期和 task finish 对环境的终止作用；Task 动态依赖、Material 纠错、Workspace 合入和 Mission 提交政策由阶段 02 定义，不扩成无关接入能力的隐藏门槛。本阶段也不凭借容器创建成功或 HTTP 200 宣告交付；以 #119 的端到端验收和批准范围为准。

阶段 02 的项目文件直接保存为公开 Workspace revision，按 Workspace/revision/path 读取；Material 单独保存研究内容，不包装 Git main。未合入文件也通过普通 revision 接续，不开放前任私有目录。见 [Workspace 合同](0002-task-material-workspace/05-workspace.md)。
