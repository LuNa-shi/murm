---
title: 选择 Harness
description: 横向对比 murm 内置的五种多智能体协作模式，用一条命令直接运行，或参考它们来设计自己的团队。
section: 内置 Harness
order: 10
---

**Harness** 决定了多智能体团队怎么分工、怎么交换信息、以及什么时候算完成。

`murm` 提供了**五种多智能体协作参考实现**（`Subagents`、`TaskPool`、`PeerMesh`、`Substrate`、`Lead-Worker`），外加两个轻量入门示例（`notes` 与 `messages`）。它们共用同一套沙箱、网关和轨迹观测底座，唯一区别在于协作服务和调度规则。

> **使用方式**：准备好所选示例的前置条件后，通过 `murm --harness <名称>` 选择内置 CLI 别名。每个别名加载对应 `examples/<名称>/` 目录中的普通模块。运行与改写入口见 [示例索引](../../../examples/README.md)；从零构建请看 [实战：构建 Swarm Harness](../build-your-harness.md)。

## 一条命令运行

完成 [快速上手](../quickstart.md) 后，在任意项目目录直接启动：

```bash
cd my-project
murm --harness subagents --prompt "修复解析器并补充测试"
```

内置名称包括 `subagents`、`taskpool`、`peermesh`、`substrate`、`lead-worker`、`notes`、`messages`。OpenSandbox、兼容 Worker 镜像和模型访问是共同前提；协作 Service 由所选示例负责：

| 示例 | 额外设施 |
| --- | --- |
| Subagents、TaskPool、Notes、Messages、普通 Substrate | 常规项目入口创建各自需要的进程内 Service 和存储，无须统一部署一套 Task/Context/Judge 服务。 |
| PeerMesh | 已配置的 Gitea、Mattermost，以及 MySQL 和上游 Board 进程。 |
| Lead-Worker | 已配置的 Gitea；可选动态示例还需要运行检查 Service 与候选验证器的 Docker 镜像。 |
| 可选 Lean 工作负载 | TaskPool 或 Substrate FATE 配置提供检查器与工具链，并可接入 [Mathlib Search](../../../examples/services/mathlib-search/README.md)。 |

默认 setup 准备共同的运行设施。PeerMesh 和 Lead-Worker 需要启用 `dns+nft` 的 OpenSandbox 部署来强制执行 Git 网络白名单。按各自示例配置网络和所需的应用服务。[部署职责](../../../deploy/README.md)说明哪些组件由 setup 创建、哪些组件需要预先准备并接入。

## 实现放在哪里

五种机制的协作策略和服务分别归属各自的 `examples/` 目录。通用宿主负责加载入口、采集项目和处理 RPC。内置名称加载包内的同一个项目入口。

五个例子都能单独复制到其他目录，安装候选 SDK 后在各自目录构建和启动。请按[示例索引](../../../examples/README.md#run-an-example-from-its-directory)准备候选包和外部设施。

## 五种协作模式一眼看懂

| Harness | 团队怎么协作 | 核心共享服务 | 最终产出 |
| --- | --- | --- | --- |
| **[Subagents](subagents.md)** | **层级分工**：主 Agent（`/root`）拆解任务并按需拉起子 Agent，通过邮箱收发消息、汇报结果 | 成员管理与邮箱服务（`collaboration`） | `/root` 整合后的答复与导出文件 |
| **[TaskPool](taskpool.md)** | **任务池抢单**：所有成员默认只读看任务，抢到独占任务后解锁写权限；做完或超时自动换新人补位 | 任务池（`task`）、资料库（`context`）、版本化工作区（`workspace`）与可选验证器（`judge`） | 发布的结论资料与合并到主干的代码修订 |
| **[PeerMesh](peermesh.md)** | **扁平研发小组**：没有管理员，大家在共享任务板上自由登记自己正在做的模块、在群里协商分工，各自开分支提 PR，由宿主核验合入 | 共享任务板、群聊/私信（Mattermost）与代码托管（Gitea） | 核验合入后的主干代码与每位成员的 Git 记录 |
| **[Substrate](substrate.md)** | **共享成果库**：没有任务表也不发私信，多名成员并行探索并把结论写进只增不改的数据库，通过引用彼此的成果持续迭代 | 不可变成果库（SQLite：`publish` / `search` / `visit`） | 全部研究条目、引用图谱与导出文件（支持 Lean 定理验证） |
| **[Lead-Worker](lead-worker.md)** | **主管-执行闭环**：一名主管定方向、多名成员认领子任务并交代码；系统强制主管读完一线反馈再发新方向，成员读完新方向再交代码 | 任务与反馈板（SQLite）+ 代码托管（Gitea） | 经核验的 Git 提交与每轮反馈记录 |

## 两个 Agent 同时想做同一件事时会怎样？

这个问题能立刻看清五种模式最本质的差异：

- **TaskPool**：**严格互斥**。同一任务只允许一人持有，抢到的人才能写代码并继续调用模型；没抢到的人保持只读，继续挑别的任务。
- **PeerMesh**：**登记不加锁，靠聊天商量**。多人可以同时在板上登记相近的关注区域，遇到重叠就在频道或私信里自行协调。
- **Lead-Worker**：**先到先得、认领即绑定**。通过数据库事务锁定唯一负责人，认领后不会自动过期或改派。
- **Substrate**：**自由探索、彼此引用**。没有“抢任务”的概念，大家各自推进并把有价值的结论发到库里，后面的人直接检索并引用。
- **Subagents**：**由上级统筹划分**。父节点负责拆活、用消息提醒下属或在必要时中断调整，不额外加文件锁。

## 从需求出发设计你自己的多智能体系统

如果内置模式不能完全贴合你的场景，可以按下面四个设计问题从需求反推出自己的 Harness：

| 设计问题 | 你的需求特征 | 推荐选择 |
| --- | --- | --- |
| **1. 共享状态与 Services** | 轻量实验、单机内存状态 / 需要持久查询与事务防冲突 / 已有 Python·Go·Git 验证后端 | 内存 TS 类（`createInProcessAdapter`） / 宿主机 SQLite Service / 外部 HTTP Service（`createHttpJsonAdapter`） |
| **2. 成员通信方式** | 开放探索、沉淀共享知识 / 明确上下游派活 / 长任务中途补充约束或提醒 | 共享黑板或引文库（主动读写） / 邮箱与定向消息 / `send({ mode: 'steer', wakeIfIdle: false })` 非唤醒转向 |
| **3. 分工与防冲突机制** | 写同一代码库需严格互斥 / 扁平团队协商开发 / 开放式并行研究 | 只读起步 + 独占租约 + `files.replace({ writable: true })` / 个人分支 + PR 核验 / 自由探索 + 显式引用汇聚 |
| **4. 控制循环与验收收尾** | 避免死等、避免空交付、避免容器泄漏 | 给每轮等待加超时并监听 `error` / 意外 `exit`；将 `settled.outcome === 'completed'`、**独立业务产物验收**与 **`receipt.cleanup === 'complete'`** 分开判定 |

> **动手演练**：想把这四个选择落地成一个完整可运行的多智能体项目？直接阅读 **[实战：构建 Swarm Harness](../build-your-harness.md)**。
