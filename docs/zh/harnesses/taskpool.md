---
title: TaskPool
description: 通过排他租约、受控文件交接、持久化 Material 与版本化 Workspace 推进共享任务池。
section: 协作机制
order: 8
---

## 在普通项目中运行

```sh
cd my-project
murm --harness taskpool --prompt "根据解析测试修复当前项目"
```

TaskPool 在运行目录创建 Mission 和 Workspace。prompt 成为 Mission 目标。Discovery 使用只读项目，领取 Task 后按所选 Workspace 版本获得可写目录。 调用 TS SDK 的旧示例和基准测试专用参数见下文。

TaskPool 让一组研究者在个别 Agent 完工、超时或轮换后继续推进项目。每个 Agent 自主发现并选择 Task，发布可复用的 Material，将成果保存到公共 Workspace。宿主负责维持并发数量，并通过租约落实任务归属。

实现位于 `examples/taskpool/`，组合了 [Core SDK](../sdk.md) 与仓库现有的 Mission、Task、Material、Workspace 存储。`runTaskPoolHarness` 是仓库中的宿主函数，没有从 `@luna-shi/murm` 导出。调用它需要提供这些存储和已准备好的 Mission/Workspace，不能只传一个普通配置文件就建立完整任务池。

## 研究者可用的 Service

| 注册的 Service | Agent CLI | 职责 |
| --- | --- | --- |
| `task` | `swarm task list`、`view`、`take`、`revise`、`cancel`、`link`、`finish`、`feedback` | 任务契约、依赖关系与排他 Execution |
| `context` | `swarm material list`、`view`、`publish`、`consume`、`dispute`、`supersede`、`unsupersede` | 不可变 Material 及溯源；`material` 是这个 Service 的 CLI 别名 |
| `workspace` | `swarm workspace view`、`files`、`read`、`public-diff`，以及按配置启用的 `save`、`status`、`diff`、`apply`、`merge` | 公共修订、当前私有工作与经验证的集成 |
| `judge`（可选） | `swarm judge check`、`result` | 对固定保存修订进行可信检查 |
| `mission`（可选） | `swarm mission view`、`submit`、`submission view` | 共享目标与固定公共成果的显式验收 |
| `mathlib-search`（可选） | `swarm mathlib-search search` | 检索固定版本的 Mathlib 源码 |

宿主通过 `autonomousTasks: true` 启用 `task create`。替换依赖、提交 Mission 和部分 Material 纠正操作还需要对应领域授权。Workspace 只有在存在采集来源时才暴露当前私有文件操作；`apply` 要求 `workspaceCapture: 'core'`，`merge` 要求配置合并器。通用 CLI 帮助中出现某个命令，不代表每个 Harness 都提供它。应查看当前身份实际可见的 manifest：

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

研究者以 `writable: false` 启动。它可以通过 Service 阅读公共 Task、Material 和 Workspace，项目目录保持只读。成功预留 Task 后，[task-handoff.ts](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/task-handoff.ts) 执行交接：

1. 固定公共 Workspace 修订和引用的 Material 输入，准备期间通过心跳保持预留有效。

3. 在 TaskService 中激活 Execution，设置执行和交接截止时间。


准备文件与授予写权限是两步，因为文件准备可能在 Task 可以授权之前失败。这两个 SDK 操作都由可信宿主执行。Agent 通过 `task` Service 申请工作，不自行构造准备句柄或授予写权限。

预留之后的交接失败会记录失败阶段，并进入受影响 Agent 的停止或协调流程。普通认领冲突不会停止未抢到 Task 的 Agent。

## 让模型调用服从租约

TaskPool 控制器在可信 TaskService 提交后检查 Mission、归属与截止时间，并调整计时器。归属失效、到期或收到停止请求时，控制器立即调用 `runtime.stop`。Core 撤销该 Agent 的模型权限并中止活动连接。TaskPool 依据执行停止回执释放任务归属，清理完成后才复用 Slot。

这层控制与 Service 鉴权和文件权限共同工作：即使容器尚未完全停止，过期 Agent 也不能继续使用模型。完整判断见 [model-access-policy.ts](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/model-access-policy.ts)。

## 继续执行、退出与补位

[控制器](https://github.com/LuNa-shi/murm/blob/main/examples/taskpool/controller.ts) 同时观察 Runtime 事件与领域截止时间。`settled` 的 completed 结果表示 Agent 的一轮执行结束，不能据此认定 Task 已完成。仍在执行中的 Execution 可以收到继续工作的输入，未绑定任务的 Agent 可以收到更多发现提示。失败或中断的轮次进入失败处理。

心跳为当前租约续期，并协调截止时间、结束请求和空闲容量。Task 进入收尾后，控制器停止 Agent、协调已保存成果并完成领域状态更新，再在容量释放后启动替补。执行状态未知或清理仍待完成时，Slot 不会被当成已经释放。

`completionPolicy: 'tasks'` 要求所有 Task 进入终态且控制器没有失败；`completionPolicy: 'mission'` 则要求可信 Mission 验收。完成当前可见的全部 Task，不等于满足后一种完成条件。

## 运行 TaskPool

前台宿主接受一个可信配置模块，其默认导出包含 `mode: 'taskpool'`、有限的 `timeoutMs`，以及传给 `runTaskPoolHarness` 的 `options`。这些选项包括 Backend、领域存储、Mission/Workspace ID、Worker Profile 输入与截止时间。可运行的模块必须先初始化并绑定这些领域对象；仓库没有可直接复制的 `examples/taskpool/config.ts`。

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
