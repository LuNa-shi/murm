---
title: TaskPool
description: 同构成员默认只读浏览共享任务池、抢单后解锁写入权限、超时自动回收并把验证后的成果合并回主干。
section: 内置 Harness
order: 12
---

**TaskPool** 适合可以拆成一批独立子任务、并且允许成员完工或超时后自动换人接力的场景。所有成员一开始都是**只读**状态，只能查看待办任务和公共资料；谁成功认领了任务（拿到限时独占锁），宿主机就会把任务文件同步进它的沙箱并解锁写权限；做完验证后把改动合入公共工作区，再释放槽位换新成员继续推进。源码：[examples/taskpool](https://github.com/LuNa-shi/murm/tree/main/examples/taskpool)。

## Harness Session

模块默认导出 `Harness`。SDK Session、显式前台和 RPC 都使用这份定义。Harness 负责业务流程及资源清理。[Harness 编写指南](../first-harness.md)

`session.input({ taskId, input, mode }, { requestId })` 在受理时绑定当前 Execution、owner 和 fence。控制器在投递前再次校验，没有路径时返回 `not_submitted`。反馈作用于该次执行，Task 合同和后续尝试独立维护各自的状态。

## 快速运行（CLI）

配置好 `MURM_MODEL_URL` 与 `MURM_MODEL_TOKEN`（见 [快速上手](../quickstart.md)）后，在任意项目目录直接启动：

```bash
cd my-project
murm --harness taskpool --prompt "根据解析测试修复当前项目"
```

TaskPool 会在运行目录内自动创建 Mission 与版本化 Workspace，把提示词作为 Mission 目标：成员在发现阶段读取只读项目副本，认领 Task 后按选定版本解锁可写工作区。下文拆解其 Services、四步文件交接、租约门控与自定义装配方式。

## 研究者可用的 Service

| 注册的 Service | Agent CLI | 职责 |
| --- | --- | --- |
| `task` | `swarm task list`、`view`、`take`、`revise`、`cancel`、`link`、`finish`、`feedback` | 任务契约、依赖关系与排他 Execution |
| `context` | `swarm material list`、`view`、`publish`、`consume`、`dispute`、`supersede`、`unsupersede` | 不可变 Material 及溯源；`material` 是这个 Service 的 CLI 别名 |
| `workspace` | `swarm workspace view`、`files`、`read`、`public-diff`，以及按配置启用的 `save`、`status`、`diff`、`apply`、`merge` | 公共修订、当前私有工作与经验证的集成 |
| `judge`（可选） | `swarm judge check`、`result` | 对固定保存修订进行可信检查 |
| `mission`（可选） | `swarm mission view`、`submit`、`submission view` | 共享目标与固定公共成果的显式验收 |
| `mathlib-search`（可选） | `swarm mathlib-search search` | 检索固定版本的 Mathlib 源码 |

宿主通过 `autonomousTasks: true` 启用 `task create`。替换依赖、提交 Mission 和部分 Material 纠正操作还需要对应领域授权。仅当配置了工作区采集方式（如 `workspaceCapture`）时，`workspace` Service 才暴露当前私有文件操作；`apply` 要求 `workspaceCapture: 'core'`，`merge` 要求配置合并器。通用 CLI 帮助中出现的命令并不代表在每个 Harness 中都可用，请直接查看当前身份实际获准的 Manifest：

```bash
swarm service view task --json
swarm service view context --json
swarm service view workspace --json
swarm task list --state ready
swarm task view TASK_ID_FROM_LIST
swarm task take TASK_ID_FROM_LIST --request-id take-selected-task
```

`take` 成功后，Agent 编辑私有项目、使用已启用的 Workspace 保存能力、执行任务要求的检查，再通过 `swarm material publish` 发布证据并关联到 Task。任务、Material、修订和检查 ID 都来自真实回执。`task finish` 记录声明的完成结果，宿主随后仍需停止 Agent 并完成领域状态收尾。

## 从发现任务到获得写权限

Worker（`researcher` 角色）默认以 `writable: false` 启动，可通过 Service 阅读公共 Task、Material 和 Workspace，同时本地项目目录保持只读。成功预留 Task 后，[task-handoff.ts](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/task-handoff.ts) 按四个步骤完成交接：

1. **固定输入并保活租约**：锁定公共 Workspace 修订与关联 Material 输入，准备期间由心跳定时续租。
2. **捕获当前目录摘要**：调用 `runtime.files.snapshot(agentId, { paths: ['.'] })` 获取沙箱当前的 `complete:sha256:...` 完整摘要。
3. **激活 Execution**：在 `TaskService` 提交 `start_execution`，写入执行与交接截止时间。
4. **原子替换并解锁写入**：调用 `runtime.files.replace(agentId, { expectedDigest, files, writable: true })`，在单次 CAS 受控操作中安装任务文件并开放写权限，同时完整保留 Agent 会话。

整个准备与解锁流程完全由可信宿主执行，Agent 只能通过 `task` Service 申请任务，无法自行授予文件写权限。

预留之后的交接失败会记录失败阶段，并停止或对账受影响的 Agent；普通的任务竞争冲突不会停止未抢到任务的 Agent。

## 让模型调用服从租约

TaskPool 控制器在可信 TaskService 提交后检查 Mission、归属与截止时间，并调整计时器。归属失效、到期或收到停止请求时，控制器立即调用 `runtime.stop`。Core 撤销该 Agent 的模型权限并中止活动连接。TaskPool 依据执行停止回执释放任务归属，清理完成后才复用槽位。

这层控制与 Service 鉴权和文件权限共同工作：即使容器尚未完全停止，过期 Agent 也不能继续使用模型。完整判断见 [model-access-policy.ts](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/model-access-policy.ts)。

## 继续执行、退出与补位

[控制器](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/controller.ts) 同时观察 Runtime 事件与领域截止时间。`settled` 的 `completed` 结果表示 Agent 的一轮执行结束，不能据此认定 Task 已完成。仍在执行中的 Execution 可以收到继续工作的输入，未绑定任务的 Agent 可以收到更多发现提示。失败或中断的轮次进入失败处理。

心跳为当前租约续期，并协调截止时间、结束请求和空闲容量。Task 进入收尾后，控制器停止 Agent、协调已保存成果并完成领域状态更新，再在容量释放后启动替补。执行状态未知或清理仍待完成时，槽位不会被当成已经释放。

`completionPolicy: 'tasks'` 要求所有 Task 进入终态且控制器没有失败；`completionPolicy: 'mission'` 则要求可信 Mission 验收。完成当前可见的全部 Task，不等于满足后一种完成条件。

## 运行 TaskPool

针对普通项目目录，`murm --harness taskpool` 会直接加载内置的 [examples/taskpool/config.ts](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/config.ts)（默认使用 `DEFAULT_WORKER_IMAGE`，并读取 `MURM_MODEL_URL`、`MURM_MODEL_TOKEN` 与 `MURM_TASKPOOL_*` 环境变量），自动初始化 Mission 与 Workspace。

如需通过仓库前台运行器挂载自定义领域存储，请编写默认导出 `mode: 'taskpool'`、有限 `timeoutMs` 及 `runTaskPoolHarness` 所需 `options`（预初始化的存储、Mission/Workspace ID、Profile 与截止时间）的 ESM 模块。

构建仓库并完成宿主模块后运行：

```bash
node dist/scripts/run-harness.js --config ./my-taskpool-config.mjs
```

宿主通过 JSON 行接受 `status`、面向 Task 的 `input` 和 `stop`。定向输入会解析到当前 Execution 所有者，不是任意向某个 Agent 发送私信。最终记录包含 Runtime ID 和报告路径；[前台协议](../../architecture/17-harness-reporting.md#foreground-harness-control) 说明全部命令与结果码。

离线检查报告无需加载模型配置：

```bash
node dist/scripts/read-harness-result.js \
  --run-directory ./runs/RUNTIME_ID_FROM_RESULT \
  --runtime-id RUNTIME_ID_FROM_RESULT
```

## 实现参考

- [Harness 装配与收尾](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/harness.ts)
- [Task 接纳与文件交接](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/task-service.ts)
- [Material 发布、采集与任务结束](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/publication-services.ts)
- [TaskPool 实现手册](../../architecture/15-core-runtime.md#taskpool-model-authority-and-trusted-identity-startup)
