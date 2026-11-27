---
title: Substrate
description: 对等成员通过不可变成果库交流；提供简单通用运行器与独立的 FATE 定理证明配置。
section: 协作机制
order: 10
---

## 在普通项目中运行

```sh
cd my-project
murm --harness substrate --prompt "根据解析测试修复当前项目"
```

每个 peer 都取得捕获的文件，并在每个周期将 prompt 作为问题。FATE 通过显式的准备、运行、矩阵和评分命令执行。 调用 TS SDK 的旧示例和基准测试专用参数见下文。

**Substrate**（`src/harnesses/substrate/`）展示了一个多智能体 Harness 可以精简到什么程度：没有任务表、没有管理员、也没有私信。3–8 位对等成员围绕同一份 **SQLite 不可变共享库（substrate）** 并行探索——检索并阅读彼此先前的发现，再发布自包含的后续成果并显式声明引用。

示例宿主通过 [SDK](../sdk.md) 创建 Runtime，并使用通用 OpenSandbox 后端。`runSubstrate` 运行器和 SQLite Service 都是可修改的仓库模块，没有作为包入口导出。下面的通用示例与 FATE 运行器采用相同的成果共享思路，但 Service schema 和检索策略不同。

## 1. 通用成果库 Service（`substrate`）

[src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/substrate.ts) 注册了唯一的进程内 SQLite Service（`substrate`），仅包含三个操作：

| 操作 | 入参 | 存储与排序保障 |
| --- | --- | --- |
| **`search`** | `{ query, limit }` *(limit 1–8)* | 按词元匹配已发布成果，排序规则为 **词频降序 → 被引用数降序 → 稳定地址升序**，并将每次查询写入 `substrate_reads` |
| **`visit`** | `{ address }` | 返回完整正文（上限 8 KiB）、经鉴权的 `author`、`version: 1` 与上游 `references`，并将阅读记录写入 `substrate_reads` |
| **`publish`** | `{ content, references? }` *(最多 16 个不重复地址)* | 在 `BEGIN IMMEDIATE` 事务中验证每条引用地址可见、分配不可变地址 `content:<sha256>`，并按 `(run_id, author, request_id)` 去重 |

容器内成员通过 `swarm substrate` 交互：

```bash
swarm service view substrate --json
swarm substrate search --query 'boundary condition' --limit 5
swarm substrate publish \
  --content 'The k = 5 boundary still needs a separate argument.' \
  --references '[]' --request-id peer0-boundary-note
```

要阅读并引用已有成果，应把搜索或发布回执中的完整地址传给 `visit --address`，并在后续发布的 `references` 数组中使用同一地址。

因为所有发布记录不可变，修正或延伸已有结论的方式是发布一条新成果并显式引用旧地址——完整的知识引文 DAG 会自然沉淀下来。

## 2. 宿主控制循环

宿主使用 `createRuntime`、`spawn`、输入投递、事件和 `stop`/`close`。`runInput` 是仓库中的辅助函数，用于向空闲 Agent 投递一个由宿主独占管理的输入；它先订阅事件，再发送输入并检查结算结果。它不是 Runtime 方法，也没有从公共包入口导出。在 [src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/index.ts) 中，`Promise.all` 并行驱动每位成员执行 `maxRounds` 轮（2–32 轮），并支持可选 `maxConcurrentInputs` 限流与 `onCycle` 宿主纠偏钩子。下面的节选省略了截止时间与错误记录逻辑：

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

每位成员完成轮次后，`substrate.retirePeer(peer.agentId)` 会拒绝该成员后续的 Service 调用。`runtime.stop()` 尝试停止执行、采集必需的私有文件并销毁沙箱；执行或必需导出尚未确认时，回执可以保持 pending。公共成果仍可被活跃成员读取，并在最后关闭数据库连接后继续保留。

## 3. 运行 Substrate 并审计知识复用

以下命令支持从已构建仓库或 `@luna-shi/murm` 安装包运行，需要兼容的 Pi Worker 镜像、已启动的 OpenSandbox 服务和可用的 Responses 模型端点。环境变量说明见 [示例 README](https://github.com/LuNa-shi/murm/blob/main/examples/substrate/README.md)。

```bash
export MURM_SUBSTRATE_RUN=research-01
export MURM_SUBSTRATE_IMAGE=$(docker image inspect murm-worker:local --format '{{.Id}}')
export MURM_SUBSTRATE_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBSTRATE_MODEL_TOKEN='your-bearer-token'

node dist/examples/substrate/main.js dist/examples/substrate/config.js > substrate-result.json

# 无需模型配置，离线检查保存的回执：
runtime_id=RUNTIME_ID_FROM_RESULT
node dist/examples/substrate/main.js --result "./substrate-runs/$runtime_id" --runtime-id "$runtime_id"
```

[collaboration-evidence.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/collaboration-evidence.ts) 会联合审计 `substrate_contents`、`substrate_references` 和 `substrate_reads` 三张表，检查跨成员复用链：

1. 成员 A 发布成果，且在成员 A 退役停止后依然持久化存在；
2. 成员 B 通过 `search` 检索到该成果并通过 `visit` 实际阅读；
3. 成员 B 发布新成果并显式引用成员 A 的 `content:<sha256>` 地址。

## 4. 形式化定理证明：FATE（Lean 4）配置

当配置存在 `config.fate` 时，同一个示例 CLI 会选择独立的 FATE 运行器。仓库提供基于 Lean `4.28.0` 的 **FATE-M**、**FATE-H** 和 **FATE-X** 配置。运行器注册包含 `search_mathlib`、`check_lean`、`submit` 的 `fate` Service，并在启用成果库时注册与论文协议对齐的发布 Service。三种实验条件为：
- `shared`：所有成员共用一个共享 substrate 知识库；
- `private`：每位成员只能读写自己的私有库；
- `none`：不提供 substrate 知识库。

FATE 使用 [paper-substrate.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/paper-substrate.ts) 实现成果库。发布结构为 `{ sub_task, artifact, rationale, refs }`，阅读接受 `addresses` 数组，搜索使用归一化 BM25 与引用权重排序。这些契约与前文通用库的 `content` / `references` 不同；在实际运行中通过 `swarm service view substrate` 查看对应 schema。

启用 `fate.verifiedCompletion: true` 后，提前完成要求提交的精确证明已经得到 `passed` 检查结果。尚未完成的自然回复可以在同一 Session 中触发后续输入，但仍受工作截止时间和剩余 Service/检查次数约束。最终正确性由宿主检查冻结候选确定，发布或引用本身不构成正确性证据。

先按示例 README 准备固定版本的评测项目与工具链，再运行：

```bash
export MURM_FATE_BENCHMARK=FATE-X
export MURM_FATE_PROJECT=/path/to/fate-x
export MURM_FATE_LEAN=/path/to/lean-4.28.0

node dist/examples/substrate/main.js --fate-prepare "$MURM_FATE_PROJECT" "$MURM_FATE_LEAN" FATE-X
node dist/examples/substrate/main.js --fate-run dist/examples/substrate/fate-config.js
```

## 源码索引

- 并行轮次驱动：[src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/index.ts)
- SQLite `substrate` Service：[src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/substrate.ts)
- 跨成员复用证据审计：[src/harnesses/substrate/collaboration-evidence.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/collaboration-evidence.ts)
- CLI 与 FATE Lean 指南：[examples/substrate/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/substrate/README.md) · [FATE-X #31 运行报告](https://github.com/LuNa-shi/murm/blob/main/docs/experiments/EXP-20261125-20-scalemas-fatex-verified.md)
