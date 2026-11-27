---
title: murm 文档总览
description: 用 TypeScript SDK 构建多智能体系统，复用隔离执行、协作 Service、运行观察与产物收集。
section: 快速开始
order: 0
---

`murm` 是一个用于构建多智能体系统的 TypeScript SDK。你在 **Harness** 中定义角色、共享状态、任务分配与完成条件；**Runtime** 负责 Agent 会话、隔离工作区、Service 访问、运行记录与清理。

同一套 Runtime 可以承载由 Lead 委派子任务的团队、从任务池认领工作的 Worker，也可以承载通过共享资料库交换成果的对等 Agent。改变协作机制时，主要修改 Harness 和它组合的 Services，从而在一致的执行基础设施上开发、运行和比较不同方案。

## 从一次完整运行开始

按照 [快速上手](quickstart.md) 运行 TypeScript Messages 交接示例：writer 通过 Service 发布一个值，reader 读取它并写入文件，宿主程序核对导出文件的字节并保存收尾报告。这个例子同时展示 SDK 调用、可观察的协作过程和结果验收。

如果运行环境已经准备好，可以直接选择下一步：

| 你想完成什么 | 从这里开始 |
| --- | --- |
| 在自己的 TypeScript 程序中使用 murm | [使用 SDK](sdk.md) |
| 理解一次 Run 中发生了什么 | [murm 如何工作](concepts.md) |
| 设计自己的协作机制 | [构建你自己的 Harness](build-your-harness.md) |
| 运行或改造已有多智能体系统 | [Harness 总览](harnesses/index.md) |
| 理解组件职责与数据流 | [系统架构](architecture.md) |

## 一个包，明确的公开入口

SDK 的包名是 `@murm/core`。下面是同一个包中的导入路径：

公开值和类型统一从 `@murm/core` 导入。使用 `createSandbox` 设置 OpenSandbox，使用 `createRuntime` 管理 Agent、Service、文件与清理。当前包通过 checkout 或 `npm pack` tarball 安装。详见 [SDK 指南](sdk.md)。

## 理解不同的协作机制

仓库中的五种 Harness 采用了不同的协作规则：

| Harness | 如何组织工作 | 适合研究的机制 |
| --- | --- | --- |
| [Subagents](harnesses/subagents.md) | Root 递归委派子 Agent，配合上下文分叉与邮箱投递 | 任务分解、父子所有权、用户中途转向 |
| [TaskPool](harnesses/taskpool.md) | Worker 独占认领带租约的 Task，发布 Material 与工作区 revision | 持久化任务分配和执行者更替 |
| [PeerMesh](harnesses/peermesh.md) | 对等工程师通过 Board、Mattermost 与 Gitea PR 协作 | 软认领、直接讨论和经过验证的合入 |
| [Substrate](harnesses/substrate.md) | 对等成员发布、搜索、阅读并引用不可变成果 | 通过成果积累形成协作 |
| [Lead-Worker](harnesses/lead-worker.md) | Lead 提供方向，Worker 返回认领、代码变更和反馈 | Lead 所有权与明确的反馈条件 |

每个示例都有自己的业务规则和验收方式。[横向对比](harnesses/index.md) 解释它们的差异，SDK 则提供共同的执行控制接口。

## 查阅具体契约

[API 参考](reference/api.md) 包含方法签名、输入回执、运行观察、文件控制、Service 调用与配置。[Run 生命周期](run-lifecycle.md) 解释操作何时被接纳、执行何时收束、资源何时完成清理。[类型与源码映射](reference/types.md) 将这些契约对应到实现。

当前 OpenSandbox 后端运行在 Linux 与同宿主机的 rootful Docker 上，支持 Pi 和 Codex，两者的具体能力有所区别。Run 目录包含提示词、模型与 Service 调用轨迹、原生会话和导出文件，应保存在私有存储中。相关运行边界和凭证流向见 [系统架构](architecture.md)。

网站直接使用 `docs/en/` 与 `docs/zh/` 中的中英文指南。[仓库实现手册](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/INDEX.md) 进一步解释底层执行路径、生成的协议参考和提示词组合方式。
