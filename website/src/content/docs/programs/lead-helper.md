---
title: Lead-helper · 方向与执行反馈闭环
description: 拆解 Lead-helper Program 如何用事务性 SQLite Board、因果读取门槛与 Git 分支验真，构建“定方向 → 执行反馈 → 调方向”的迭代闭环。
section: 内置协作 Program
order: 10
---

**Lead-helper** 用于“需要明确方向掌舵人、同时必须让一线执行中暴露的约束反哺下一轮决策”的团队场景。一位 **lead** 与 2–7 位 **helper** 围绕一块本地 SQLite **Board** 与各自的 Gitea 分支交替协作：方向变更必须显式引用已读的 helper 反馈，而 helper 的后续交付必须经过真实的 Git 提交与文件哈希验真。完整实现位于 [src/environments/lead-helper](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments/lead-helper)。

## 1. 这个 Program 注册了哪些 Service？

Lead-helper 注册了两个 Service，并在 Profile 中为 `lead` 和 `helper` 授予非对称权限（[board.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/board.ts)）：

- **`board`（SQLite 事务状态机）**：
  - `lead` 获准：`read`、`list_subtasks`、`announce`（发布/调整方向）、`assign`（分工）、`create_subtask`、`update_subtask`、`note`。
  - `helper` 获准：`read`、`list_subtasks`、`create_subtask`、`claim`（事务排他认领）、`update_subtask`、`note`（写回反馈）、`landed`、`complete`。
- **`gitea`**：双方获准 `pull_request_write`，并在各自独立分支通过原生 `git` 提交与推送。

`board` Service 内置了三道强因果校验：
1. **事务排他认领**：`claim` 在 SQLite `BEGIN IMMEDIATE` 事务中检查 `expected_revision`，锁定唯一永久 `owner`；
2. **先读后写门槛**：`lead` 调用 `announce` 引用 `feedback_ids` 前，Board 核验 `reads` 确认 lead 确实读过这些反馈；`helper` 提交 `complete` 前，Board 核验其确实读过最新的 `direction_id`；
3. **Git 字节级验真**：`complete` 携带 `{ commit, path, sha256, bytes }`，Board 在提交事务前调用 `git.verifyDelivery` 直连 Gitea 核对真实分支 head 与文件哈希。

## 2. 它组合了 Runtime 的哪些核心原语？

- **预配固定团队与隔离凭据**：启动时一次性 `spawn` 出 `lead` 与 `helper1..helperN`，每个角色使用独立的 Profile、Gitea 账号 `binding`、`secretEnv.GITEA_TOKEN` 和必选 `collect(includeGit: true)`；不启用内置 `bot` Service。
- **实时失败围栏**：通过 `runtime.onEvent` 监听任意成员的 `fatal` 错误或异常 `exit`——一旦触发，立即调用 `board.fence()` 锁定写操作并中止后续轮次，保留已有归属与失败现场。
- **串行/并发混合驱动**：沿用 `runInput` 在原 Session 中交替推进各阶段。

## 3. 宿主控制循环是如何编写的？

[src/environments/lead-helper/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/index.ts) 提供了标准的双轮闭环 `runWorkflow`（以及可扩展至四轮并支持 `verifyCandidate` 自动纠偏的 `runStage`）：

```ts
// 第 1 步：Lead 发布初始方向、分工与就绪子任务
await dispatch('lead', 'lead-initialize', { type: 'initialize', goal, helpers });
assertInitialBoardReady(board.snapshot());

// 第 2 步：所有 Helpers 并发认领子任务、推送 Git 交付并写回反馈 note
await Promise.all(
  helperRoles.map((role) =>
    dispatch(role, `${role}-initial`, { type: 'helper-initial' })
  )
);

// 第 3 步：宿主注册用户补充要求，Lead 读完所有 Helper 反馈后发布新方向
board.registerUserInput('lead-adjust', supplement);
await dispatch('lead', 'lead-adjust', {
  type: 'user-and-feedback',
  user_input_id: 'lead-adjust',
  supplement,
});

// 第 4 步：原 Helpers 在各自保留的 Session 与 Git 目录中读新方向、完成二轮交付
await Promise.all(
  helperRoles.map((role) =>
    dispatch(role, `${role}-followup`, { type: 'helper-followup' })
  )
);
```

关闭时，宿主先等 `runtime.close()` 确认所有 Agent 停止且私有 Git 目录导出完毕，随后才关闭 SQLite 连接并撤销本次运行临时签发的 Gitea Token；`board.sqlite`、Git 提交与 PR 全部保留。

## 源码位置

- 编排主入口（`runWorkflow` / `runStage`）：[src/environments/lead-helper/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/index.ts)
- SQLite Board 与事务校验：[src/environments/lead-helper/board.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/board.ts)
- Gitea 预配与交付验真：[src/environments/lead-helper/git.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/lead-helper/git.ts)
- 运行说明：[examples/lead-helper-environment/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/lead-helper-environment/README.md)
