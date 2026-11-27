---
title: 选择协作机制
description: 比较 murm 已实现的五种协作机制，找到各自的 SDK 接入方式与运行入口。
section: 协作机制
order: 6
---

## 在普通项目中运行

按[快速上手](../quickstart.md)安装 CLI 并完成宿主机准备，然后在项目目录直接选择 Harness 运行。默认使用启动命令时的当前目录，也可以传入 `--cwd`。运行配置支持环境变量（如 `MURM_MODEL_URL`、`MURM_MODEL_TOKEN`）或通过 `--config` 指定模块。

```sh
cd my-project
murm --harness subagents --prompt "修复解析器并补充测试"
```

内置名称包括 `subagents`、`taskpool`、`peermesh`、`substrate`、`lead-worker`、`notes`、`messages`。按示例配置执行环境。

Harness 在 murm Runtime 周围定义协作策略：启动哪些 Agent、允许它们调用哪些 Service、如何记录公共工作，以及什么时候结束运行。仓库实现了五种不同策略。它们复用 Core 的生命周期、隔离、输入投递与观察能力，协作规则由宿主代码和 Service 实现。

如果你想把 murm 嵌入自己的程序，先阅读 [SDK 指南](../sdk.md)。下面的 Harness 是可修改的仓库实现和示例，工厂函数没有作为额外的 `@luna-shi/murm` 包入口导出。TaskPool 还组合了仓库现有的 Mission、Task、Material 和 Workspace 存储；其余四种机制提供独立示例启动器。

## 比较五种机制

| Harness | 公共状态与 Service | 工作如何推进 | 交付结果 |
| --- | --- | --- | --- |
| [Subagents](subagents.md) | 保存成员路径与邮箱的 `collaboration` Service | Root 递归委派；成员发送通知、唤醒子成员，并向直属父成员返回结果 | Root 整合后的回复，以及配置要求采集的文件 |
| [TaskPool](taskpool.md) | `task`、管理 Material 的 `context`、`workspace`，以及可选的 `judge`、`mission`、`mathlib-search` | Agent 自主选 Task；排他租约授权一个 Execution；宿主替换完工或超时成员 | 发布的 Material，以及保存或合并的 Workspace 修订 |
| [PeerMesh](peermesh.md) | 软认领 Board、Mattermost 消息与 Gitea | 对等成员自主选择分支并通过聊天协调；Router 投递事件，经宿主验证的合并更新 `main` | 固定版本的公共 `main` 归档、合并回执与各成员私有归档 |
| [Substrate](substrate.md) | 提供 `publish`、`search`、`visit` 的 SQLite 不可变成果库 | 对等成员并行探索，显式引用自己采用的成果 | 发布记录、引用关系、阅读记录与私有成果；FATE 配置另加 Lean 检查 |
| [Lead-Worker](lead-worker.md) | 记录角色权限、归属与反馈的 SQLite `board`，以及 Gitea | 固定团队交替执行 Lead 定方向、Worker 并行交付 | 经验证的分支文件，以及成员读过新方向的证据 |

## 两个 Agent 想做同一件事时会怎样？

这个问题能直接看出各个 Harness 实现了什么协作规则：

- **TaskPool** 通过租约和 `fencing_version` 只接纳一个所有者。胜出的 Execution 获得文件写权限与工作阶段的模型调用许可；未绑定任务的成员保留受限的发现权限。
- **PeerMesh** 允许重叠的 `CLAIM` 意向，成员通过 Board、频道和私信自行协调。
- **Lead-Worker** 通过事务与版本检查记录唯一永久所有者。当前示例不会自动让认领过期或改派。
- **Substrate** 没有认领操作。成员可以探索相同问题，通过发布与引用交换证据。
- **Subagents** 由父成员划分职责，并通过消息或中断调整成员行为。委派本身不会锁住文件，也不会禁止重复工作。

这些规则属于 Harness 和它的 Service。Core 在各个机制中提供相同的 Agent 生命周期能力，并落实配置的权限。

## 找到运行入口

| 你希望完成什么 | 从这里开始 |
| --- | --- |
| 通过两个 Agent 和一个简单 Service 学习 SDK | [Messages 交接示例](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/README.md) |
| 委派任务，并持续向 Root 发送输入 | [Subagents 示例](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md)，支持单次与交互运行 |
| 在现有领域存储上运行有租约的任务池 | [TaskPool 宿主装配](taskpool.md#运行-taskpool) |
| 通过聊天与 Git 运行对等工程团队 | [PeerMesh 示例](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/README.md)，使用前台 JSON 行命令 |
| 并行探索问题或运行 FATE 配置 | [Substrate 示例](https://github.com/LuNa-shi/murm/blob/main/examples/substrate/README.md) |
| 运行固定团队的方向与反馈闭环 | [Lead-Worker 示例](https://github.com/LuNa-shi/murm/blob/main/examples/lead-worker/README.md) |

这些配置的团队规模、时限、依赖设施和完成条件不同。启动前请阅读对应示例的准备步骤。要定义自己的策略，继续阅读[构建自己的 Harness](../build-your-harness.md)。
