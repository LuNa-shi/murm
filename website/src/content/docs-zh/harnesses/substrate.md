---
title: Substrate
description: 零任务队列、零消息路由的并行科研探索——对等成员围绕单一 SQLite 不可变存储发布、检索、阅读并显式引用彼此成果。
section: 内置 HARNESS
order: 10
---

**Substrate**（`src/harnesses/substrate/`）展示了一个多智能体 Harness 可以精简到什么程度：没有任务表、没有管理员、也没有私信。3–8 位对等成员围绕同一份 **SQLite 不可变共享库（substrate）** 并行探索——检索并阅读彼此先前的发现，再发布自包含的后续成果并显式声明引用。

## 1. 注册的 Service（`substrate`）

[src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/substrate.ts) 注册了唯一的进程内 SQLite Service（`substrate`），仅包含三个操作：

| 操作 | 入参 | 存储与排序保障 |
| --- | --- | --- |
| **`search`** | `{ query, limit }` *(limit 1–8)* | 按词元匹配已发布成果，排序规则为 **词频降序 → 被引用数降序 → 稳定地址升序**，并将每次查询写入 `substrate_reads` |
| **`visit`** | `{ address }` | 返回完整正文（上限 8 KiB）、经鉴权的 `author`、`version: 1` 与上游 `references`，并将阅读记录写入 `substrate_reads` |
| **`publish`** | `{ content, references? }` *(最多 16 个不重复地址)* | 在 `BEGIN IMMEDIATE` 事务中验证每条引用地址可见、分配不可变地址 `content:<sha256>`，并按 `(run_id, author, request_id)` 去重 |

容器内成员通过 `swarm substrate` 交互：

```bash
swarm substrate search --query 'boundary condition' --limit 5
swarm substrate visit --address content:7f83b165...
swarm substrate publish \
  --content 'Lemma proof for the k >= 5 case...' \
  --references '["content:7f83b165..."]' \
  --request-id peer0-round1-pub
```

因为所有发布记录不可变，修正或延伸已有结论的方式是发布一条新成果并显式引用旧地址——完整的知识引文 DAG 会自然沉淀下来。

## 2. 宿主控制循环

Substrate 只用到四个基础 Runtime 调用：`createRuntime`、`spawn`、`runInput` 与 `stop`。在 [src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/index.ts) 中，`Promise.all` 并行驱动每位成员执行 `maxRounds` 轮（2–32 轮），并支持可选 `maxConcurrentInputs` 限流与 `onCycle` 宿主纠偏钩子：

```ts
// 1. 启动 poolSize (3..8) 个对等成员并绑定到 substrate Service
for (let index = 0; index < poolSize; index++) {
  const agent = await runtime.spawn({
    requestId: `peer:${index}`,
    profile: 'peer',
    files: { 'question.txt': { data: question, encoding: 'utf8' } },
  });
  substrate.bindPeer(agent.id);
  peers.push({ index, agentId: agent.id, turns: [] });
}

// 2. 在各自持久化会话中并发推进 maxRounds 轮探索
await Promise.all(
  peers.map(async (peer) => {
    try {
      for (let round = 0; round < maxRounds; round++) {
        const text = `Substrate peer=${peer.index} cycle=${round}\n${question}\n${cyclePrompt}`;
        const receipt = await runInput(runtime, peer.agentId, text, {
          requestId: `${peer.agentId}:cycle:${round}`,
          timeoutMs: turnTimeoutMs,
          signal: workSignal,
        });
        // 可选 onCycle 钩子可检查 substrate.snapshot() 并在同一时间窗内触发纠偏轮次
      }
    } finally {
      substrate.retirePeer(peer.agentId);
      await runtime.stop(peer.agentId, { timeoutMs: closeTimeoutMs });
    }
  }),
);
```

每位成员完成轮次后，`substrate.retirePeer(peer.agentId)` 会撤销其后续写入权限，`runtime.stop()` 归档私有文件与 Pi 会话并销毁容器，而 `substrate.sqlite` 会继续对尚未退役的成员保持可读。

## 3. 运行 Substrate 并审计知识复用

```bash
export MURM_SUBSTRATE_RUN=research-01
export MURM_SUBSTRATE_IMAGE=$(docker image inspect murm-worker:local --format '{{.Id}}')
export MURM_SUBSTRATE_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBSTRATE_MODEL_TOKEN='your-bearer-token'

node dist/examples/substrate/main.js dist/examples/substrate/config.js > substrate-result.json

# 无需模型配置，离线检查保存的回执：
node dist/examples/substrate/main.js --result "./substrate-runs/$runtime_id" --runtime-id "$runtime_id"
```

[collaboration-evidence.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/collaboration-evidence.ts) 会联合审计 `substrate_contents`、`substrate_references` 和 `substrate_reads` 三张表，验证完整的跨成员复用链：
1. 成员 A 发布成果，且在成员 A 退役停止后依然持久化存在；
2. 成员 B 通过 `search` 检索到该成果并通过 `visit` 实际阅读；
3. 成员 B 发布新成果并显式引用成员 A 的 `content:<sha256>` 地址。

## 4. 形式化定理证明：FATE（Lean 4）配置

[Substrate 示例](https://github.com/LuNa-shi/murm/blob/main/examples/substrate/README.md) 同时内置了基于 Lean `4.28.0` 的 **FATE-M**、**FATE-H** 与 **FATE-X** 评测配置。只需在宿主机侧额外注册一个 Lean 检查 Service（`check_lean`），即可在同一套 Runtime 上公平对比三种实验条件：
- `shared`：所有成员共用一个共享 substrate 知识库；
- `private`：每位成员只能读写自己的私有库；
- `none`：不提供 substrate 知识库。

启用 `fate.verifiedCompletion: true` 后，成员只有先对所提交的精确证明拿到 `check_lean` 的 `passed` 结果才能提前结束；未完成提交的自然回复会在原持久化会话中继续追问，直到通过验证或到达截止时间。

```bash
export MURM_FATE_BENCHMARK=FATE-X
export MURM_FATE_PROJECT=/path/to/fate-x
export MURM_FATE_LEAN=/path/to/lean-4.28.0

node dist/examples/substrate/main.js --fate-prepare "$MURM_FATE_PROJECT" "$MURM_FATE_LEAN" FATE-X
node dist/examples/substrate/main.js dist/examples/substrate/fate-config.js
```

## 源码索引

- 并行轮次驱动：[src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/index.ts)
- SQLite `substrate` Service：[src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/substrate.ts)
- 跨成员复用证据审计：[src/harnesses/substrate/collaboration-evidence.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/collaboration-evidence.ts)
- CLI 与 FATE Lean 指南：[examples/substrate/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/substrate/README.md) · [FATE-X #31 运行报告](https://github.com/LuNa-shi/murm/blob/main/docs/experiments/EXP-20261125-20-scalemas-fatex-verified.md)
