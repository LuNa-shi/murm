---
title: Lead-Worker
description: 分阶段定调与反馈闭环——结合非对称 Board 权限、SQLite 事务排他认领、因果阅读门控与 Git SHA-256 实时校验。
section: 内置 HARNESS
order: 11
---

**Lead-Worker**（`src/harnesses/lead-worker/`）适合需要明确由一人掌舵方向、同时强制将一线执行反馈纳入下一轮规划的团队。1 名 `lead` 与 2–7 名 Worker（代码中角色名为 `helper1..helperN`）在各自持久化会话中运行，拥有独立 Gitea 账号、个人 Git 分支以及一个本地 SQLite **`board` Service**。

## 1. 注册的 Services 与非对称权限

[src/harnesses/lead-worker/board.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/board.ts) 在 Service Bridge（`Profile.services`）与适配器内部双重执行非对称角色权限：

```ts
export const boardPermissions = Object.freeze({
  lead: ['read', 'list_subtasks', 'announce', 'assign', 'create_subtask', 'update_subtask', 'note'],
  helper: ['read', 'list_subtasks', 'create_subtask', 'claim', 'update_subtask', 'note', 'landed', 'complete'],
});
```

两种角色同时拥有 `gitea: ['pull_request_write']` 以及针对自身分支的原生 `git` 推送能力（经由 `Profile.network.allow` 放行与 `secretEnv.GITEA_TOKEN` 鉴权）；内置 `agent` Service 默认关闭。

`board` 在 SQLite `BEGIN IMMEDIATE` 事务中强约束三条不变量：

1. **排他永久认领**：`claim` 校验 `row.owner === null && row.state === 'ready' && row.revision === input.expected_revision` 后锁定永久 `owner`，认领永不过期也不会自动回收改派。
2. **先读后写的因果门控**：
   - `announce` 引用 `feedback_ids` 时，若 `reads` 表不能证明 `lead` 曾实际读过这些反馈，直接返回 `FEEDBACK_NOT_READ`。
   - `landed` / `complete` 提交交付时，若 Worker 尚未读取最新 `direction_id`，直接返回 `DIRECTION_NOT_READ`。
3. **字节级实时 Git 核验**：提交 `landed` 或 `complete` 前，适配器调用 `git.verifyDelivery()` 实时请求 Gitea 核对提交分支、commit SHA、文件路径、字节长度与精确 SHA-256（并在后续轮次校验产物中是否真正包含更新后的方向文本）。

```ts
// 节选自 src/harnesses/lead-worker/board.ts
if (['landed', 'complete'].includes(operation)) {
  const subtask = deliveryGuard(state, caller, input, role);
  delivery = await verifyDelivery({
    actor: caller.agentId,
    subtask: structuredClone(subtask),
    delivery: structuredClone(input.delivery),
    direction: structuredClone(state.directions.at(-1)),
    requireDirectionText: state.directions.length > 1,
    signal,
  });
  if (!delivery || delivery.verified !== true) throw error('DELIVERY_INVALID');
}
```

容器内典型命令如下：

```bash
swarm board read --request-id helper1-read
swarm board claim --input claim.json --request-id helper1-claim
swarm board complete --input complete.json --request-id helper1-done
```

## 2. 分阶段控制循环与故障围栏

在 [src/harnesses/lead-worker/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/index.ts) 中，`createLeadWorkerHarness()` 一次性启动固定团队（`maxAgents: 1 + helperCount`），把团队成员绑定到 `board` 与 `git`，并订阅 `runtime.onEvent()`——一旦任何成员出现 fatal 错误、非 completed 结算或意外退出，立即调用 `board.fence()` 冻结后续写操作，同时完整保留所有证据与归属状态。

默认工作流通过 `runInput` 执行两轮交替编排：

```ts
// 阶段 1a：Lead 发布初始方向、分工指派与就绪子任务
await dispatch('lead', 'lead-initialize', { type: 'initialize', goal, helpers });

// 阶段 1b：多名 Worker 并发认领子任务、推送 Git 提交并留下反馈笔记
await Promise.all(
  helperRoles.map((role) =>
    dispatch(role, `${role}-initial`, { type: 'helper-initial' }),
  ),
);

// 阶段 2a：注册用户补充输入；Lead 读取所有反馈并修订方向
board.registerUserInput('lead-adjust', supplement);
await dispatch('lead', 'lead-adjust', {
  type: 'user-and-feedback',
  user_input_id: 'lead-adjust',
  supplement,
});

// 阶段 2b：同一批 Worker 在保留的会话中读取新方向并完成第二轮交付
await Promise.all(
  helperRoles.map((role) =>
    dispatch(role, `${role}-followup`, { type: 'helper-followup' }),
  ),
);
```

针对更长的多阶段调度（`helperCount: 3`），`createLeadWorkerHarness()` 还暴露了 `prepareStages({ signal })` 与 `runStage({ goal | supplement, paths, tasks?, signal, deadlineAtMs?, verifyCandidate? })`，可在同一支团队上串行推进最多四轮阶段交付并验证每轮独立文件路径。

## 3. 运行示例

```bash
# 配置 run ID、不可变 Worker 镜像、OpenSandbox 地址、Gitea 管理员凭证与模型端点
node dist/examples/lead-worker/main.js dist/examples/lead-worker/config.js
```

关闭时，`close()` 会等 `runtime.close()` 确认所有 Agent 停止且私有 Git 仓库归档完成后，再关闭 SQLite 连接并吊销临时 Gitea 令牌；共享仓库、Board SQLite 数据库、提交与 PR 全部保留以供复核。

## 源码索引

- 编排器（`runWorkflow`、`prepareStages`、`runStage`）：[src/harnesses/lead-worker/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/index.ts)
- SQLite `board` Service 与因果门控：[src/harnesses/lead-worker/board.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/board.ts)
- Gitea 资源准备与 SHA-256 交付核验：[src/harnesses/lead-worker/git.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/git.ts)
- 示例配置与说明：[examples/lead-worker/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/lead-worker/README.md)
