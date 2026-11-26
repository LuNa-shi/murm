---
title: 构建你自己的 Harness
description: 在公开 murm SDK 之上设计协作 Service、角色权限、调度与结果验收。
section: 基于 MURM 构建
order: 6
---

Harness 是使用 SDK 构建的应用。它决定谁来工作、Agent 如何共享信息，以及什么证据能够证明本次 Run 成功。可以先跑通 [SDK 指南](sdk.md) 中的 [Messages 交接示例](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services)，再按照本文改变协作机制。

角色提示词、Service 契约和宿主调度可以在应用代码中修改。如果任务还需要 Sandbox 内新增可执行程序、语言运行时或系统依赖，则需要把它们加入兼容的 Worker 镜像。

## 1. 先决定工作如何组织

先定义共享状态和需要保证的状态转换，再编写提示词：

| 设计问题 | 示例 |
| --- | --- |
| 共享状态存放在哪里？ | 宿主内存、SQLite、独立 HTTP 服务、Git 或聊天系统 |
| 谁获得工作的所有权？ | 父 Agent 委派、排他的租约 Task、软 Board 认领，或独立探索 |
| 什么触发下一轮？ | 宿主指令、收到消息、新 Task 出现，或周期性协调循环 |
| 结果满足什么条件才可使用？ | 通过 schema 的发布、经过验证的 revision、检查器通过，或导出文件核对 |
| 谁决定结束？ | Harness 的完成条件、截止时间、取消信号或工作耗尽 |

这些选择决定了协作机制。例如，从 [TaskPool](harnesses/taskpool.md) 改成 [Substrate](harnesses/substrate.md)，会改变选工和发现成果的方式，即使两者使用相同的 `spawn`、`send` 和清理接口。

## 2. 实现 Service 契约

一个 Service registration 将 **v2 manifest** 与 adapter 配对。Manifest 描述操作、schema 和副作用，adapter 实现操作，或把操作连接到已有端点。

下面是交接示例中完整的 [`messages.ts`](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/messages.ts)：

```ts
import { createHttpJsonAdapter, createInProcessAdapter, type ServiceRegistration } from '@murm/core/services';

const key = { type: 'string', minLength: 1, maxLength: 64 };
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const message = { type: 'object', properties: { key, text, author: { type: 'string' } },
  required: ['key', 'text', 'author'], additionalProperties: false };

export function createMessageService(remote?: { url: string; token: string }): ServiceRegistration {
  const manifest: ServiceRegistration['manifest'] = {
    id: 'messages', title: 'Messages', purpose: 'Pass a message to another Agent', provider_version: '1', contract_version: '2',
    endpoint: remote ? { transport: 'http-json', url: remote.url } : { transport: 'in-process' },
    capabilities: [{
      name: 'put', operation: 'put', description: 'Publish a message under a key', side_effect: 'write', idempotent: true,
      help: { when: 'Make a message available to a reader' }, errors: [{ code: 'CONFLICT', retryable: false }],
      input_schema: { type: 'object', properties: { key, text }, required: ['key', 'text'], additionalProperties: false }, output_schema: message,
    }, {
      name: 'get', operation: 'get', description: 'Read a message by key', side_effect: 'read', idempotent: true,
      help: { when: 'Read a message published by another Agent' }, errors: [],
      input_schema: { type: 'object', properties: { key }, required: ['key'], additionalProperties: false },
      output_schema: { anyOf: [message, { type: 'null' }] },
    }],
  };
  if (remote) return { manifest, adapter: createHttpJsonAdapter({ token: remote.token }) };
  const records = new Map<string, { key: string; text: string; author: string }>();
  const adapter = createInProcessAdapter({ invoke({ capability, input, caller, assertAuthorized }) {
    const { key, text } = input as { key: string; text: string };
    const previous = records.get(key);
    if (capability.operation === 'get') return previous ?? null;
    if (previous && (previous.author !== caller.agentId || previous.text !== text)) {
      throw Object.assign(new Error('A different message already uses this key'), { code: 'CONFLICT' });
    }
    assertAuthorized();
    const record = previous ?? { key, text, author: caller.agentId };
    if (!previous) records.set(key, record);
    return record;
  } });
  return { manifest, adapter };
}
```

示例定义了一条明确的协作规则：同一作者可以在同一 key 下重复发布相同内容；作者不同或内容不同则发生冲突。真实任务池需要进一步定义认领、租约和完成转换，科研资料库则需要定义发布与引用规则。

扩展实现时需要注意：

- 根据 Bridge 提供的 `caller.agentId` 判断所有权，不信任 Agent 自己填写的 author。
- 在底层状态实现所承诺的幂等性。`idempotent: true` 声明本身不会增加事务或重试机制。
- 进程内受保护的状态变更前调用 `assertAuthorized()`。使用异步存储时，需要在写入过程中保持授权检查与事务边界的一致性。
- 使用严格输入和输出 schema，让错误在 Service 边界可见。
- 如果 Run 结束时需要保存进程内状态，可以给 adapter 增加 `exportState()`。运行过程中的持久化和恢复仍属于 Service 设计。

在 `createRuntime()` 之前完成注册，再在相应 Profiles 中授权操作名称。Runtime 创建时会保存 Service registry 的快照。

### 接入已有 Service

同一个 `createMessageService({ url, token })` 可以注册 HTTP 版本。它向 `POST /v2/put`、`POST /v2/get` 发送 `{ input, envelope, caller }`，预期返回 `{ ok: true, result }`。宿主负责认证，并通过 `envelope.operation_id` 和 `Idempotency-Key` 传递操作身份。两种 adapter 对 Agent 暴露相同的 CLI。 Adapter 会发送配置的 bearer token。远端 Service 必须先认证这条宿主连接，再信任转发的 `caller`；JSON 中的调用者字段本身不构成身份认证。

注册不会启动这个服务器，也不会获得它的生命周期所有权。它可以运行在独立 Docker 容器、本地进程或独立维护的服务中。如果已有服务使用其他原生协议，可以围绕相应客户端实现 `ServiceAdapter.invoke`；[GitHub adapter 示例](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/gh-issues.ts) 在宿主通过固定命令和超时调用 `gh`。

写入结果未知时，应先用原始操作身份检查共享状态，再决定是否继续提交。HTTP 超时或响应丢失都不能证明写入没有发生。

## 3. 为每个角色授予所需操作

writer 与 reader 使用同一个 Service，但具有不同权限：

```ts
import type { Profile } from '@murm/core';

export function handoffProfiles(image: string): Record<string, Profile> {
  return {
    writer: {
      prompt: 'Publish the input file through the messages Service.',
      model: 'default', image, writable: true,
      services: { messages: ['put'] },
    },
    reader: {
      prompt: 'Read the messages Service and save the received text.',
      model: 'default', image, writable: true,
      services: { messages: ['get'] },
      collect: {
        paths: ['received.txt'], includeGit: false,
        maxBytes: 4096, required: true,
      },
    },
  };
}
```

角色提示词解释如何使用已有操作，Profile 设置 Agent 的初始权限。Bridge 按当前授权检查调用，宿主可以通过 [Runtime 管理 API](reference/api.md#runtime-管理) 更新授权。

需要委派时，内置 `agent` Service 提供 `spawn`、`get`、`send`、`stop`，`spawnProfiles` 限制可创建的子角色。只有后端支持时才启用 `allowContextFork`。也可以像 [Subagents](harnesses/subagents.md) 一样，用领域 Service 增加所有权与邮箱规则。

需要共享文件时，通过 `spawn({ workspace: { id, mode } })` 明确请求共享工作区，或使用受控文件快照与安装。谁可以发布或合入 revision，仍由 Harness 规定。直接访问外部设施时，应配置获准的 IPv4 来源，并通过 `secretEnv` 提供独立的 Agent 凭证。

## 4. 选择控制循环

### 串行交接

当消费者需要先获得生产者的已验证结果时，采用串行交接。[Messages 实现](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts) 在发送输入前建立 observation，同时消费事件和检查回执，要求匹配的 Service 操作与执行都已完成，再运行 reader，并在收尾阶段核对最终产物。

该例中，每个 Agent 只有一个独占的宿主输入源。如果 Harness 允许多个输入源并发发送，就需要自己的业务标识和核对规则；一次执行的 `settled` 事件并不能标识它处理过的所有输入。

### 委派与邮箱

当消息可能在接收方忙碌或空闲时到达，可以使用 `send({ mode: 'steer', wakeIfIdle: false })` 提供通知，避免直接启动空闲 Agent 的新一轮。如果回执为 `not-accepted` 且原因是 `idle`，Harness 可以将消息存入邮箱，留待后续投递。如果回执为 `unknown`，则应保留原 request ID 核对；把它当作确定拒绝可能造成重复工作。

[Subagents](harnesses/subagents.md) 进一步定义父子所有权和递归委派，[PeerMesh](harnesses/peermesh.md) 则在对等成员间路由聊天与任务更新。改造事件驱动协作时，应参考其完整实现，包括取消、投递错误和收尾。

### 任务池或科研循环

当任务分配或积累的成果驱动进展时，[TaskPool](harnesses/taskpool.md) 协调权威 Task 状态、租约与 Agent 容量；[Substrate](harnesses/substrate.md) 让对等成员搜索并继续构建已有成果。宿主可以根据观察更新，或通过有界的周期循环，决定继续、替换或停止 Agent。

idle Agent 仍然占用槽位。Task 完成、一次执行完成和并发容量释放是不同转换，Harness 应分别处理。

## 5. 验证结果并完成收尾

使用一次 `finalizeRun()` 记录应用结果。为清理设置独立截止时间，通过 `verifyArtifacts` 检查导出文件，只把应用拥有的资源列入 `ownedFacilities`。已有外部服务保留自己的生命周期。

分别查看报告中的业务、产物校验、Core close、设施清理和保存状态。正确答案伴随 pending 清理仍需后续处理；清理成功本身也不能证明答案正确。报告契约见 [SDK 指南](sdk.md)，资源保留规则见 [Run 生命周期](run-lifecycle.md)。

扩大新 Harness 的运行规模之前，先验证一次完整的小规模运行：预期 Service 状态转换、正确的角色权限、真实产物内容，以及所有待清理资源都有明确记录。然后检查该机制最关键的行为，例如排他认领、跨 Agent 复用或父子所有权。已有 [Harness 指南](harnesses/index.md) 分别解释了这些行为及其边界。
