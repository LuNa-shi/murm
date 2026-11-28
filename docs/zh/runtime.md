---
title: Runtime 运行控制面
description: 从用户视角分类掌握 createRuntime 的核心能力：集群配置、事件监控、文件同步、运行期动态管理与安全收尾恢复。
section: 核心构件与实战
order: 4
---

**Runtime** 是一次多智能体运行的总控对象。准备好 [Sandbox](sandbox.md)、角色和 Services 之后，所有集群级操作——创建运行、监听事件、跨容器同步文件、动态调整配置以及最后归档收尾——都通过 `runtime` 完成。

> 完整参数类型与错误码请查 [SDK 与 API 参考](reference/api.md)。

## 1. 创建 Runtime（基础配置）

当你希望启动一次新的多智能体运行，调用 `createRuntime()` 传入五类核心配置：

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
} from '@luna-shi/murm';

const runtime = await createRuntime({
  sandbox, // 上一章用 createSandbox() 创建的隔离配置
  executor: 'pi', // 执行器：默认 'pi'，也可切换为 'codex'

  // 容器访问宿主机网关时使用的宿主机 IP（Linux Docker 网桥默认为 172.17.0.1）
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },

  // 模型别名表：上游 URL 和 API Key 只留在宿主机 Model Gateway，绝不进入容器
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      // protocol 默认 'responses'；使用 Pi 时也可设为 'chat-completions'
      upstream: {
        url: process.env.MURM_MODEL_URL!,
        headers: process.env.MURM_MODEL_TOKEN
          ? { authorization: `Bearer ${process.env.MURM_MODEL_TOKEN}` }
          : {},
      },
    },
  },

  // 可选：大项目可按阶段单独调整文件传输与导出预算（initial / snapshot / replace / export / session）
  // filePolicy: { initial: { maxBytes: 64 * 1024 ** 2 } },

  services: new ServiceRegistry(), // 预注册的共享 Services（见 Services 与权限）
  profiles: {
    researcher: {
      prompt: '分析项目代码并记录关键发现。',
      model: 'default',
      image: DEFAULT_WORKER_IMAGE,
      writable: false,
      services: {},
    },
  },
  maxAgents: 4, // 同一时刻最多活跃的 Agent 数量上限
  outputDir: './runs', // 本次运行轨迹与产物的落盘根目录（实际写入 outputDir/<runtime.id>/）
});
```

调用成功后，`murm` 会在宿主机自动初始化本次运行的目录、Model Gateway 和 Service Bridge，但**尚未启动任何容器**——具体何时启动 Agent 由你的 Harness 调用 `runtime.spawn()` 决定（见下一章 [Agent 与 Profile](agents.md)）。

> **灵活的执行器与模型选项**：除了 `'pi'`（默认 `1.3.0`）和 `'codex'`（`0.172.0`）简写外，还可以用 `createPiExecutor({ version: '1.4.0' })`、`createCodexExecutor(...)` 或 `createExecutorAdapter(...)` 指定执行器版本或自定义镜像内执行器；Pi 同时支持 **Responses** 与 **Chat Completions** 协议（详见 [SDK 与 API 参考](reference/api.md)）。

## 2. 如果你要监控运行过程：`runtime.onEvent()`

请在调用 `spawn()` 或 `send()` 之前注册监听。每个监听器最多同时保留 32 个未完成回调。回调完成后，该监听器会收到带丢失计数的 `subscriberGap`。调用 `get()`、`list()` 或 `management.get()` 可以重新同步视图。

最常用的事件对应四类常见需求：

| 你想做什么 | 监听的事件类型 | 何时产生 |
| --- | --- | --- |
| 实时打印 Agent 的回复流 | `output` | Agent 在推理过程中输出文本片段时 |
| 知道某轮任务干完了，触发下一步 | `settled` | Agent 结束当前一轮执行时（附带 `outcome: 'completed' \| 'failed' \| 'aborted'`） |
| 捕获异常或容器意外崩溃 | `error` / `exit` | 发生执行错误或容器进程退出时（`fatal` / `expected` 标明严重程度） |
| 同步刷新 UI 或内部状态表 | `agentChanged` / `runtimeChanged` / `management` | Agent 状态变化、Runtime 关闭或动态管理操作完成时 |

一个典型的宿主用法——用 `settled` 驱动流程流转：

```ts
// 记录哪些 Agent 已经完成当前轮次
const completed = new Set<string>();

const unsubscribe = runtime.onEvent((event) => {
  // 1. 实时把模型回复打印到宿主终端
  if (event.type === 'output') {
    process.stdout.write(`[${event.agentId.slice(0, 8)}] ${event.text}`);
    return;
  }

  // 2. 某个 Agent 这一轮执行结束了 → 标记完成并检查是否满足推进条件
  if (event.type === 'settled') {
    if (event.outcome === 'completed') completed.add(event.agentId);
    console.log(`Agent ${event.agentId.slice(0, 8)} 本轮结束: ${event.outcome}`);
    return;
  }

  // 3. 容器意外退出或出现错误 → 记录告警，必要时决定重试或提前终止
  if (event.type === 'error' || (event.type === 'exit' && !event.expected)) {
    console.error('运行异常:', event);
  }
});
```

## 3. 如果你要操作沙箱里的文件：`runtime.files`

默认情况下，每个 Agent 的 `/workspace/project` 相互隔离。如果宿主需要读取某个 Agent 写出的文件，或者把 A 的成果安全同步给 B，使用 `runtime.files`：

```ts
// 1. 从 coder 的私有工作区拍一份完整快照（返回文件树和 SHA-256 摘要）
const coderSnap = await runtime.files.snapshot(coder.id, {
  requestId: 'snap-coder-1',
  paths: ['.'],
});

// 2. 把快照原子写入目标 Agent 的工作区（传 expectedDigest 防止并发修改覆盖）
const receipt = await runtime.files.replace(reviewer.id, {
  requestId: 'sync-to-reviewer-1',
  expectedDigest: reviewerInitialDigest, // 来自目标 Agent 先前的一次 snapshot.digest
  files: coderSnap.files,
  // 可选：如果目标原本是只读（writable: false），传入 writable: true 可同时解锁写入
});
```

- **为什么替换时要传 `expectedDigest`？** `files.replace` 会先暂停沙箱内写进程、校验目标目录摘要未被中途改动，再原子替换全部文件（同时完整保留 Agent 原有的对话会话）。
- **多个 Agent 需要实时共享同一目录？** 在 `runtime.spawn()` 时显式传入 `workspace: { id: 'shared-repo', mode: 'read-write' }` 即可；最终导出前请先对所有写者调用 `runtime.stop()`，确保文件落盘一致。

## 4. 如果你要在运行中动态调整配置

Runtime 启动后会自动锁定初始配置，避免外部误改普通对象。若你的 Harness 需要在运行中途扩展团队或调整工具权限，可以使用三组带审计记录的管理接口：

- `runtime.profiles.register(...)`：运行中新增一种角色 Profile。
- `runtime.services.register(...)` / `retire(...)`：动态挂载新 Service，或平滑下线已有 Service。
- `runtime.access.get(...)` / `grant(...)` / `revoke(...)`：实时查询、授予或撤销某个活跃 Agent 的 Service 权限。

## 5. 结束运行与故障恢复：`runtime.close()`

任务结束或达到预算上限时，调用 `runtime.close()` 安全收尾：

```ts
const receipt = await runtime.close({ timeoutMs: 60_000 });
unsubscribe();

if (receipt.cleanup !== 'complete') {
  // 例如必选产物导出受阻或 Docker 删除超时，查看 receipt.pending 排障后重试 close()
  console.warn('存在尚未清理完成的项:', receipt.pending);
}
```

`runtime.close()` 严格执行**先归档、再销毁**：停止所有执行器 → 导出会话、Service 状态与 `Profile.collect` 声明的产物 → 确认保存完毕后再删除容器。如果中途有必选产物导出失败或容器删除超时，`receipt.cleanup` 会返回 `'pending'` 并在 `receipt.pending` 列出精确项；处理完问题后在同一个 `runtime` 上再次调用 `close()` 即可恢复。

---

**下一步**：学习如何定义角色、拉起持久化 Agent 会话、发消息与中断恢复——**[Agent 与 Profile](agents.md)**。

## 持久化恢复与 Kubernetes

应用具备可验证的恢复合同时，可在创建 Run 时开启持久化资源归属：

```ts
const options = {
  // 提供原始 sandbox、models、profiles、services 和 outputDir。
  ...applicationOptions,
  connection: {
    publicUrl: 'http://murm-runtime.murm.svc.cluster.local:3100',
    bindHost: '0.0.0.0',
    bindPort: 3100,
  },
  persistence: { deploymentId: 'cluster-a', contract: 'harness-v1', retainForMs: 900_000 },
  operationLimits: { prepare: 8, stop: 8, transfer: 4, queued: 1024, waitMs: 60_000 },
};
```

回调地址必须固定并能从所有 Worker 到达，Run 目录必须使用私有持久化存储，恢复配置必须与原合同匹配。Profile 开启网络限制时，受信回调主机名必须在 Controller 上解析为唯一的非 loopback IPv4；Core 将该 IP 与精确端口写入策略，Worker 保留原 URL。准备、停止和传输各有独立的有界队列。持久化模式的保留期默认 15 分钟，具有有限截止时间。

旧 Controller 退出后，SDK 可以重新连接同一批仍存活的 Worker：

```ts
import { recoverRuntime } from '@luna-shi/murm';

const runtime = await recoverRuntime({
  ...options,
  runDirectory: '/private/runs/original-runtime-id',
  restoreService: async definition => trustedServiceResolver(definition),
});
```

`trustedServiceResolver` 由应用实现，按持久化业务状态返回合同匹配的 Service 注册；无法恢复时返回 `undefined`。配置中重新提供原始选项和受信宿主凭据。动态注册且不在初始配置内的 Service 必须通过此入口解析。未解析的 Service 会阻止 Agent 恢复权限。Harness 调度和 Service 业务恢复需要各自的持久化合同。Core 对账原输入 ID 和 Worker 游标，不会重新发送初始 prompt。

当前接管要求同一 Linux 主机和同一次系统启动，并取得 SQLite 独占写入锁。Kubernetes 模板通过 Downward API 传入节点身份，原节点同一次系统启动期间更换 Pod 名称仍可恢复。换节点或重启节点后拒绝接管。当前没有自动 Controller 故障转移或 Worker 进程替换能力。已经进入关闭的 Run 只继续收尾。需要主动收尾时，可设置 `cleanupOnly: true` 或使用 CLI：

```sh
murm recover --run-dir /private/runs/original-runtime-id --config /private/recovery.mjs
```

配置模块的默认导出可以是原始 options 对象，也可以是返回该对象的零参数异步工厂。此命令始终只恢复清理权限，再调用 `close()`，输出回执；清理完成退出 0，仍有待处理项则退出 1。资源继续留账。必需导出失败时保留 Sandbox，并报告保留截止时间及实际 `expiresAt`；应在有限到期时间前重试。服务未确认所需保留窗口时检查 `retain-at-risk`。

`runtime.probeWorkerEvent(agentId, { requestId, timeoutMs })` 通过真实鉴权 Worker 事件链路测量 Core 的观测时间，不调用模型。当前 Worker 使用有界游标长轮询；事件缺口会暂停新工作权限并保留不确定资源。

[Kubernetes 部署配置](../../deploy/opensandbox-kubernetes/README.md) 固定官方组件并生成私有部署输入。[容量工作负载](../../benchmarks/kubernetes/README.md) 默认只输出 `not-run` 计划。2/8 档真实集群实验仍未运行。owner 后续要求 32/128/1,024 档通过本机 mock Agent API 验证正式 SDK 的接纳、持久归属、事件、导出与回收，结果明确记为 `passed-mock-api`。集群实际容量仍未验证。工作负载通过后仍需独立完成故障与恢复矩阵，才能声明容量。大规模实验开始前必须得到 owner 批准。完整归属、重试和回收流程见 [Architecture](../architecture/24-runtime-recovery.md)。

## 会话控制与 Harness 收尾

Runtime 的 session 分组针对指定 Agent 提供 configure、compact、abortRetry、clearQueue、getState、getStats 和 getMessages。结构化 context 继续经 send 提交，并明确 append、nextTurn、steer 或 followUp。配置和结果使用包根导出的 murm 类型，原生 Session 由 Guest 执行器持有，Host 使用实际确认的配置与回执。[Agent 指南](agents.md#agent-会话设置与结构化-context) 包含调用示例。

HarnessSession 整体停止时同步关闭 Runtime 和 dispatcher 的新工作接纳，既有操作仍可核对。登记 Runtime 的 Harness 负责后续 stop 或 close、归档、必需导出和物理清理。
