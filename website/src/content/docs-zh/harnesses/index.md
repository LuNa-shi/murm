---
title: 五种协作拓扑总览
description: 一套 murm Runtime 如何零修改驱动五种截然不同的多智能体 Harness——Subagents、TaskPool、PeerMesh、Substrate 与 Lead-Worker。
section: 内置 HARNESS
order: 6
---

`murm` 中的五种内置多智能体系统并不是硬编码在引擎里的“模式”，而是基于完全相同的 `@murm/core` Runtime API 编写的五个普通 TypeScript **Harness**。

切换协作方式只需要替换注册的 **Services** 与宿主**控制循环**——沙箱后端、Service Bridge、Model Gateway 和追踪归档保持完全一致。

> **仓库目录位置**：`Subagents` 位于 `examples/subagents/`；`TaskPool`（`src/harnesses/taskpool/`）、`PeerMesh`（`src/harnesses/peermesh/`）、`Substrate`（`src/harnesses/substrate/`）和 `Lead-Worker`（`src/harnesses/lead-worker/`）位于 `src/harnesses/`，并在 `examples/` 下配有可直接运行的示例。

## 横向架构对比

| Harness | 注册的 Services | 核心 Runtime 原语 | 宿主控制循环 | 交付物与验证方式 |
| --- | --- | --- | --- | --- |
| **[Subagents](./subagents/)** | `collaboration`（6 操作：`spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent`、`list_agents`） | `spawn(forkFrom)`、`send(wakeIfIdle: false)`、`interrupt(discardedInputHashes)`、可选共享 `workspace` | **事件 + 邮箱循环**：忙碌成员即时 `steer`，空闲成员暂存邮箱直到 `wait_agent` 或 `followup_task` | 共享工作区文件或回传给 `/root` 的消息载荷 |
| **[TaskPool](./taskpool/)** | `task`、`material`、`workspace`、可选 `judge` 与 `mission` | `writable: false` → `files.prepare` + `files.grant`、`modelAccessPolicy`、槽位补位 `stop`/`spawn` | **双轨事件 + 心跳协调**：`take` 触发文件交接；`settled` 续跑未完任务；定时器续租并替换超时 Worker | 不可变 Materials + 经验证合并的公共 Workspace `main` |
| **[PeerMesh](./peermesh/)** | `peermesh-context`（软认领 Board）、`message`（Mattermost）、`gitea` + 原生 `git` | `bindings`、`network.allow`、`secretEnv`、`steer(steeringMode: 'all')`、`collect(includeGit: true)` | **每成员串行 Router**：拉取群聊/PR 事件、注入 Board 视图、途中 `steer` 私信与更新、定时空闲提醒 | 个人 Git 分支 + 经宿主验证合入受保护 `main` 的 PR |
| **[Substrate](./substrate/)** | SQLite `substrate`（`publish`、`search`、`visit`） | `spawn(files)`、`runInput` 串行轮次、逐个 `stop()` | **并行固定轮次**：零队列、零路由——`Promise.all` 驱动对等成员完成 `maxRounds` 轮探索，支持 `onCycle` 纠偏钩子 | 内容寻址不可变记录（`content:<sha256>`）+ 阅读审计表 |
| **[Lead-Worker](./lead-worker/)** | SQLite `board`（定调、指派、事务认领、反馈）+ `gitea` | 固定团队 `spawn`、非对称角色 Profile、`bindings`、`secretEnv`、`collect(includeGit: true)` | **交替分阶段编排**：Lead 发布方向 → Worker 并行认领交付提交并反馈 → Lead 修订方向 → 原 Worker 执行下一轮 | 实时向 Gitea 核验的分支提交（SHA、路径、字节、SHA-256）+ 因果阅读门控 |

## 同一个冲突，五种不同策略

区分哪些逻辑属于 Harness（而非 Runtime）的最快方式，就是问一句：**“当两个 Agent 同时盯上同一件事时会发生什么？”**

- **TaskPool** 在 `task` Service 内部用数据库租约与 `fencing_version` 做硬互斥——只有胜出的 Execution 能拿到 `files.grant()` 写权限与有效 `modelAccessPolicy` 许可。
- **PeerMesh** 将 Board 上的 `CLAIM` 视为可重叠的软意向，由成员自己在 Mattermost 频道和私信里协商分工。
- **Lead-Worker** 在 SQLite `BEGIN IMMEDIATE` 事务中用 `expected_revision` 乐观锁绑定唯一永久 `owner`，认领永不过期也不自动改派。
- **Substrate** 干脆取消“认领”概念——对等成员自由并发探索，靠不可变发布与显式引用自然收敛。
- **Subagents** 在 `spawn_agent` 委派时划分职责，若途中发现重叠，由 `/root` 用 `send_message` 或 `interrupt_agent` 实时调整。

## 选择你的起点

| 如果你需要…… | 建议从这里开始 |
| --- | --- |
| 递归委派、上下文分叉、交互式用户转向与邮箱缓冲 | **[Subagents](./subagents/)** |
| 长时任务池、Worker 自动轮换、租约门控与版本化 `main` | **[TaskPool](./taskpool/)** |
| 扁平工程团队通过聊天频道、软认领看板和 Git PR 协作 | **[PeerMesh](./peermesh/)** |
| 围绕不可变引文库的开放式并行科研或定理证明搜索 | **[Substrate](./substrate/)** |
| 明确的 Lead 方向控制、强制反馈阅读门控与字节级 Git 校验 | **[Lead-Worker](./lead-worker/)** |
| 先看一个最小双 Agent 参考再从零定制自己的 Harness | **[构建你自己的 Harness](../build-your-harness/)** |
