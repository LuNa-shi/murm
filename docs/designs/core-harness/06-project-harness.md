# 项目 Harness 的共同入口

本设计随 [#257](https://github.com/LuNa-shi/murm/issues/257) 的实施 PR 一起评审。Core 文件、事件和停止合同以 [#255](https://github.com/LuNa-shi/murm/issues/255) 的最终实现版本为准。仓库的 [Architecture](../../architecture/INDEX.md) 说明已实现的行为。

## 模块与路径

```ts
type HarnessInput = { cwd: string; prompt: string };
```

普通命令从启动目录解析相对 `--cwd`、模块路径和包名。省略 `--cwd` 时使用启动目录。解析得到的绝对项目路径和 prompt 原文构成此次任务。模型、Sandbox、Service、并发、期限和输出位置由运行配置提供。

第一版模块默认导出包含 `apiVersion: 1`、`id` 和 `run(context)` 的对象。加载器先解析内置名、显式本地 ESM 文件或从启动目录解析的已安装包入口，并校验模块形状和版本。模块使用自身的 `import.meta.url` 解析附带资源，导入时保持无运行分配、无终端 I/O。CLI 与模块使用 Node 的已构建 JavaScript 运行。

应用层宿主为 `run` 提供任务、固定初始树及其摘要、运行配置、Run ID、输出目录、AbortSignal 和状态及事件上报函数。Harness 选择用户任务的接收者和文件版本，创建 Runtime 与协作设施，并返回业务、产物和资源回执。Host 保存公共结果和报告。二者通过 AbortSignal 请求停止，资源由创建它的一方收尾。

模块可以声明运行中输入能力，并在实际路由就绪后注册处理函数。未声明时返回 `OPERATION_UNSUPPORTED`。已声明且暂未就绪时报告当前状态。就绪后回复实际接纳结果，保留已排队或未知状态。输入重试沿用原请求身份。

## 捕获与安装

1. Host 校验项目目录，选择 Run 输出目录。默认位置在项目外。显式置于项目内的 Run 目录从本次捕获范围排除。
2. Git 项目枚举选定目录内实际存在的已跟踪文件和未被忽略的未跟踪文件，读取当前工作树字节。非 Git 项目枚举普通文件。Git 管理路径排除，普通隐藏文件参与相同的选择。
3. 按 Core FileTree 校验归一化路径、对象类型、模式、原始字节与配额。使用根目录约束和文件打开前后检查抵御路径替换，在检测到源发生变化时有界重试或明确失败。选定范围内的 Gitlink 报出路径并拒绝。已加载且满足配额的 Git LFS 文件按当前字节读取，尚未加载的 LFS 指针报出路径并拒绝。空目录按 FileTree 规则没有条目。捕获记录包括选择规则、文件数量、字节量、模式和摘要。目录遍历可以检测到具体变化，整个工作树在遍历期间仍可能发生并发修改。
4. Harness 每次创建项目 Agent 时显式传入选择的树及版本来源。Core 安装到 Sandbox 的 `/workspace/project` 后才允许首轮任务。初始树捕获一次。后续成员使用它或明确选定的固定业务版本。正常运行中的写入留在 Agent 的私有工作目录，结果保存至 Run 输出目录。

Team Git 使用同一树初始化固定提交，以单次提交保存字节和模式。Agent 在首轮执行前已有该版本的项目文件。Git 初始化在已填充的目录中建立与固定版本一致的 Git 索引、远端和成员分支，保留现有项目字节。Role 脚本及控制状态存放在运行设施路径。

## 生命周期与 RPC

同一宿主运行入口接受直接 CLI 调用或 stdio RPC。RPC 进程先发 `ready`，接纳一条带 ID 的 `run`，立即回 `starting` 与 Run ID。捕获、创建和执行异步推进。进入 `running` 的依据是 Harness 上报的实际就绪状态。Core 订阅先于 spawn/send，以 `onEvent` 提示串行刷新 `get/list/state`，领域状态由 Harness 另行提供。

| 控制 | 行为 |
| --- | --- |
| `run` | RPC 从请求取得任务。复用相同 ID 与参数返回原接纳回执。改参冲突，另一启动请求被拒绝。 |
| `status` | 查询当前宿主、已知 Agent 和业务状态。启动前、启动中、运行、停止中与终态分别记录。 |
| `input` | 根据 Harness 声明和运行状态路由，串行接纳，保留原请求身份和实际回执。 |
| `stop` | 优先关闭 run/input 接纳并发出停止请求，立即回复实际状态。尚未启动时确认无活动 Run 并退出。已排队的未执行请求获得取消回执，已提交请求保留实际接纳或未知状态。 |
| `event` 和 `result` | 事件与结果带 Run ID。收尾包括必需导出、资源清理和报告保存。最终结果在正常管道上完成输出后退出。 |

Host 沿用有界 JSONL 行和命令队列。协议记录独占 stdout，诊断写 stderr。请求 ID 与规范化操作参数绑定，同 ID 改参返回冲突。普通命令使用有界队列，状态查询与停止独立于普通输入队列处理，在启动、模型等待和停止期间保持可用。单条无效命令返回 error。EOF、进程信号及管道错误触发有界停止。普通前台运行不监听 RPC EOF。退出码与 [#257 第 5 节](https://github.com/LuNa-shi/murm/issues/257) 一致。

Harness 在异步捕获、设施或 Agent 创建返回后复核停止状态。关闭后到达的创建结果进入清理或记录为 pending。公共结果保留业务结局、结束原因、产物、必需导出与清理回执、报告保存结果，列明 pending 和仍由外部拥有的设施。

## 各 Harness 的接线

| Harness | 初始任务与后续版本 |
| --- | --- |
| Subagents | Root 收到用户 prompt。Root 与 child 从选定树启动，保留委派、上下文 fork 和回传。 |
| TaskPool | Prompt 成为 Mission 目标。首个 Mission Workspace 版本和每次私有安装均保留所选树的字节、路径与模式。Workspace Service 继续对公共发布执行领域路径与授权校验。Discovery 先获得真实的私有只读项目目录。领取时按权限和原 fence 安装任务版本并开放写入。Replacement 记录所选版本来源。 |
| PeerMesh | Prompt 成为项目 issue 内容。团队 Git 从初始树建立，每个 peer 取得相应树、固定 Git 基线及成员分支。保留同伴协调与 Git 交付。 |
| Substrate | 用 prompt 开启问题，各 peer 在初始树上检索、发布和引用。FATE 保留明确的 benchmark 入口。 |
| Lead–Worker | 静态和动态入口使用同一个项目与目标。静态路径保留反馈和交付的 owner、commit、path、长度及摘要校验。普通任务可以在同一个方向上完成，不要求 supplement 或在产物写入方向全文。动态路径复用成员、管理和反馈调度。Orders 的专属提示、checker 和最终验收保留在专用适配器。 |
| Notes | Writer 根据项目和任务写入 Notes Service，reader 取回并形成可检查产物。 |
| Messages handoff | 生产者根据本次项目和任务生成交接内容，消费者通过 Service 取得后写出产物。探针的固定载荷留在测试中。 |

## 验证方式

CLI、RPC、Worker 和安装后的调用路径执行 [#257 的 A1–A12](https://github.com/LuNa-shi/murm/issues/257)。以两组不同的目录内容和 prompt 验证任务确实改变，并在 Sandbox 核对实际 cwd、字节和模式。失败测试覆盖安装前后、等待中与停止后的创建和输入竞态。以同一个候选 tarball 在 checkout 外测试内置、显式 ESM 文件和已安装包入口。五个主要 Harness 各验证一次有界真实模型协作及其产物和收尾，Notes 与 Messages 验证真实 Service 交接。结果记录绑定候选提交、包摘要和 Worker 版本。
