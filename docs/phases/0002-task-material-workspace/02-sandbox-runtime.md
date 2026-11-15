# 02. Sandbox 与 Execution Runtime：隔离环境的完整生命周期

> 设计依据：[Sandbox Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119) · 总体设计：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)。
> 本文定义经本轮决定修订的目标运行边界，尚未完成真实 provider 集成与隔离验收。当前实现仍以 [architecture](../../architecture/INDEX.md) 为准。

本文回答 Bot 在哪里运行、目录/凭据/服务如何隔离、take 如何开放工作目录，以及如何证明退出后全部本地进程已停止。业务生命周期以 [01](01-model-and-runtime.md) 为准，Task、Material 和 Workspace 分别见 [03](03-task.md)、[04](04-material.md)、[05](05-workspace.md)。

## 1. 已确定的运行约束

1. **每个 Bot 使用独立临时 sandbox。** Pi、实际启用的模型路由扩展、其他扩展、Bash 和全部子进程位于同一隔离边界，至少达到 Docker 级隔离。一个 Bot 有零个或一个 E；未 take 也有真实 sandbox、费用与正常退出路径。
2. **每个新 Bot 从干净环境启动。** Runtime 创建新 Bot ID、sandbox 和 Pi Session，预留空的受保护项目目录。take 保留本 Bot 的阅读上下文，在同一 sandbox 中建立唯一 E；不会创建第二份 Pi 或复用其他 Bot 的私有状态。
3. **公开成果有两种接续载体。** Material 保存研究内容，Workspace 不可变 revision 保存项目文件树。后继不能使用前任私有目录、未公开 Git 对象、会话或缓存。
4. **服务与持久状态在 sandbox 外。** Task/Mission 与 Workspace 使用同一协调域，Context、Judge 和领域服务通过独立 API 接入；Bot 不直接访问服务数据库。
5. **Bot 使用 Pi read/write/edit/bash 与 swarm CLI。** 领域能力通过 Bash CLI/API 发现和调用，不逐操作注册裸模型工具。
6. **审计存档与研究输入分开。** 私有卷/日志可以按有限保留策略供授权审计，不能自动挂给后继。容器销毁不删除已经公开的 Material 或 Workspace revisions。
7. **不做进程恢复。** Runtime 重启只恢复资源管理和生命周期对账，不把旧 shell/Pi 现场恢复成新的研究执行。

## 2. 部署拓扑与信任边界

| 位置 | 组件和内容 | 边界 |
|---|---|---|
| 可信 Runtime | Core、Bot/sandbox 管理、provider adapter、预算、生命周期与清理对账 | 管理凭据不进入 Bot |
| 外部协调域 | Task/Mission、Workspace 模块与本地 Git Repository | Task owner、main 更新与验收冻结串行协调；Git/元数据仍需对账 |
| 外部独立服务 | Context/Material、Judge、领域服务 | 通过真实 API 通信，各自持久保存输入和结果 |
| 每 Bot sandbox | Pi、实际启用的模型路由扩展、其他扩展、Bash、CLI、项目目录、运行 scratch、子进程 | 无共享可写 Git 元数据，无其他 E 私有目录 |

sandbox 是不可信执行边界。必须假设 Bot 会运行任意 Bash、启动后台进程、读取可见环境变量、修改可写文件并尝试联网，不能把 prompt 当作隔离机制。

| 边界 | 可信控制方 | 明确禁止 |
|---|---|---|
| Sandbox Provider 管理 API | Runtime/Operator | Bot 获取管理 token、Docker socket、create/delete 或提权接口 |
| 项目与运行目录 | Runtime/可信 entrypoint | take 前写项目、替换受保护父目录、读取其他 E 私有数据 |
| Workspace Repository | Workspace 模块/Runtime | Bot 访问共享可写 .git、refs、宿主 Git 工作副本 |
| Mission/Bot/E 身份 | 服务端认证与生命周期状态 | 客户端自填 ID 冒充授权 |
| 模型与收费服务 | 有限 Mission/Bot 额度及受控调用入口 | 无约束长效密钥绕过运行预算 |
| 网络 | 显式部署策略 | 将“可联网”或 Compose DNS 当成授权依据 |

## 3. Bot sandbox 的完整生命周期

### 3.1 创建前的描述与审计

创建 Bot 时先固定 Mission/Core/Bot、sandbox 镜像 digest、Pi/CLI/extension 及实际启用的模型路由版本、服务 endpoint、网络和选工预算。此时没有 Task/E，也不伪造占位 E。

take 时再固定 Task 合同与等待关系版本、E、初始 Workspace revision/commit、Material ID/内容版本和执行额度。最初输入保留审计；后续显式 apply/save 的变化另行记录，不能把最初输入悄悄改成“最新版本”。

### 3.2 创建与启动

1. Runtime 为 Bot 创建新 sandbox，配置有限 CPU、内存、磁盘、TTL 和网络。
2. Provider 返回资源标识后，Runtime 持久绑定 Mission/Core/Bot/sandbox；只有 take 才增加 E 绑定。
3. 等待 ready 并执行健康检查；create 返回 200 不等于可运行。
4. 可信 entrypoint 创建受保护的父目录和空 `/workspace/project`，Bot 用户不能写入或替换它。
5. 在单独运行目录启动非 root worker/Pi，通过 RPC 发送稳定规范和启动消息，实际发送内容按 [06](06-prompts-and-skills.md) 记录。

Pi 的项目工具路径在启动时固定为 `/workspace/project`；会话数据库、已启用路由器的缓存、日志和临时文件不写入该目录。take 前这里为空不是项目内容为空；项目内容应通过 Workspace API 浏览。

### 3.3 目录布局与 take 前浏览

| 目录/数据 | 用途 | 权限与生命周期 |
|---|---|---|
| `/workspace/project` | 当前 E 的项目文件树 | 启动时空且受保护；take 后物化并 grant；不含 Bot 可管理的 .git |
| 独立 runtime scratch | Pi 会话、已启用路由器的数据、缓存、临时文件 | 本 Bot 可写，新 Bot 不继承；不可通过其路径替换项目父目录 |
| 凭据与绑定 | Mission 协调身份、take 后的 E 身份和 endpoint | 由可信机制注入，不进入项目版本、Material 或公开日志 |
| 诊断日志/私有审计 | 运行解释与资源对账 | 受控外部存档，不是后继研究输入 |
| Provider mounts | 明确配置的外部/临时卷 | 每项记录来源、模式和生命周期，不动态假设热挂载能力 |

未绑定 Bot 使用 `swarm workspace files/read/search --at R` 浏览指定公开 revision；查询 main 时服务返回实际解析出的 revision。没有本地只读 clone，也不要求为 take 前浏览挂载整份仓库。Material 使用 Context API 读取正文与附件。

### 3.3.1 Take 的唯一授权顺序

Sandbox 已经启动，不默认依赖运行中 attach 新 volume。OpenSandbox 1.2.0 的 volume readOnly 是创建参数，未确认运行中 RO/RW mount 切换；因此使用固定预留目录和可信文件传输/exec。

顺序严格与 [01](01-model-and-runtime.md) 一致：

1. Task 协调域原子预留并建立 preparing E，项目目录仍不可写。
2. Runtime 解析初始 revision，从外部 Repository 导出完整文件树，通过受信任接口写入 `/workspace/project`，验证文件清单与摘要。
3. 确认环境和输入就绪后，协调域将 E 置为 active；Bot 尚未拿到贡献绑定，项目仍不可写。
4. Runtime 复核生命周期版本和 E 状态，再授予当前 Bot 项目写权限。
5. 原子交付受保护的 E 绑定，返回 take 成功；四基础工具随后操作同一项目目录。

不得把第 4 步放在第 3 步之前：take 前的后台进程也可能在目录变得可写时立即写入。内部 active 与向 Bot 返回成功不同；在 active→grant→绑定之间失败，必须关门、撤销 E 资格并停止/隔离 sandbox，不能留长期半激活状态。

grant 与 abort/finish 按 sandbox 生命周期版本排序。迟到的 provider 响应不能重新授权已结束 Bot；不可取消的调用完成后仍须继续清理，不复用该环境。

**实现门槛：** 在固定 provider/镜像上证明运行中可信写入、清单校验、非 root grant、受保护父目录和失败撤销。若文件 API 不能满足该合同，修正 adapter/初始化方式；不得退化成只在 CLI 或 prompt 中拒写。它是实现验证门槛，不是另一套待决定的生命周期。

### 3.4 执行、save 与显式 apply

- Pi、实际启用的模型路由扩展、其他扩展、Bash 和所有子进程都留在本 Bot sandbox；四基础工具看到同一 `/workspace/project`。
- Runtime 管理全部 Git。Bot 修改普通项目文件，再通过 `workspace save` 请求保存一致文件树；只有持久成功返回的 revision 才是公开成果。
- 同一 active E 可显式 `workspace apply --from R/main`。Runtime 将来源版本与当前工作树做受控整合，保留本地改动和冲突信息；不是逐文件盲拷贝，也不重新创建 Bot/E。
- 初始 revision 保持原记录。apply 后的工作树在 save 前不能冒称新的持久 revision；记录已应用来源、最后保存版本以及 dirty/conflicts，详见 [05](05-workspace.md)。
- main 不会在后台覆盖当前目录。项目文件更新不包含私有会话、凭据或审计历史。
- 服务端验证身份、操作权限和预算；网络可达不代表可贡献。
- Runtime 监督模型、进程、TTL、资源和服务费用；模型停止输出不等于后台进程已停止。

### 3.5 软收尾与 finish

软提醒期间 E 仍 active，Runtime 给出有限的保存/发布/finish 窗口。服务允许保存已有文件树和研究内容，不再接受扩展工作、新计算或 main merge。窗口结束前，Bot 确认持久结果后提交四种之一的 finish；未绑定 Bot 使用 bot exit。

finish 持久受理后：

1. E 进入 closing，服务拒绝新的贡献；Runtime 撤销项目写入资格。
2. 停止 Pi、已启用的模型路由扩展、Bash 和全部子进程；不能只发送“请停止”的文本。
3. 确认停止或隔离后关闭 E，条件释放 Task owner，按记录更新 Task 结果。
4. 销毁 sandbox 和临时目录；保留外部 Material、Workspace revisions、请求结果及受控审计。
5. 只在允许安全补位且有启动条件时分配 Core，不因空闲立即热重启。

硬上限、崩溃或强制终止不承诺最后一次保存。只承认此前已成功持久化的内容，不从私有目录自动生成公开成果。正常 soft grace 与接受 finish 后的 closing 必须在日志和权限中区分。

### 3.6 未绑定退出、重启与回收

无 E 且无未决 take 时，实际选工预算耗尽以 `bot exit --reason selection-budget` 持久记录并结束 sandbox。开放 Mission 仍有预算而暂无可领 Task 时，Bot 继续查找验收缺口并提案。清理用 Bot/sandbox 标识工作，不能假设每个资源都有 E。已有受理的 Mission submission 由外部服务继续持有，不依赖 Pi 存活。

Runtime 依据事件和有上限的退避恢复选工，不在同一无进展状态下持续创建 Bot。Provider 删除响应丢失时保留资源记录；未确认停止/隔离前不重新分配同一 Core。已确认隔离的残留资源可异步删除，但不能丢失其清理责任。

## 4. 文件权限、凭据与预算边界

### 4.1 本地文件权限

- `/workspace/project` 及其父目录由可信初始化控制；take 前非 root Bot 不能写、chmod/chown 提权或替换父目录。
- grant 仅发生在 E active 后，且只开放当前项目工作目录。
- scratch 的可写权限不能成为访问其他 E、宿主机或项目父目录的旁路。
- finish 后先停止接纳贡献，再停止全部本地进程；不能仅以凭据文件删除作为撤权证明。
- 导出文件树拒绝路径穿越、危险符号链接与外部路径，不信任 .gitignore 充当安全规则。

### 4.2 身份与配置

- Sandbox Provider 管理凭据只留在 Runtime/Operator，Bot 不获得管理 token 或 Docker socket。
- 未绑定阶段有受限 Mission 协调身份；take 成功交付 E 贡献绑定。服务在写入边界核对当前生命周期，不相信客户端自填 ID。
- 明确授权的依赖修复、无 owner Task cancel、Material unsupersede 和 Mission submit 是受限协调操作；unsupersede 只撤销 04 规定的匹配替代关系，它们均不授予 Material 正文发布或项目写权限。
- 凭据/绑定由可信机制注入，不进入初始 prompt、公开成果、Workspace revision 或日志。
- 启动前清理继承环境并做真实泄漏验证；即使删除 token 文件，服务端仍检查旧身份已失效。
- 同一 Bot 的子进程可能读取其业务凭据，因此这些凭据本身必须有 Mission/E 范围和有限额度；不能依赖“Bot 大概不会读取”保护费用。

### 4.3 有限预算是实现门槛

启动配置给出 Mission、单 Bot、选工、最终验收与收尾的有限上限、单位和计费口径。Runtime/服务要计入已发生及已承诺的并发消耗；模型和收费服务使用能执行这些限制的入口或凭据，不将无约束密钥留给 Bot 绕过计量。

已接受长操作的最大消耗和取消方式在其服务合同中确定。结束 Bot 不退回已发生费用，也不让后台操作获得无限尾部额度。真实集成验证并发接纳、模型断连、Bot 退出后操作继续和硬停止；这些是已确定要求的数值配置与验收，不增加通用 permit 平台或新的架构选择。

## 5. Pi、模型接入与基础工具

模型接入采用实际配置的固定版本。当前 main 的 OpenSandbox 使用 direct Pi；NuRouter 是兼容配置可选的模型路由扩展，不是目标合同的强制组件。使用该扩展时，它与 Pi 一起位于 sandbox 内，其凭据、缓存、资源消耗和停止同样受控。

目标执行栈：

1. sandbox 镜像包含固定版本的 Pi、所选扩展、swarm CLI 和项目工具。
2. Provider 启动一个受控 worker/entrypoint。
3. Worker 在 sandbox 内以 pipe/RPC 启动 Pi，提供可双向交互的输入输出通道。
4. 实际选择的模型路由扩展及其他 Pi 扩展按固定配置加载；Bash 命令和所有子进程继承 sandbox 内受限身份。
5. Runtime 将实际发送的 prompt、工具配置、skill 版本和关键事件写入外部审计记录。

OpenSandbox release-1.2.0 的源码调研给出以下限制，均需在固定版本的真实 sandbox 中再次验证：

| 已核对事实 | 对设计的影响 | 一手依据 |
|---|---|---|
| Volume readOnly 是创建参数，生命周期接口没有运行中将 RO mount 改 RW 的操作 | 第一版使用固定预留目录、可信文件传输和目录权限，不宣称 provider 支持热切换 mount | [lifecycle schema](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/specs/sandbox-lifecycle.yml) |
| Execd command 支持 uid/gid，文件接口有权限操作 | 固定非 root 启动方式，验证 Pi/Bash/子进程身份一致 | [execd schema](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/specs/execd-api.yaml) |
| prepareCommand 合并 daemon 继承环境和覆盖项 | 启动 Bot 前清理管理环境并验证无凭据泄漏 | [command environment](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/components/execd/pkg/runtime/command_argv.go) |
| /internal/init 位于免管理 token 认证的预初始化路由集合 | Bot 必须无法访问管理初始化路径；需验证部署配置是否禁用/隔离该路径 | [router](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/components/execd/pkg/web/router.go)、[handler](https://github.com/opensandbox-group/OpenSandbox/blob/62a64f0b48cdd6b410f36e53c74dc7559c87719a/components/execd/pkg/web/controller/init_runtime.go) |
| 自定义 Docker network 与 networkPolicy 的组合存在限制 | 通过实际 provider 组合验证服务网关访问；不假设 Compose DNS 自动可用 | [networking](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.0/server/opensandbox_server/services/docker/networking.py) |

这些是固定版本源码事实，不是对所有部署或后续发布的安全结论，也未在本次环境中运行绕过测试。

## 6. 服务网络与外部访问

- Task/Mission 与 Workspace 使用前述外部协调域；Context、Judge 和领域服务通过各自独立 API 接入，不因拓扑图把 Workspace 强制拆成新的独立一致性域。
- Sandbox 使用显式 endpoint，不直接访问服务数据库或依赖进程内对象。
- 服务间通过 API 调用；Docker network 可达不是身份和授权机制。
- 外网/包源按 Mission 配置。若 provider 只提供 IP/端口限制，不宣称具备域名、URL 或 SNI 限制。
- 管理 API、初始化/提权接口和宿主 socket 必须从 Bot 网络与身份中隔离。无法满足时修正适配或部署，不能静默降低边界。

## 7. 私有数据与公开成果

| 数据 | 所属方 | 后继如何取得 |
|---|---|---|
| 当前 E 未保存文件、dirty 工作树 | 当前 sandbox/E | 不自动继承 |
| Pi 会话、shell history、临时文件和缓存 | 当前 sandbox/Bot | 不继承 |
| 私有审计卷与日志 | Runtime/Operator | 后继无权作为研究输入读取 |
| Material 正文/附件 | Context | 按权限与明确 ID/版本读取，遵循修正规则 |
| Workspace revisions、main、parents | 外部 Repository | 按公开 revision 浏览，take 选起点或显式 apply |
| candidate 文件 | 对应 Workspace revision 的普通路径 | 用 workspace/revision/path 引用，跟随文件树历史保存 |

candidate 没有独立 ID、专用存储或 discard 状态。删除当前版本中的候选文件通过普通文件变更和新 save 表达，历史 revision 仍可读取。是否将保存的 revision 合入 main 是独立操作；不是每次保存都必须合入。

## 8. 故障与对账

| 故障 | 必须行为 |
|---|---|
| Sandbox 创建或 worker/Pi 启动失败 | 不宣告 Bot ready；按持久 Bot/resource 记录清理，不要求存在 E |
| Provider create 响应未知 | 查询同一创建标识/资源标签，不盲目再建第二个环境 |
| take 准备失败 | 按 01 关闭 E，确认环境停止后条件清除 owner |
| active 后 grant/绑定失败 | 撤销 E、关门清理，不将 active 当成成功交付 |
| apply/save 中断 | 按 Workspace 请求和文件树记录对账，不伪造 revision 或覆盖本地冲突 |
| finish 或 bot exit 响应丢失 | 外部持久记录继续收尾，查询原请求，不重复产生结束副作用 |
| Bot 主进程退出但子进程存活 | 停止或隔离全部进程后再释放 Core/Task |
| Runtime 重启 | 用 Bot、可选 E、sandbox 和具体请求恢复资源管理，不恢复旧 Pi 私有会话 |
| 删除失败 | 保留清理记录；未确认隔离前不复用 Core |
| 服务不可用 | 有界失败/等待，不能绕过 API 访问数据库 |
| 旧 E 的请求迟到 | 在服务写入边界拒绝 closing/closed 身份；已明确持久受理的长操作遵守自己的合同 |
| Mission 检查期间 Bot 退出 | submission 留在外部；按 01 的受理、冻结和迟到结果规则完成或释放冻结 |

## 9. 实现验证与运维配置

以下是已定合同的实现门槛，不是重新征求设计方向：

1. 固定 provider/镜像证明受保护空目录、可信文件传输、active→grant→绑定的顺序和失败撤销。
2. 证明 Pi 四工具路径一致、运行数据不混入项目版本、完整子进程树可停止。
3. 验证目录传输与 Workspace revision 的大小/耗时，配置有限磁盘和操作超时；不共享可写 .git。
4. 私有审计配置必须给出有限保留期、访问控制、存储位置与删除任务；不向后继开放私有恢复。
5. 验证 OpenSandbox 管理初始化入口、环境继承、文件 API 身份和实际网络配置。
6. 验证费用约束、未绑定退出、事件/退避补位、软收尾与硬停止。

## 10. 验收门槛

真实集成至少证明：

- 两个并发 Bot 各自运行完整 Pi/所选扩展/Bash/子进程，私有文件互不可见；
- Bot 可以未产生 E 就正常退出，Runtime 不立即无限重启；
- take 前 `/workspace/project` 空且不可写，files/read/search API 可以读取真实项目；
- 文件树准备后先 active 再 grant；提前后台 writer、迟到授权和绑定失败均不绕过生命周期；
- 同 E 显式 apply 保留初始审计和未保存改动，save 返回真实不可变 revision；
- 后继只能读取公开 Material 和 Workspace revisions，不取得前任私有目录或会话；
- provider 管理面、共享 .git、其他 E 数据和服务数据库不可访问；
- 软窗口允许保存/发布/finish，finish 接受后拒绝新贡献；硬停止不虚构未持久成果；
- Provider/Runtime 故障后能对账全部 Bot 资源，包括没有 E 的 sandbox；
- CLI 可通过逐层 help 完成真实服务调用，结果、分页、退出码、身份与费用可核对。

当前没有真实 provider 集成运行证据；上述均是后续实现验收要求，不可标记为已通过。
