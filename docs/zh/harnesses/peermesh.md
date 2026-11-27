---
title: PeerMesh
description: 扁平对等研发小组——成员在共享任务板上登记分工、通过 Mattermost 群聊与私信协商，并在个人 Git 分支提 PR 经宿主核验合入。
section: 内置 Harness
order: 13
---

**PeerMesh**（`src/harnesses/peermesh/`）模拟一个 2–8 人的扁平研发小组，没有中心管理员，也不强行对任务加独占锁。每位成员拥有独立的 Gitea 与 Mattermost 账号、持久化会话和本地 Git 仓库：大家在共享任务板上登记自己正在处理的模块（`CLAIM`）、通过频道和私信商量分工、各自在个人分支开发并提 PR，最后由宿主机核验代码后再合入受保护的 `main`。

## 快速运行（CLI）

先按 [examples/peermesh/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/README.md) 配置 Gitea、Mattermost、Board 与模型环境变量，再在项目目录启动：

```bash
cd my-project
murm --harness peermesh --prompt "根据解析测试修复当前项目"
```

PeerMesh 会根据当前目录和提示词自动建立团队仓库与 Issue，为每位成员分配独立沙箱与个人分支。下文介绍其 Services、每成员串行 Router 及前台 JSON 行运行方式。

## 1. 注册的 Services

[src/harnesses/peermesh/services.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/services.ts) 为每次运行注册三个 Service，将容器身份精准绑定到该成员专属的外部账号，同时把管理员令牌严格留在宿主机：

| Service | 支持的操作 | 用途 |
| --- | --- | --- |
| **`peermesh-context`** | `board_read`、`board_write`、`board_grep`、`board_unfold` | 读写共享任务板，支持 `FACT`、`OBSERVED`、`FAIL`、`PATCH_SUMMARY` 以及不加锁的分工登记 `CLAIM` |
| **`message`** | `post_message`、`peer_list`、`send_dm` | 在运行频道发言、发现其他成员以及发送点对点私信 |
| **`gitea`** | `issue_list`、`issue_read`、`issue_write`、`pull_request_list`、`pull_request_read`、`pull_request_write`、`comment_list`、`comment_write`、`pull_request_merge` | 读写 Issue / PR 并向受保护 `main` 申请经宿主验证的合并 |

成员还可以直接通过白名单放行的 Gitea 来源（`Profile.network.allow`）与 `secretEnv.GITEA_TOKEN` 使用原生 `git` 推送个人分支。容器内典型命令如下：

```bash
# 向共享任务板登记正在处理的模块或发布发现
swarm peermesh-context board_write \
  --input claim.json --request-id claim-parser

# 向另一位成员发送私信
swarm message send_dm --peer b --message 'I pushed lexer fixes on branch peer-a/lexer.' \
  --request-id dm-b-1

# 锁定具体 head_sha 申请宿主验证合并
swarm gitea pull_request_merge \
  --owner "$RUN_OWNER" --repo "$RUN_REPO" --index 3 --head-sha "$HEAD_SHA" \
  --request-id merge-pr-3
```

调用 `pull_request_merge` 时，[delivery.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/delivery.ts) 会在宿主侧核验调用者身份、仓库、PR 编号与固定的 `head_sha` 后再合入 `main`；若分支已更新导致 SHA 过期，会直接拒绝并要求重新验证。

## 2. 每成员串行 Router 与途中转向

在 [team.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/team.ts) 和 [router.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/router.ts) 中，每位成员都有一个专属串行 Router。事件订阅轮询 Mattermost 和 Gitea，成功的 Board 写入也会追加通知，Router 将这些事件投递到成员的持久化 Pi 会话中（其中的 `runInput` 是仓库共用的单轮执行辅助函数 `src/harnesses/shared/run-input.ts`）。下面节选项目运行配置，完整工厂还会安装故障处理与关闭逻辑：

```ts
const router = createPeerMeshRouter({
  workTimeoutMs: durationMs + 120_000,
  turnTimeoutMs: durationMs,
  maxBatches: 256,
  idleNudgeMs: 120_000,
  maxNudges: 8,
  mapping: { agentId: agent.id, workerId: peer.board.workerId },
  // 成员工作期间，私信和新的 Board 条目在 Pi 下一个工具边界通过 steer 实时送达
  steerInput: (text: string, requestId: string) =>
    runtime.send(agent.id, text, {
      mode: 'steer',
      requestId,
      source: 'peermesh-peer-notice',
      steeringMode: 'all',
    }),
  // 完整工作批次串行执行，每次自动前置最新的 Board 渲染快照
  runInput: (text, wait) =>
    runInput(runtime, agent.id, text, { ...wait, signal }),
  readContext: async ({ signal }) =>
    (await board('GET', `/board/${boardId}/read?viewer=${peer.board.workerId}`, undefined, { signal })).rendered,
});
```

这套控制循环有三个关键机制：

- **工作途中实时通知**：成员执行批次期间，收到的私信（`kind: 'dm'`）与新 Board 条目（`kind: 'board-entry'`）会以 `steer`（`steeringMode: 'all'`）注入，成员不必等当前批次结束就能回应队友；
- **空闲提醒（Idle Nudge）**：项目时间窗尚未结束但某位成员持续空闲时，Router 会按 `idleNudgeMs` 温和提醒其复核 Board 并继续推进；
- **结束与归档**：到达截止时间（或收到 `stop`）时，宿主先封锁新投递、固定最终 `main` 提交并导出校验归档哈希，随后执行 `runtime.close()` 采集每位成员的 Pi 会话与 Git 工作区（`collect: { paths: ['.'], includeGit: true, allowMissingGit: true }`）。尚未确定的合并、归档失败和未确认停止的执行会作为 pending 结果保留。

## 3. 配置与运行 PeerMesh

准备一份描述项目目标与可选初始文件的 JSON：

```json
{
  "title": "Build a color conversion CLI",
  "body": "Validate hex color input and print decimal RGB channels with usage examples.",
  "durationMs": 3600000,
  "seed": {
    "notes/requirements.txt": "Exit nonzero on invalid input."
  }
}
```

配置宿主环境变量（完整清单见 [examples/peermesh/config.ts](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/config.ts) 与 [examples/peermesh/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/README.md)），通过前台 CLI 启动：

```bash
export MURM_PEERMESH_PROJECT_FILE=./project.json
export MURM_PEERMESH_RUN_ID=color-cli-01
export MURM_PEERMESH_IMAGE='ghcr.io/luna-shi/murm-worker:0.2.0'
export MURM_PEERMESH_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_PEERMESH_PEERS=4
# 以及 Gitea、Mattermost 与 Board MySQL DSN 等宿主环境变量

node dist/scripts/run-harness.js --config dist/examples/peermesh/config.js
```

输出 `ready` 后，可通过 `stdin` 逐行发送 JSON 命令查看状态、向指定成员追加输入或提前停止：

```json
{"id":"state","operation":"status"}
{"id":"more-a","operation":"input","input":{"recipient":"a","input":"Explain which file supports your claim.","requestId":"more-a-1"}}
{"id":"close","operation":"stop"}
```

运行结束后离线检视合并回执与归档哈希：

```bash
runtime_id=RUNTIME_ID_FROM_RESULT
node dist/scripts/read-harness-result.js \
  --run-directory "./peermesh-runs/$runtime_id" \
  --runtime-id "$runtime_id"
```

## 源码索引

- 团队装配与生命周期：[src/harnesses/peermesh/team.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/team.ts)
- 每成员串行 Router、途中 steer 与提醒：[src/harnesses/peermesh/router.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/router.ts)
- Service 封装（`peermesh-context`、`message`、`gitea`）：[src/harnesses/peermesh/services.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/services.ts)
- 宿主 PR 合并校验与主干导出：[src/harnesses/peermesh/delivery.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/delivery.ts)
- 示例配置与指南：[examples/peermesh/config.ts](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/config.ts) · [examples/peermesh/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/README.md)
