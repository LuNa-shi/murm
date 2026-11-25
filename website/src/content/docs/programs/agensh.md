---
title: Agensh · 同级协商与代码协作
description: 拆解 Agensh Program 如何通过 Mattermost、共享 Board、Gitea 与每成员串行 Router，把多只平级 Agent 组织成自主协商的工程团队。
section: 内置协作 Program
order: 8
---

**Agensh** 模拟真实软件团队的平级协作模式：没有中心派单者，也不使用排他锁。每位同级成员（**peer**）在自己的 Git 分支里开发，在公共 Board 上公开允许重叠的工作意向（`CLAIM`）与进展（`FACT` / `PATCH_SUMMARY`），通过聊天频道与同伴商量切分边界，最后提 PR 由宿主核验合入。完整实现位于 [src/environments/agensh](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments/agensh)。

## 1. 这个 Program 注册了哪些 Service？

宿主在启动前为本轮 Run 预配隔离的 Gitea 仓库、Mattermost 频道、独立成员账号以及本地 Agensh Board 进程，然后将三类外部设施包装成按 Run 和 peer 严格隔离的 Service（[services.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/services.ts)）：

| Service | 开放给 peer 的操作 | 关键业务约束 |
| --- | --- | --- |
| **`agensh-context`** | `board_read`、`board_write`、`board_grep`、`board_unfold` | 支持发布 `CLAIM`（可重叠软意向）、`FACT`、`OBSERVED`、`FAIL`、`PATCH_SUMMARY`；按 `viewer` 渲染视角 |
| **`message`** | `post_message` | 严格限定写入当前 Run 的 `channel_id`；Mattermost Token 仅留宿主 adapter |
| **`gitea`** | `issue_read`、`issue_write`、`pull_request_write` | 只允许从自己的 `WORK_BRANCH` 向 `main` 提 PR，不向 peer 开放直接合入权限 |

除上述三个 Service 外，容器内的原生 `git clone / commit / push` 通过 Profile 网络白名单与受限凭据直接与 Gitea 仓库交互。

## 2. 它组合了 Runtime 的哪些核心原语？

1. **每角色独立配置与 `bindings`**：`createAgenshTeam` 为每位 peer 生成专属 Profile（`peer-a`、`peer-b`…），通过 `Profile.env` 注入 `WORK_BRANCH` / `RUN_REPOSITORY` / `RUN_CHANNEL`，通过 `Profile.network.allow` 仅放行 Gitea origin，再在 `spawn` 时通过 `bindings` 将三个外部账号绑定到对应 Service、通过 `secretEnv` 仅下发该 peer 的 `GITEA_TOKEN`。
2. **包含 `.git` 的必选归档**：`spawn` 时显式声明 `collect: { paths: ['.'], includeGit: true, maxBytes: exportLimit, required: true }`，确保即便 peer 在关闭前还有未推送提交或本地修改，也会完整带回宿主。
3. **串行 `followUp` 批处理**：每个 peer 独占一个输入源，通过 `runInput` 显式走 `mode: 'followUp'`，保证每批外部事件在一个完整轮次结束（`settled`）后再投递下一批。

## 3. 宿主控制循环是如何编写的？

Agensh 最核心的编排器是为每个 peer 独立运行的 **EventSource → Router** 流水线（[router.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/router.ts)）：

```ts
// 1. 外部事件拉取器把 Mattermost 提及与 Gitea 更新送入对应 peer 的 router
eventSource.onExternalEvent((event) => {
  // 按 [source, eventId, targetWorker] 计算哈希去重，并过滤 peer 自己发的消息
  router.ingest(event);
});

// 2. Router 内部串行泵：每次派发前附带最新 Board 视图，用 followUp 驱动原会话
async function pump() {
  while (accepting && queue.length) {
    const batch = queue.shift()!;
    // 派发前实时读取该 peer 视角的最新 Board 渲染文本
    const boardContext = await readContext({ signal });
    const payload = `${routerInstruction}\n${JSON.stringify({ ...batch, context: boardContext })}`;

    // 在原会话与原 Git checkout 中完成一个完整轮次
    await runInput(runtime, peerBotId, payload, {
      requestId: batch.requestId,
      timeoutMs: turnTimeoutMs,
    });
  }

  // 若队列持续空闲且未达上限，安排一次 idle nudge 提醒 peer 检查公共进展
  scheduleIdleNudgeIfConfigured();
}
```

当 peer 推送分支并提交 PR 后，宿主侧调用 [delivery.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/delivery.ts) 的 `createAgenshDelivery` 核对 PR 作者、分支名、固定提交 SHA 与目标 `main`，通过检验后执行合入。关闭时，宿主先停止全部 EventSource 与 Router，等 `runtime.close()` 确认容器导出清理完成后，再关闭自建 Board 进程并回收临时外部凭据。

## 源码位置

- 多 peer 团队装配：[src/environments/agensh/team.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/team.ts)
- 串行路由与空闲提醒：[src/environments/agensh/router.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/router.ts)
- 外部 Service 封装：[src/environments/agensh/services.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/services.ts)
- 宿主 PR 核验合入：[src/environments/agensh/delivery.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/delivery.ts)
- 安装包运行说明：[examples/agensh-environment/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/agensh-environment/README.md)
