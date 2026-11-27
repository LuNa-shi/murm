---
title: 实战：构建多智能体 Swarm Harness
description: 动手搭建一套真正的并行多智能体调研 Swarm——3 名并行研究员通过共享黑板自由探索、互相检索引用，再由综合员整合输出并回放轨迹。
section: 核心构件与实战
order: 9
---

前面六章把 `murm` 的六个核心构件拆开讲透了。这一章我们把它们全部拼起来，从零搭建一套**真正的多智能体 Swarm** —— **并行调研与综合 Swarm（Research Swarm）**：

- **3 名并行研究员（`researcher`）**：运行在各自隔离的只读沙箱里，同时探索同一个问题，通过共享黑板 Service 发布发现、检索队友进展并显式引用已有条目。
- **两轮自主协同**：第 1 轮各自并行探索并上板；第 2 轮大家在保留原会话记忆的前提下，主动查看队友的发现、补充盲区或提出反驳。
- **1 名综合员（`synthesizer`）**：仅拥有黑板只读权与本地文件写权限，在所有研究员完成后汇聚集体发现，产出 `report.md` 并由 `Profile.collect` 自动导出。

整套实战**零外部数据库或 Git 容器依赖**，只要完成 [快速上手](quickstart.md) 中的 `murm setup` 就能直接运行。正文只展示拆解后的关键片段，完整可运行代码折叠在文末。

## 第 1 步：用普通 TypeScript 写共享黑板类（`board.ts`）

先写业务本身，不混入任何框架胶水代码。`FindingsBoard` 负责存放所有成员发布的发现、支持关键词检索，以及在结束时导出完整快照：

```ts
// board.ts —— 独立的业务状态类
export interface Finding {
  id: number;
  authorId: string; // 由宿主机网关注入的真实 Agent ID，不可伪造
  topic: string;
  summary: string;
  cites: number[]; // 引用的队友条目 ID，形成跨 Agent 协作链
}

export class FindingsBoard {
  private entries: Finding[] = [];

  publish(authorId: string, topic: string, summary: string, cites: number[] = []): Finding {
    // 校验所有引用的条目都真实存在，防止模型幻觉编造 ID
    for (const refId of cites) {
      if (!this.entries.some((e) => e.id === refId)) {
        throw Object.assign(new Error(`引用的条目 #${refId} 不存在`), { code: 'NOT_FOUND' });
      }
    }
    const entry: Finding = { id: this.entries.length + 1, authorId, topic, summary, cites };
    this.entries.push(entry);
    return entry;
  }

  search(query = ''): Finding[] {
    const q = query.trim().toLowerCase();
    return q
      ? this.entries.filter((e) => `${e.topic} ${e.summary}`.toLowerCase().includes(q))
      : [...this.entries];
  }

  exportState() {
    return { total: this.entries.length, entries: this.entries };
  }
}
```

## 第 2 步：把业务类薄薄注册为 `board` Service（`board-service.ts`）

接着写一个轻量注册函数，把 `FindingsBoard` 的 `publish` 和 `search` 暴露给容器内的 `swarm board` 命令：

```ts
// board-service.ts —— 只负责 Manifest 声明与操作分发
import { createInProcessAdapter, type JsonValue, type ServiceRegistration } from '@luna-shi/murm';
import { FindingsBoard } from './board.js';

export function createBoardRegistration(board: FindingsBoard): ServiceRegistration {
  return {
    manifest: {
      contract_version: '2',
      id: 'board',
      title: 'Shared Research Board',
      purpose: '发布、检索并引用团队成员的调研发现。',
      provider_version: '1.0.0',
      endpoint: { transport: 'in-process' },
      capabilities: [
        {
          name: 'publish',
          operation: 'publish',
          description: '发布一条新发现，可选引用已有条目 ID。',
          side_effect: 'write',
          idempotent: false,
          help: { when: '记录经过核实的结论或补充队友的发现' },
          errors: [{ code: 'NOT_FOUND', retryable: false }],
          input_schema: { /* topic, summary, cites 字段定义（完整 Schema 见文末折叠代码） */ },
          output_schema: { /* 返回 { id, authorId, topic, summary, cites } */ },
        },
        {
          name: 'search',
          operation: 'search',
          description: '按关键词检索黑板条目（留空返回全部）。',
          side_effect: 'read',
          idempotent: true,
          help: { when: '查看队友已经发现了什么，避免重复劳动' },
          errors: [],
          input_schema: { /* 可选 query 字段 */ },
          output_schema: { /* 返回 { entries: [...] } */ },
        },
      ],
    },
    adapter: createInProcessAdapter({
      invoke({ capability, input, caller, assertAuthorized }): JsonValue {
        if (capability.operation === 'publish') {
          assertAuthorized(); // 写入共享状态前复核一次调用者权限
          const { topic, summary, cites } = input as {
            topic: string;
            summary: string;
            cites?: number[];
          };
          return board.publish(caller.agentId, topic, summary, cites);
        }
        const { query } = input as { query?: string };
        return { entries: board.search(query) };
      },
      exportState: () => board.exportState(),
    }),
  };
}
```

## 第 3 步：装配 Sandbox、角色 Profiles 与 Runtime

把前面注册好的 `board` Service 和两个权限分明的角色交给 `createRuntime()`：

```ts
// 1. 准备沙箱配置（连接本地或远程 OpenSandbox 服务）
const sandbox = createSandbox({
  lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
  apiKey: process.env.MURM_LIFECYCLE_TOKEN,
});

// 2. 注册共享黑板
const board = new FindingsBoard();
const services = new ServiceRegistry();
services.registerService(createBoardRegistration(board));

// 3. 启动 Runtime，并为两种角色划分最小权限
const runtime = await createRuntime({
  sandbox,
  executor: process.env.MURM_EXECUTOR === 'codex' ? 'codex' : 'pi',
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: { /* 读取 MURM_MODEL_URL / MURM_MODEL_TOKEN，见文末完整代码 */ },
  services,
  profiles: {
    // 3 名并行研究员：只读工作区 + 可向黑板发布和检索
    researcher: {
      prompt: '你是并行调研小组的成员。检查工作区文件，用 `swarm board search` 查看队友进展，用 `swarm board publish` 发布独立发现或引用补充队友条目。',
      model: 'default',
      image: DEFAULT_WORKER_IMAGE,
      writable: false,
      services: { board: ['publish', 'search'] },
    },
    // 综合员：可写报告文件 + 仅对黑板只读 + 结束前自动导出 report.md
    synthesizer: {
      prompt: '用 `swarm board search` 读取全部团队发现，核对引用关系，在工作区写入简明清晰的 `report.md`。',
      model: 'default',
      image: DEFAULT_WORKER_IMAGE,
      writable: true,
      services: { board: ['search'] },
      collect: { paths: ['report.md'], includeGit: false, maxBytes: 1_048_576, required: true },
    },
  },
  maxAgents: 4, // 3 名研究员 + 1 名综合员
  outputDir: './swarm-runs',
});
```

## 第 4 步：编写 Swarm 并行控制循环（事件驱动）

先写一个小型辅助函数 `runTurn()`，把“发消息 + 等待 `settled` 事件”封干净，这样后面并行驱动 3 名研究员时代码非常直观：

```ts
// 按 agentId 记录当前正在等待收束的 Promise 回调
const waiters = new Map<string, (outcome: string) => void>();

// 务必在 spawn / send 之前订阅事件
const unsubscribe = runtime.onEvent((event) => {
  if (event.type === 'settled') {
    const resolve = waiters.get(event.agentId);
    if (resolve) {
      waiters.delete(event.agentId);
      resolve(event.outcome);
    }
  }
});

// 向指定 Agent 发送一轮任务并等待它收束
async function runTurn(agentId: string, text: string, requestId: string): Promise<string> {
  let resolveTurn!: (outcome: string) => void;
  const done = new Promise<string>((r) => { resolveTurn = r; });
  waiters.set(agentId, resolveTurn);

  const receipt = await runtime.send(agentId, text, { requestId, mode: 'followUp' });
  if (receipt.status !== 'accepted') {
    waiters.delete(agentId);
    throw new Error(`输入未被接纳: ${receipt.status}`);
  }
  return done;
}
```

现在用 `Promise.all` 并行驱动 3 名研究员完成两轮自主协作，再交给综合员收束：

```ts
// 1. 并行启动 3 名研究员（每名都拿到同一份只读项目文件）
const peers = await Promise.all(
  [1, 2, 3].map((i) =>
    runtime.spawn({ requestId: `spawn-r${i}`, profile: 'researcher', files: seedFiles }),
  ),
);

// 2. 第 1 轮：三名研究员并行从不同视角自由探索并发布发现
await Promise.all(
  peers.map((peer, i) =>
    runTurn(
      peer.id,
      `调研目标：${goal}\n你是研究员 #${i + 1}，请先检索黑板再发布你独立发现的关键问题。`,
      `r1-peer-${i + 1}`,
    ),
  ),
);

// 3. 第 2 轮：保留原会话上下文，互相查阅队友第 1 轮条目并引用/补充盲区
await Promise.all(
  peers.map((peer, i) =>
    runTurn(
      peer.id,
      '请调用 `swarm board search` 阅读所有队友刚才发布的发现，针对遗漏点或不同看法补充一条带 `cites` 引用的新条目。',
      `r2-peer-${i + 1}`,
    ),
  ),
);

// 4. 释放研究员容器并唤醒综合员产出最终 report.md
await Promise.all(peers.map((peer) => runtime.stop(peer.id)));
const synth = await runtime.spawn({ requestId: 'spawn-synth', profile: 'synthesizer', files: seedFiles });
await runTurn(synth.id, `基于黑板上共 ${board.search().length} 条发现，整合撰写 report.md。`, 'synth-1');

// 5. 归档并校验清理回执
const receipt = await runtime.close({ timeoutMs: 60_000 });
unsubscribe();
console.log('黑板条目数:', board.search().length, '清理状态:', receipt.cleanup);
```

## 第 5 步：运行并在 Trace Viewer 中回放

跑完后直接打开内置 Trace Viewer，就能在泳道图里清楚看到 3 名研究员并发推理、跨 Agent 读写黑板以及综合员收尾的全过程：

```bash
npx tsx run-swarm.ts
murm trace --root ./swarm-runs --port 8787 --open
```

<details>
<summary>展开查看完整可运行代码（含完整 JSON Schema 与严格 TypeScript 类型，可直接保存运行）</summary>

先初始化目录并安装 `@luna-shi/murm`：

```bash
mkdir research-swarm && cd research-swarm
npm init -y && npm pkg set type=module
npm install --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

### 完整文件 1：`board.ts`

```ts
export interface Finding {
  id: number;
  authorId: string;
  topic: string;
  summary: string;
  cites: number[];
}

export class FindingsBoard {
  private entries: Finding[] = [];

  publish(authorId: string, topic: string, summary: string, cites: number[] = []): Finding {
    for (const refId of cites) {
      if (!this.entries.some((e) => e.id === refId)) {
        throw Object.assign(new Error(`Referenced finding #${refId} does not exist`), {
          code: 'NOT_FOUND',
        });
      }
    }
    const entry: Finding = { id: this.entries.length + 1, authorId, topic, summary, cites };
    this.entries.push(entry);
    return entry;
  }

  search(query = ''): Finding[] {
    const q = query.trim().toLowerCase();
    return q
      ? this.entries.filter((e) => `${e.topic} ${e.summary}`.toLowerCase().includes(q))
      : [...this.entries];
  }

  exportState() {
    return { total: this.entries.length, entries: this.entries };
  }
}
```

### 完整文件 2：`board-service.ts`

```ts
import {
  createInProcessAdapter,
  type JsonValue,
  type ServiceRegistration,
} from '@luna-shi/murm';
import { FindingsBoard } from './board.js';

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    authorId: { type: 'string' },
    topic: { type: 'string' },
    summary: { type: 'string' },
    cites: { type: 'array', items: { type: 'integer' } },
  },
  required: ['id', 'authorId', 'topic', 'summary', 'cites'],
  additionalProperties: false,
} as const;

export function createBoardRegistration(board: FindingsBoard): ServiceRegistration {
  return {
    manifest: {
      contract_version: '2',
      id: 'board',
      title: 'Shared Research Board',
      purpose: 'Publish, search, and cite findings across parallel swarm researchers.',
      provider_version: '1.0.0',
      endpoint: { transport: 'in-process' },
      capabilities: [
        {
          name: 'publish',
          operation: 'publish',
          description: 'Publish a verified finding and optionally cite prior finding IDs.',
          side_effect: 'write',
          idempotent: false,
          help: { when: 'After discovering or cross-checking a concrete fact' },
          errors: [{ code: 'NOT_FOUND', retryable: false }],
          input_schema: {
            type: 'object',
            properties: {
              topic: { type: 'string', minLength: 1, maxLength: 120 },
              summary: { type: 'string', minLength: 1, maxLength: 2000 },
              cites: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 8 },
            },
            required: ['topic', 'summary'],
            additionalProperties: false,
          },
          output_schema: FINDING_SCHEMA,
        },
        {
          name: 'search',
          operation: 'search',
          description: 'Search findings published on the shared board (empty returns all).',
          side_effect: 'read',
          idempotent: true,
          help: { when: 'Before publishing or during synthesis' },
          errors: [],
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string', maxLength: 120 } },
            additionalProperties: false,
          },
          output_schema: {
            type: 'object',
            properties: { entries: { type: 'array', items: FINDING_SCHEMA } },
            required: ['entries'],
            additionalProperties: false,
          },
        },
      ],
    },
    adapter: createInProcessAdapter({
      invoke({ capability, input, caller, assertAuthorized }): JsonValue {
        if (capability.operation === 'publish') {
          assertAuthorized();
          const { topic, summary, cites } = input as {
            topic: string;
            summary: string;
            cites?: number[];
          };
          return board.publish(caller.agentId, topic, summary, cites) as unknown as JsonValue;
        }
        const { query } = input as { query?: string };
        return { entries: board.search(query) } as unknown as JsonValue;
      },
      exportState: () => board.exportState() as unknown as JsonValue,
    }),
  };
}
```

### 完整文件 3：`run-swarm.ts`

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
  createSandbox,
  type FileTree,
} from '@luna-shi/murm';
import { FindingsBoard } from './board.js';
import { createBoardRegistration } from './board-service.js';

const goal =
  process.env.SWARM_GOAL ??
  '审查工作区中的缓存实现，找出并发安全与内存泄漏隐患，并提出修复方案。';

const seedFiles: FileTree = {
  'cache.ts': {
    encoding: 'utf8',
    data: [
      'export class SimpleCache<V> {',
      '  private store = new Map<string, { value: V; expiresAt: number }>();',
      '  set(key: string, value: V, ttlMs = 60_000) {',
      '    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });',
      '  }',
      '  get(key: string): V | undefined {',
      '    const hit = this.store.get(key);',
      '    if (!hit || hit.expiresAt < Date.now()) return undefined;',
      '    return hit.value;',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
};

const board = new FindingsBoard();
const services = new ServiceRegistry();
services.registerService(createBoardRegistration(board));

const sandbox = createSandbox({
  lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
  apiKey: process.env.MURM_LIFECYCLE_TOKEN,
});

const modelUrl = process.env.MURM_MODEL_URL;
if (!modelUrl) throw new Error('请先设置 MURM_MODEL_URL');

const runtime = await createRuntime({
  sandbox,
  executor: process.env.MURM_EXECUTOR === 'codex' ? 'codex' : 'pi',
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      upstream: {
        url: modelUrl,
        headers: process.env.MURM_MODEL_TOKEN
          ? { authorization: `Bearer ${process.env.MURM_MODEL_TOKEN}` }
          : {},
      },
    },
  },
  services,
  profiles: {
    researcher: {
      prompt:
        '你是并行调研小组成员。阅读工作区文件，调用 `swarm board search` 查看队友进展，并调用 `swarm board publish` 发布具体、可核验的发现。',
      model: 'default',
      image: process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE,
      writable: false,
      services: { board: ['publish', 'search'] },
    },
    synthesizer: {
      prompt:
        '调用 `swarm board search` 读取团队全部发现与引用链，在工作区写入结构清晰的 `report.md`。',
      model: 'default',
      image: process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE,
      writable: true,
      services: { board: ['search'] },
      collect: { paths: ['report.md'], includeGit: false, maxBytes: 1_048_576, required: true },
    },
  },
  maxAgents: 4,
  outputDir: './swarm-runs',
});

const waiters = new Map<string, (outcome: string) => void>();
const unsubscribe = runtime.onEvent((event) => {
  if (event.type === 'settled') {
    const resolve = waiters.get(event.agentId);
    if (resolve) {
      waiters.delete(event.agentId);
      resolve(event.outcome);
    }
  }
});

async function runTurn(agentId: string, text: string, requestId: string): Promise<string> {
  let resolveTurn!: (outcome: string) => void;
  const done = new Promise<string>((r) => { resolveTurn = r; });
  waiters.set(agentId, resolveTurn);

  const receipt = await runtime.send(agentId, text, { requestId, mode: 'followUp' });
  if (receipt.status !== 'accepted') {
    waiters.delete(agentId);
    throw new Error(`Input not accepted for ${agentId}: ${receipt.status}`);
  }
  return done;
}

try {
  const peers = await Promise.all(
    [1, 2, 3].map((i) =>
      runtime.spawn({ requestId: `spawn-r${i}`, profile: 'researcher', files: seedFiles }),
    ),
  );

  // 第 1 轮：并行独立调研
  await Promise.all(
    peers.map((peer, i) =>
      runTurn(
        peer.id,
        `目标：${goal}\n你是研究员 #${i + 1}，请检查 cache.ts 并向 board 发布你的核心发现。`,
        `r1-peer-${i + 1}`,
      ),
    ),
  );

  // 第 2 轮：交叉查阅与引用补充
  await Promise.all(
    peers.map((peer, i) =>
      runTurn(
        peer.id,
        '请调用 `swarm board search` 查看队友全部条目，针对盲区或争议点补充一条带 `cites` 引用的新条目。',
        `r2-peer-${i + 1}`,
      ),
    ),
  );

  await Promise.all(peers.map((peer) => runtime.stop(peer.id)));

  // 综合员汇总并导出 report.md
  const synth = await runtime.spawn({
    requestId: 'spawn-synth',
    profile: 'synthesizer',
    files: seedFiles,
  });
  await runTurn(
    synth.id,
    `请基于黑板上全部 ${board.search().length} 条发现，撰写最终的 report.md。`,
    'synth-1',
  );
} finally {
  const receipt = await runtime.close({ timeoutMs: 60_000 });
  unsubscribe();
  console.log(
    JSON.stringify(
      {
        runtimeId: runtime.id,
        findings: board.search().length,
        cleanup: receipt.cleanup,
        reportPath: receipt.reportPath,
      },
      null,
      2,
    ),
  );
}
```

</details>

## 下一步：按你的需求演进这套 Swarm

学会最小 Swarm 之后，你可以沿着四个方向自由扩展——底层 Runtime 一行都不用改：

| 你想增强的能力 | 怎么做 | 参考内置实现 |
| --- | --- | --- |
| **实时推送重要消息** | 在 `publish` 后向其他正在忙的研究员调用 `runtime.send(..., { mode: 'steer', wakeIfIdle: false })` | [Subagents](harnesses/subagents.md) · [PeerMesh](harnesses/peermesh.md) |
| **避免多人改同一任务** | 在黑板上加入带超时回收的独占认领，并在抢到任务后再用 `files.replace({ writable: true })` 解锁写权限 | [TaskPool](harnesses/taskpool.md) |
| **接入外部验证器或已有 Python 服务** | 保留你已有的 Python / Lean / SQLite 后端，通过 `createHttpJsonAdapter` 挂载成 HTTP Service | [Services 与权限](services.md#3-接入外部-http-service复用-python--go--已有后端) · [Substrate](harnesses/substrate.md) |
| **打包进统一 CLI** | 导出 `runHarness(context)` 函数，用 `murm --harness ./my-swarm.mjs --prompt "..."` 运行 | [CLI 参考](reference/cli.md) |

---

**下一部分**：看看仓库已经为你准备好的五种成熟多智能体协作机制——**[选择内置 Harness](harnesses/index.md)**。
