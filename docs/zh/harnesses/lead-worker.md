---
title: Lead-Worker
description: 固定 Lead 与 Worker 团队，根据一线反馈更新方向，并通过 Git 核验交付。
section: 协作机制
order: 11
---

**Lead-Worker**（`src/harnesses/lead-worker/`）适合需要明确由一人掌舵方向、同时强制将一线执行反馈纳入下一轮规划的团队。1 名 `lead` 与 2–7 名 Worker（代码中角色名为 `helper1..helperN`）在各自持久化会话中运行，拥有独立 Gitea 账号、个人 Git 分支以及一个本地 SQLite **`board` Service**。

宿主通过 [SDK](../sdk.md) 组合 Runtime、Service 与 OpenSandbox 后端。`createLeadWorkerHarness` 和 `runLeadWorker` 是 `src/harnesses/lead-worker/` 下的仓库模块，没有从公共包入口导出。默认模式在启动前确定团队。随包提供的[动态订单示例](../../../examples/lead-worker/README.md)允许 Lead 在工作进行中部署检查 Service、登记 Profile、接纳新成员并更新原 Worker 的授权。

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

默认工作流交替执行两轮。仓库辅助函数 `runInput` 先订阅结算事件，再投递一个由宿主独占管理的输入。下面的流程省略了每个阶段共用的取消信号与结果验证：

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

当宿主使用 `helperCount: 3` 管理多阶段调度时，工厂还提供 `prepareStages({ signal })` 和 `runStage(...)`。首阶段传入 `goal` 与 `paths`，后续阶段传入 `supplement` 与新的 `paths`；也可提供任务描述、宿主取消信号、截止时间和候选验证器。同一团队最多推进四个串行阶段。示例 CLI 仍运行原来的两轮短流程。

阅读约束证明哪些反馈与方向曾被观察到。交付验证证明账号、提交和文件字节的来源，不负责判断任意代码的语义质量。

## 3. 运行示例

从已构建的仓库运行前，需要准备 OpenSandbox、兼容的 Pi Worker 镜像、Gitea 和 Responses 模型端点。[示例 README](https://github.com/LuNa-shi/murm/blob/main/examples/lead-worker/README.md) 说明宿主设置和已安装包的启动方式。

```bash
# 配置 run ID、不可变 Worker 镜像、OpenSandbox 地址、Gitea 管理员凭证与模型端点
node dist/examples/lead-worker/main.js dist/examples/lead-worker/config.js
```

关闭时，宿主先停止接纳 Board 写入，再调用 `runtime.close()`。只有 Core 确认执行已停止且清理完成后，才关闭 Board 连接并撤销自己创建的 Gitea 凭证。执行状态未知、必需导出失败或 Board 证据写入失败时，相关依赖保持 pending，等待后续协调。共享仓库、Board 数据库、提交与 PR 保留供检查。`harness-report.json` 分别记录业务失败、已交付和未完成工作、不确定输入、清理和报告保存结果。

## 源码索引

- 编排器（`runWorkflow`、`prepareStages`、`runStage`）：[src/harnesses/lead-worker/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/index.ts)
- SQLite `board` Service 与因果门控：[src/harnesses/lead-worker/board.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/board.ts)
- Gitea 资源准备与 SHA-256 交付核验：[src/harnesses/lead-worker/git.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/lead-worker/git.ts)
- 示例配置与说明：[examples/lead-worker/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/lead-worker/README.md)
