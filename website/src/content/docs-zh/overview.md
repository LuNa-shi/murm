---
title: murm 文档总览
description: 本地优先的 TypeScript 多智能体运行时，为你提供隔离沙箱、可定制共享 Services 与完整的运行轨迹归档。
section: 快速开始
order: 0
---

`murm` 将**多智能体协作逻辑**与**底层执行基础设施**彻底解耦。

你只需编写 **Harness**——用普通的 TypeScript 规则与控制循环定义角色分工、共享能力以及 Agent 之间的交接方式。`murm` 提供 **Runtime**，负责在隔离 Docker **沙箱（Sandbox）** 中运行每一个 Agent，在宿主机强制执行权限与密钥边界，路由所有 **Service** 调用，并将整次运行自动记录为持久化的 **Run** 归档。

借助 `murm`，你可以在软件工程、形式化数学与开放式科研探索中快速构建并对比不同多智能体系统——无需为每种协作拓扑重写容器隔离、会话保持、模型网关或日志追踪。

## 开始使用 murm

第一次接触 `murm`？从 [快速上手](../quickstart/) 开始，构建一次通用 Worker 镜像，跑通你的第一个双 Agent 交接示例并检视归档目录。

如果本地环境已经准备就绪，可以按需直达：

- 阅读 [核心心智模型](../concepts/)，理解 Harness 如何操控 Runtime 沙盘中的隔离沙箱、可定制共享 Services、外部网关与 Trace 记录。
- 阅读 [系统架构与边界](../architecture/)，跟进宿主机进程、OpenSandbox 容器、Service Bridge 与 Model Gateway 之间的精确信任边界。
- 阅读 [一次运行的完整脉络](../run-lifecycle/)，沿着一个具体双 Agent 协作案例完整走通 `spawn`、统一 `send`、受控文件交接、安全 `interrupt` 与“先归档再销毁”的 `close`。

## 构建你自己的 Harness

尝试全新协作拓扑时，你无需修改 Runtime 或重新制作 Worker 镜像。`murm` 中的每一个多智能体系统都只依赖相同的三个公共包入口：

```ts
import { createRuntime } from '@murm/core';
import { ServiceRegistry, createInProcessAdapter } from '@murm/core/services';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
```

跟随 [构建你自己的 Harness](../build-your-harness/)，注册自定义 Service、配置冻结的角色 Profile、选择宿主控制循环，并用独立错误上报机制完成安全收尾。

## 探索五种内置 Harness

仓库中基于同一套 Runtime 实现了五种截然不同的多智能体拓扑：

| Harness | 协作模式 | 适用场景 |
| --- | --- | --- |
| [Subagents](../harnesses/subagents/) | `/root` 递归命名委派、上下文分叉（Context Fork）、非唤醒邮箱 | 交互式任务、动态拆解与中途用户转向 |
| [TaskPool](../harnesses/taskpool/) | 独占租约任务认领、不可变 Material、版本化 Workspace `main` | 长时运行任务池，支持 Worker 超时轮换补位 |
| [PeerMesh](../harnesses/peermesh/) | 对等工程师通过软认领 Board、Mattermost 群聊/私信与宿主验证 Gitea PR 协作 | 扁平化工程团队在个人 Git 分支上并行开发 |
| [Substrate](../harnesses/substrate/) | 对等成员围绕单一 SQLite 不可变库发布、检索、阅读并引用 | 零任务队列的并行科研探索与定理证明搜索 |
| [Lead-Worker](../harnesses/lead-worker/) | 分阶段方向定调与反馈闭环，结合 SQLite 事务认领与 Git SHA-256 校验 | 明确由 Lead 定调且强制采纳一线反馈的团队 |

参见 [五种协作拓扑总览](../harnesses/) 查看完整横向对比。

## 查阅参考文档

- [API 与配置参考](../reference/api/) —— Runtime 方法、统一 `send` 语义、受控文件原语、Service v2 协议、`swarm` CLI、前台宿主 CLI、后端配置与错误码。
- [类型定义与源码映射](../reference/types/) —— `@murm/core` `0.2.0` 的完整公共 TypeScript 声明及仓库源码直链。
- [站点部署指南](../reference/deploy/) —— 本地预览及 GitHub Pages / Cloudflare Pages 静态发布步骤。

## 安全与数据边界

所有 Agent 的命令执行与文件修改都限制在独立 Docker 容器中，并受显式磁盘配额与 IPv4 网络白名单约束。上游模型 API 密钥、OpenSandbox 生命周期凭证及外部服务管理员令牌只保留在宿主机侧的 Model Gateway 与 Service Bridge 中，绝不进入容器。

Core 会对追踪日志中的已注册凭证执行自动脱敏，但落盘目录（`outputDir/<runtimeId>/`）仍会包含提示词、工具输出、原生会话与导出文件，请妥善保存在私有本地存储中。
