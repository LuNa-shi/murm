---
title: 核心概念
description: 2 分钟看懂 murm 的六个核心构件，以及一次多智能体运行是如何串联起来的。
section: 快速开始
order: 2
---

用 `murm` 搭建多智能体系统，你只需要理解上面这幅图里的 **6 个核心构件**，以及它们怎样配合你的 **Harness** 工作。

## 六大核心构件一览

| 构件 | 一句话说明 | 深入阅读 |
| --- | --- | --- |
| **Sandbox（隔离沙箱）** | 基于开源 OpenSandbox 为每个 Agent 分配独立容器、私有工作区与资源上限，互相不会误改文件。 | [Sandbox 隔离沙箱](sandbox.md) |
| **Runtime（运行控制面）** | 一次运行的总控对象（`createRuntime()`）。管理容器、读写文件快照、推送运行事件，并在结束时归档清理。 | [Runtime 运行控制面](runtime.md) |
| **Agent 与 Profile** | **Profile** 是角色模板（提示词、模型、镜像、权限）；**Agent** 是按模板启动的持久化会话，干完一轮会保留上下文，随时可继续对话。 | [Agent 与 Profile](agents.md) |
| **Host Gateway（宿主机网关）** | 沙箱通往外部世界的唯一可信通道：代理模型请求（API 密钥留在宿主机），并核验每次 Service 调用的身份、权限与参数格式。 | [Host Gateway 宿主机网关](gateway.md) |
| **Services（协作服务）** | 跑在宿主机（或外部 HTTP 后端）上的共享能力，例如黑板、任务池、Git 或验证器。Agent A 写入，Agent B 读取，就能跨容器协作。 | [Services 与权限](services.md) |
| **Trace Viewer（观测与调试）** | 自动记录模型请求、工具调用、Service 交互和导出文件；执行 `murm trace` 即可在浏览器泳道图里缩放回放。 | [观测与调试](trace-viewer.md) |

而运行在宿主机上的 **Harness**，就是**你编写的编排程序**：它定义角色 Profile、注册需要用到的 Services、启动并调度各个 Agent，最后验收结果并结束运行。

## 一次运行从开始到结束发生了什么？

以一个多人协作研究任务为例，整个过程非常直观：

1. **搭好舞台**：你的 Harness 准备好沙箱配置、角色 Profile 和共享 Services（比如一块共享笔记黑板），调用 `createRuntime()` 启动本次运行。
2. **拉起成员并派活**：调用 `runtime.spawn()` 启动多个处于独立沙箱中的 Agent，再用 `runtime.send()` 发送任务。Agent 启动后是空闲的，只有你发任务才会开始推理。
3. **跨沙箱自主协作**：执行中，每个 Agent 在自己沙箱里用本地文件/Shell 工具干活；需要共享成果或发消息时，通过容器内的 `swarm` CLI 调用宿主机 Services，所有请求经由 Host Gateway 验明正身后再把结果返回给它。
4. **监控、验收与归档收尾**：你的 Harness 通过 `runtime.onEvent()` 感知执行进度，按规则决定是否继续追问或唤醒其他成员。达到目标后调用 `runtime.close()`，Runtime 会先归档所有日志、会话与产出文件，确认保存完毕后再销毁容器；随后用 `murm trace` 即可回放全过程。

---

**下一步**：从第一个构件开始，按顺序逐一掌握每个模块——**[Sandbox 隔离沙箱](sandbox.md)**。
