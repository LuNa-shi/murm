# 02. Sandbox 与 Execution Runtime：隔离环境的完整生命周期

> 设计依据：[Sandbox Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119) · 总体设计：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)。
> 本文定义第三方 sandbox 的运行边界和接入合同。当前仍是目标设计，尚未完成真实 provider 集成与隔离验收。当前实现说明以 [architecture](../../architecture/INDEX.md) 为准。

本文只回答：**一次 Execution 在哪里运行、谁创建和销毁环境、哪些目录/凭据/服务可以被访问，以及如何证明旧 Execution 结束后不能继续执行。** 不重新定义 Task、Material 或 Workspace 的业务规则。

## 1. 已确定的运行约束

来自 #119 的决定：

1. **每个 Bot/Execution 使用独立、临时的第三方 sandbox。** 整个 Agent 执行环境都在 sandbox 内，包括 Pi、NuRouter、扩展、Bash 和本地子进程。至少达到 Docker 级隔离；不沿用当前自建 SandboxManager 作为目标隔离后端。
2. **每个新 Bot 生命周期都从干净环境启动。** Bot 启动时创建 sandbox、新 Pi Session 和只读项目工作目录；take 前在同一 sandbox/Pi 中研究和选择 Task；take 成功后不创建第二个 sandbox/Pi，而是在当前环境建立 E 绑定并切换目录/服务权限；release 结束 E 并恢复只读权限，Bot 可继续；Bot 生命周期结束时才销毁 sandbox。后继 Bot 不继承前一 Bot 的私有文件、对话和工具历史。
3. **跨 Execution 的研究接续只通过 Material。** 后继不能引用前任 sandbox 私有目录、私有 Git 对象或临时路径作为输入。
4. **服务位于 sandbox 外。** Task、Context/Material、Judge 和启用的领域服务独立部署，各自拥有 API、持久状态和重启生命周期。sandbox 通过网络 API/CLI 调用，不共享进程对象或数据库。
5. **Agent 使用 Pi 的 read/write/edit/bash。** 业务服务通过 Bash 调用统一 swarm CLI；不为每个业务操作单独注册裸模型 tool。
6. **共享 Material 和当前 E 私有工作分别持久化。** Material 由 Context 管理；E 私有卷/运行记录可以留存用于审计，但不挂给后继 E 作为研究输入。容器删除不等于删除这些外部数据。
7. **不做进程级恢复。** 不恢复前一 E 的 Pi 进程现场，不自动继承其 shell、文件和会话；跨 E 只恢复明确发布的 Material 和 Workspace 中公开的 Git 内容。

## 2. 部署拓扑与信任边界

```text
Host / Deployment
├── Execution Runtime
│   ├── Core slots / scheduling
│   ├── Sandbox Provider Adapter
│   ├── lifecycle state and cleanup reconciler
│   └── private execution-volume manager
├── External Services
│   ├── Task Service
│   ├── Context / Material Service
│   ├── Workspace Service / local Git repository
│   ├── Judge Service
│   └── enabled domain services
└── Per Execution: temporary sandbox
    ├── Pi + provider/model adapter
    ├── NuRouter + extensions
    ├── read / write / edit / bash
    ├── swarm CLI
    ├── project working clone (from Workspace)
    ├── runtime/session scratch
    └── child processes
```

Sandbox 是不可信执行边界。即使 Bot 只收到一个 Task，也必须假设它会运行任意 Bash、启动后台进程、修改文件、读取其可见环境变量并尝试访问网络。不能把 prompt 约束当作隔离机制。

| 边界 | 信任方 | 不可信方/禁止事项 |
|---|---|---|
| Provider 管理 API | Runtime/Operator | Bot 不获得 provider 管理 token、Docker socket 或 sandbox create/delete 权限 |
| Sandbox 内部 | 当前 Execution 的 Bot 及其子进程 | 不得访问其他 E 的目录、宿主机敏感路径或服务数据库 |
| Workspace Repository | Workspace Service/Runtime | 不挂载共享可写 .git 或 main refs 给 Bot |
| Context/Material | Context Service | Bot 只能通过受权限控制的 CLI/API 读取或发布，不直接访问数据库 |
| Task/E 身份 | Runtime 与服务端认证 | 客户端自填 Task ID、环境变量或 JSON 字段不能单独构成身份 |
| 外部网络 | 显式配置的网络策略 | 不假定 sandbox 天然只能访问指定域名；需验证实际 provider 网络能力 |

## 3. 每个 Execution sandbox 的生命周期

### 3.1 创建前：准备执行描述

Bot sandbox 启动时，Runtime 准备只读启动环境；take 时再读取/确认权威服务并固定本次 Execution：
- Mission ID、Task ID、Task 合同 revision；
- 新 Execution ID、Core/Bot 运行身份；
- Workspace ID、实际 base revision/commit；
- 明确输入的 Material ID 和内容版本；
- sandbox 镜像 digest、Pi/NuRouter/CLI/extension 版本；
- 可用 Services、网络配置、资源预算和超时。

不要把动态值只存在 prompt 模板里。Runtime 必须保留最终实际创建的配置快照，以便审计这个 E 实际拿到什么。

### 3.2 创建 sandbox

1. Bot 生命周期启动时，Runtime 调用 Provider API 创建全新 sandbox，设置 CPU、内存、磁盘、生命周期 TTL 和网络配置；此时尚未绑定 Task Execution。
2. Provider 返回 sandbox ID 和连接信息；Runtime 先将 sandbox 与 Mission/Core/Bot 生命周期绑定；Task/E 在 take 成功时再绑定。
3. Runtime 等待 provider 报告 sandbox ready，再执行健康检查；不能只凭 create API 返回 200 就启动 Agent。
4. 在 sandbox 内启动受控 entrypoint/worker，由 worker 启动 Pi RPC 进程并转发 prompt、事件、steer/abort 和退出状态。
5. Runtime 通过 Pi RPC 发送稳定系统规范和本次启动消息。具体 prompt 文本由 [06](06-prompts-and-skills.md) 维护。

### 3.3 新 Execution 的干净工作目录

Bot 启动时只提供只读项目浏览能力；take 成功后 Runtime 从 Workspace 当前/指定 revision 创建 Execution 专属工作目录（独立 clone 或受控导出目录），挂载到 sandbox 并开放写权限。Bot 不接触 Workspace 主 Repository 的 .git，也不直接管理 Git。Material 通过 Context API/CLI 获取真实内容或受控附件，不从前任私有目录复制。

Sandbox 内至少区分：

| 路径类别 | 用途 | 生命周期/权限 |
|---|---|---|
| Project working directory | 当前 E 的 Workspace clone | take 激活后可写；sandbox 销毁后不自动成为后继输入 |
| Runtime scratch | Pi 会话、NuRouter 状态、临时文件和缓存 | 仅当前 Bot sandbox 可见；新 Bot 不复制 |
| Credentials/config | 当前 E 的短期服务凭据和 endpoint 配置 | 仅必要进程可读；不进入 Material/Candidate |
| Logs/diagnostics | 当前 E 的运行日志 | 按审计策略在外部留存；不作为研究材料自动发布 |
| Provider mounts | 显式配置的只读/临时卷 | 每个 mount 必须声明来源、读写模式和生命周期 |

不要把上述路径混成一个可被后继克隆的 workspace。Workspace Repository 在 sandbox 外；sandbox 内项目目录只是当前 E 的工作副本。

### 3.4 执行期间

- Pi、NuRouter、扩展、Bash 和所有子进程都必须在同一 sandbox 的隔离边界内运行。
- Pi 四基础工具应访问同一项目工作目录；Bash 创建的文件应能被 read/write/edit 看到，反之亦然。
- 服务调用通过 CLI/API 网络访问外部 Service。服务端根据可信认证验证当前 E 和操作权限；网络可达不代表有写权限。
- Runtime 监督预算、TTL、进程状态、心跳/事件和异常退出。模型输出停止不等于 sandbox 内所有后台进程停止。
- Agent 不得通过 sandbox 内命令访问 provider 管理 API、宿主 socket、其他 E 的 volume 或外部服务数据库。

### 3.5 Task release 与 Bot sandbox 终止是两件事

**v1 一个 Bot 只执行一个 Execution，因此 Task finish 或超时会结束 Bot sandbox。** Runtime 必须：
1. 阻止当前 E 发起新的服务写操作；服务端按 E 状态拒绝旧 E 的后续写请求。
2. 撤销当前 E 的项目目录写权限和贡献型服务权限。
3. 停止 Pi、NuRouter、Bash 及全部子进程；不能保留后台进程继续写入。
4. 确认 sandbox 已停止/隔离后关闭 E、释放 Task 占有并记录结果。
5. 销毁临时 sandbox 和 Execution 工作目录；Material、Candidate/main commit 等外部持久成果按各自服务合同保留。未保存的私有文件不作为后继输入。



Provider 删除响应丢失或 Runtime 重启时，reconciler 根据持久 Bot/E 状态、provider resource tags 和 sandbox ID 对账。Bot sandbox 未确认停止前，不能把 Core 重新分配给新的 Bot。

## 4. 文件系统与权限切换

### 4.1 Take 前只读、Take 后可写

本项目的业务规则是：
- 未 take：Agent 可以读 Mission、Task 列表、Workspace main 和有权限的 Material；不能写项目工作副本、发布研究成果或提交领域服务贡献。
- Bot 启动阶段：Runtime 创建 sandbox、Pi Session 和 project clone；在 take 前项目目录仍只读。
- take 成功并进入 active E：可信 Runtime 在当前 sandbox 授予项目目录写权限；服务端也验证当前 E 才接受写入。
- closing/closed：服务端拒绝旧 E 的新写请求，Runtime 停止整个 Bot sandbox 中所有进程并销毁环境。

这里的只读指项目文件与业务贡献，不是禁止操作系统内所有写入。Pi 运行目录、缓存和临时文件可能需要可写，但它们不能成为项目目录的旁路。

### 4.2 OS 权限不能只靠 CLI

不能只在 swarm workspace write 命令中拒绝写入，因为 Bot 还可以使用 Bash、Python 或其他进程直接写文件。必须在 OS 文件权限和 mount 边界实施：
- 项目目录由可信 entrypoint/Runtime 管理所有权；
- Bot 以非 root 身份运行；
- take 前目录不可写，不能 chmod/chown 或替换父目录；
- active 时只授予当前 E 项目目录写权限；
- 不挂载宿主 Docker socket、服务数据库、共享 Git 元数据或其他 E 的路径；
- 拒绝符号链接/路径穿越导出，不信任 .gitignore 作为安全规则。

### 4.3 凭据和环境变量

- Provider 管理凭据只存在于 Runtime/Operator 环境，不传入 sandbox。
- 服务凭据通过受保护的短期注入机制提供给必要 CLI/进程；不能写进初始 prompt、Material 或日志。
- 不能假设“没有主动传 token”就不会泄漏。Provider entrypoint 可能继承 daemon 环境；启动前必须清理继承环境并做真实泄漏测试。
- 凭据被撤销后，服务端仍需验证当前 E 状态；删除文件不能撤销已经被进程读取的 token。
- CLI 不接受 --execution、--bot、--task-owner 作为授权凭据。

## 5. Pi、NuRouter 与基础工具的接入

目标执行栈：

1. sandbox 镜像包含固定版本的 Pi、NuRouter、扩展、swarm CLI 和项目工具。
2. Provider 启动一个受控 worker/entrypoint。
3. Worker 在 sandbox 内以 pipe/RPC 启动 Pi，提供可双向交互的输入输出通道。
4. NuRouter 和扩展在 Pi 进程中加载；Bash 命令和所有子进程继承 sandbox 内受限身份。
5. Runtime 将实际发送的 prompt、工具配置、skill 版本和关键事件写入外部审计记录。

OpenSandbox release-1.2.0 的源码调研给出以下限制，均需在固定版本的真实 sandbox 中再次验证：

| 已核对事实 | 对设计的影响 | 一手依据 |
|---|---|---|
| Volume readOnly 是创建参数，生命周期接口没有运行中将 RO mount 改 RW 的操作 | 第一版使用固定卷和可信目录权限，不宣称 provider 支持热切换 mount | [lifecycle schema](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/specs/sandbox-lifecycle.yml) |
| Execd command 支持 uid/gid，文件接口有权限操作 | 固定非 root 启动方式，验证 Pi/Bash/子进程身份一致 | [execd schema](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/specs/execd-api.yaml) |
| prepareCommand 合并 daemon 继承环境和覆盖项 | 启动 Bot 前清理管理环境并验证无凭据泄漏 | [command environment](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/components/execd/pkg/runtime/command_argv.go) |
| /internal/init 位于免管理 token 认证的预初始化路由集合 | Bot 必须无法访问管理初始化路径；需验证部署配置是否禁用/隔离该路径 | [router](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/components/execd/pkg/web/router.go)、[handler](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/components/execd/pkg/web/controller/init_runtime.go) |
| 自定义 Docker network 与 networkPolicy 的组合存在限制 | 通过实际 provider 组合验证服务网关访问；不假设 Compose DNS 自动可用 | [networking](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.0/server/opensandbox_server/services/docker/networking.py) |

这些是固定版本源码事实，不是对所有部署或后续发布的安全结论，也未在本次环境中运行绕过测试。

## 6. 服务网络与外部访问

- Task、Context、Workspace、Judge 和领域服务部署在 sandbox 外的独立进程/容器中。
- Sandbox 通过明确配置的 service endpoint 访问服务，不直接访问服务数据库。
- 服务间通信使用服务自身 API；不把 Docker network 作为授权机制。
- 外网/包源按 Mission 配置。若 provider 只支持 IP/端口级网络策略，不宣称具有域名、URL 或 SNI 级限制。
- Provider 无法实现所需网络边界时，应调整接入方案或重新选型，不能静默降低安全要求。

## 7. 私有卷、Material 与 Workspace 的区别

| 数据 | 所属方 | 是否被后继 E 自动继承 |
|---|---|---|
| 当前 E 的项目 clone 和未提交文件 | 当前 sandbox/E | 否 |
| Pi 会话、shell history、临时文件和缓存 | 当前 sandbox/E | 否 |
| 审计日志和私有卷留存 | Runtime/Operator | 否；只供授权审计 |
| Material 正文和附件 | Context Service | 是，按 Mission 权限和显式查询 |
| Workspace main commits/revisions | Workspace Repository | 是，作为新 E 的项目基线 |
| 已保存 Workspace Candidate | Workspace Repository | 是，后继可显式查看/选择，不自动覆盖 main |

不要把 sandbox 的临时工作目录称为 Mission Workspace。Workspace 是 sandbox 外的持久 Git Repository；sandbox 内 clone 是 Execution 私有工作副本。Material 是跨 Execution 的研究内容接续载体。

## 8. 故障、重启与资源回收

| 故障 | 必须行为 |
|---|---|
| Sandbox 创建失败 | 不启动 Pi；若 Task 已预留，按 Task/Runtime 补偿路径处理，不复用半创建环境 |
| Pi/worker 启动失败 | E 不进入 active；销毁/隔离 sandbox，保留可诊断错误 |
| Provider API 超时 | 查询同一 sandbox/operation 状态；不能盲目创建第二个环境 |
| Runtime 进程重启 | 从持久 E/sandbox ID/resource tags 恢复管理，不恢复 Bot 进程现场 |
| Bot 主进程退出但子进程仍活 | Runtime 必须停止 sandbox 全部进程，不能释放 Core 后遗留后台写入 |
| Sandbox 删除失败 | 保持资源记录和清理待办；不把 Core/Task 当成可安全复用 |
| 外部 Service 暂时不可用 | sandbox 可报告错误或等待；不允许绕过 API 直接访问服务数据库 |
| 服务请求在 release 前发出、之后才到达 | Service 处理时重新检查 E 当前状态；closed/closing 的旧 E 新写请求拒绝 |

不引入进程级 checkpoint/restore，也不让后继 E 恢复前任 shell/Pi 进程。Runtime 的恢复仅指恢复对 sandbox 资源和生命周期状态的管理能力。

## 9. 尚待实现验证的关键问题

1. **Sandbox 与 Bot 的精确绑定关系。** #119 明确 sandbox 按 Execution 创建；同一个逻辑 Bot 是否跨多个 Execution 保留身份、以及 Bot ID 如何随新 Pi session 变化，需要在 01 Runtime 文档中统一定义，不能在两个文档各写一套。
2. **take 前阅读环境。** 若 Bot 在 take 前就需要读取 Workspace/Task/Material，应明确这是同一个新 E sandbox 的只读准备阶段，还是一个不绑定 E 的只读 sandbox。#119 倾向每个 E 新建 sandbox；必须与 Task 认领顺序一起设计，避免无 E 却长期占用 sandbox。
3. **本地 Git clone 的磁盘成本。** Workspace 外部 Repository 与每 E 独立 clone 的对象复用策略需基于真实实验规模测量；第一版不以共享可写 .git 换取空间。
4. **私有卷留存策略。** #119 允许私有卷用于审计，但后继不能读。需明确保留期限、磁盘位置、加密和删除策略；这不等于研究 handoff。
5. **Provider 的管理面安全。** 尤其 OpenSandbox 预初始化接口、环境继承、文件 API 身份和网络访问必须真实测试；源码检查不能替代 sandbox 边界验收。

## 10. 验收门槛

真实集成至少要证明：
- 两个并发 Bot/Execution 各自运行完整 Pi/NuRouter/Bash/子进程栈，文件系统互不可见；
- 新 E 对旧 E 私有文件、shell history、Pi 会话、工具输出不可见；
- 只通过 Material 能接续已发布内容；
- Pi 四基础工具操作同一文件工作面；
- Bot 无法读取 provider 管理凭据、Docker socket、其他 E volume、Workspace 主 .git 和服务数据库；
- take 前项目目录不可写，active 后仅当前 E 可写，closing 后旧 E 无法继续写入；
- Runtime/Provider 重启后能对账 Bot sandbox 与当前 E，能区分 E release 和 Bot 终止；
- 服务不可用、provider 超时、创建/删除失败时均不会产生重复活跃 sandbox 或提前释放 Task/Core；
- CLI 可通过 Bash help 发现和调用真实服务，stdout/JSON/退出码/错误语义符合统一合同。

当前没有 Docker/真实 provider 集成运行证据。上述均为待实现验收，不可标记为已通过。
