---
title: ScaleMAS · 成果库自主研究
description: 拆解 ScaleMAS Program 如何仅用 1 个 SQLite 不可变成果库 Service 和几十行并发轮次循环，驱动多只 Agent 自主检索、阅读与引用演化。
section: 内置协作 Program
order: 9
---

**ScaleMAS** 展示了极简的无任务协作：没有 Task 表，没有中央派单，也没有私聊消息。固定数量（3–8 只）地位平等的 peer 围绕一个**不可变公共成果库（`substrate`）**并发研究——每轮先检索并阅读同伴已发表的结论，再发表自包含的新发现并显式附上引用地址。完整实现位于 [src/environments/scalemas](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments/scalemas)。

## 1. 这个 Program 注册了什么 Service？

ScaleMAS 只有一个基于本地 SQLite 的 **`substrate` Service**（[substrate.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/substrate.ts)），暴露三个极简操作：

| 操作 | 作用 | 数据库与规则保证 |
| --- | --- | --- |
| **`search`** | `{ query, limit }`（1–8） | 分词匹配本 Run 已发布正文；按**词频降序 → 被引用数降序 → 稳定地址升序**排序，同时记入 `substrate_reads` 审计表 |
| **`visit`** | `{ address }` | 返回完整正文（上限 8 KiB）、真实作者与上游引用列表，同样记入 `substrate_reads` |
| **`publish`** | `{ content, references? }` | 在 `BEGIN IMMEDIATE` 事务中验证所有引用地址真实存在，生成不可变地址 `content:<sha256>` 并按 `(run_id, author, request_id)` 保证幂等 |

因为内容不可修改，修正旧观点必须发布新记录并引用旧地址，整条知识演化图天然完整留存。

## 2. 它组合了 Runtime 的哪些核心原语？

ScaleMAS 是验证“Runtime 可以有多轻量”的最佳样例，只用了最基础的四项原语：
- `createRuntime({ services: substrate.services, maxBots: poolSize, profiles: { peer } })`
- `runtime.spawn({ profile: 'peer', files: { 'question.txt': ... } })`（所有 peer 拿到相同的初始研究问题）
- `runInput`（封装 `runtime.send(..., { mode: 'followUp' })` + `onEvent('settled')`，让每只 peer 在原有 Session 里连续跑多轮）
- `runtime.stop(peerId)`（每只 peer 完成所有轮次后先在 `substrate` 中标记 retired，再单独停止并导出其私有目录，而 `substrate.sqlite` 持续保留）

## 3. 宿主控制循环是如何编写的？

在 [src/environments/scalemas/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/index.ts) 中，宿主不需要复杂路由，用 `Promise.all` 并发跑每个 peer 的固定轮次循环即可，同时支持通过 `maxConcurrentInputs` 限流与 `onCycle` 轮次纠偏：

```ts
// 1. 一次拉起 poolSize 个 peer，并把它们的真实 botId 绑定到 substrate 权限表
for (let i = 0; i < poolSize; i++) {
  const bot = await runtime.spawn({
    requestId: `peer:${i}`,
    profile: 'peer',
    files: { 'question.txt': { encoding: 'utf8', data: question } },
  });
  substrate.bindPeer(bot.id);
  peers.push(bot);
}

// 2. 所有 peer 并发执行 maxRounds 轮；单个 peer 内部串行延续原 Session
await Promise.all(
  peers.map(async (peer, idx) => {
    try {
      for (let round = 0; round < maxRounds; round++) {
        const prompt = `scaleMAS peer=${idx} cycle=${round}\n${question}\n${cyclePrompt}`;
        const receipt = await runInput(runtime, peer.id, prompt, {
          requestId: `${peer.id}:cycle:${round}`,
          timeoutMs: turnTimeoutMs,
        });
        // 可选 onCycle 钩子：在单轮时间窗内校验产出，不满意可立即发 correction 续轮
      }
    } finally {
      substrate.retirePeer(peer.id);
      await runtime.stop(peer.id, { timeoutMs: closeTimeoutMs });
    }
  })
);
```

## 4. 如何验证跨 Agent 知识接续真的发生了？

仓库的 [collaboration-evidence.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/collaboration-evidence.ts) 结合 SQLite 中的发布表与 `substrate_reads` 读取审计表，直接核验三段事实：**① 原作者停止后内容仍存在 → ② 另一位 peer 确实先 `search` 再 `visit` 读过原文 → ③ 这位 peer 随后在 `publish` 中显式引用了该地址**。

## 源码位置

- 并发轮次驱动：[src/environments/scalemas/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/index.ts)
- SQLite 成果库：[src/environments/scalemas/substrate.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/substrate.ts)
- 协作证据校验：[src/environments/scalemas/collaboration-evidence.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/collaboration-evidence.ts)
- 运行说明：[examples/scalemas-environment/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/scalemas-environment/README.md)
