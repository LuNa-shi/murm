---
title: 文档总览
description: 了解 murm 解决什么问题、文档如何按六大核心构件组织，以及从哪里开始上手。
section: 快速开始
order: 0
---

**`murm`**（`@luna-shi/murm`）是一个本地优先的多智能体框架，用来构建、隔离运行并回放多智能体协作系统。

它把**多智能体协作规则**与**底层隔离运行**拆成两层：

- **你编写 Harness**——定义团队角色、共享协作服务（Services）以及协作流转规则。
- **murm 提供运行底座**——负责每个 Agent 的隔离容器（Sandbox）、运行控制面（Runtime）、宿主机鉴权网关（Host Gateway），以及内置浏览器轨迹查看器（Trace Viewer）。

TypeScript SDK、宿主机 `murm` CLI、容器内 `swarm` CLI 与 `murm trace` 全部打包在同一个 `@luna-shi/murm` 安装包中。

## 文档结构一览

文档完全按照首页心智模型的 **6 个核心构件** 逐篇展开，最后通过一个多智能体 Swarm 实战串联起来：

1. **快速开始**：[快速上手](quickstart.md)（安装并跑通第一次运行）→ [核心概念](concepts.md)（一张图看懂全局）。
2. **核心构件与实战**：
   - [Sandbox 隔离沙箱](sandbox.md)——每个 Agent 的独立容器、配额与工作区边界。
   - [Runtime 运行控制面](runtime.md)——集群配置、文件快照同步、事件监控、动态管理与安全收尾。
   - [Agent 与 Profile](agents.md)——角色定义、持久化会话、发消息、中断与对账。
   - [Host Gateway 宿主机网关](gateway.md)——Service 鉴权校验与模型密钥隔离。
   - [Services 与权限](services.md)——为什么不用本地 Tools 做协作、如何接入业务类或外部 HTTP 服务、静态与动态授权。
   - [观测与调试（Trace Viewer）](trace-viewer.md)——内嵌真实可缩放泳道图，回放模型调用、协作交接与导出文件。
   - [实战：构建 Swarm Harness](build-your-harness.md)——亲手搭一个并行调研 + 综合的多智能体 Swarm。
3. **内置 Harness**：[选择 Harness](harnesses/index.md)——直接运行或参考 `Subagents`、`TaskPool`、`PeerMesh`、`Substrate` 与 `Lead-Worker`。
4. **参考手册与版本**：[SDK 与 API 参考](reference/api.md) · [CLI 参考](reference/cli.md) · [类型定义与源码映射](reference/types.md) · [最新版本 (v0.2.0)](latest.md) · [更新日志](changelog.md)。

> 需要查阅底层协议或仓库维护说明？请参阅仓库中的[架构实现手册](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/INDEX.md)。
