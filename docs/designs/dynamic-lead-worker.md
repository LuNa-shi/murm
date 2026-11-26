# 动态 Core 与 Lead–Worker：待实现设计

> 状态：已确认的目标设计，尚未成为当前 SDK。实施与验收见 [#235](https://github.com/LuNa-shi/murm/issues/235)。当前行为见 [Core Runtime](../architecture/15-core-runtime.md) 和 [固定 Lead-Worker](../architecture/20-lead-worker-harness.md)。

本设计记录 owner 在 2026-11-26 确认的扩展，由 [#235](https://github.com/LuNa-shi/murm/issues/235) 跟踪实施与证据。原始核查基线为 [`a6049b1a`](https://github.com/LuNa-shi/murm/commit/a6049b1a227ca0b2d997879c4eae0635d1634915)，本设计复核基线为 [`b7d23b9c`](https://github.com/LuNa-shi/murm/commit/b7d23b9c16043fbdaf4a269c7ad086f5d013b792)。Q2 首版的冻结配置和历史验收按当时版本解释。本文规定后续目标。已运行 Agent 的模型、镜像和系统提示热替换、同 ID 服务替换、通用插件加载、跨 Run 服务共享、宿主崩溃自动恢复、完整输入消费追踪及 Trace Viewer 改版均留在本次扩展范围之外。

## Runtime 合同

执行者、模型连接和凭据、资源容量、部署与管理委派上限由宿主在启动时确定。`createRuntime({ profiles, services, ... })` 仍复制初始对象。登记通过 Runtime 的公开接口完成。已建 Agent 持有固定 Profile ID 和定义摘要，模型、镜像、初始角色说明、Session 和工作目录保持原样。

| 公开入口 | 输入和结果 |
| --- | --- |
| `runtime.profiles.register/get/list` | 用 `requestId`、ID 和完整定义登记不可变 Profile，返回 ID 和定义摘要。查询统一覆盖初始与动态定义。 |
| `runtime.services.register/get/list/retire` | 登记已经 ready 的 manifest、adapter、部署引用及归属。退役以 Service ID、`requestId` 和有界期限发起，返回退役或仍待排空的状态。 |
| `runtime.access.get/grant/revoke` | 读取当前实例权限和版本；按 Agent、Service 和 operation 增删权限。变更携带 `requestId`，grant 可携带受信 binding 引用。 |
| 管理快照与订阅 | 快照携带变更编号，增量可无遗漏衔接；公开查询和事件隐藏秘密。 |

登记复用现有校验，检查模型别名、执行者能力、资源配置及引用的 Service operations。Profile 和 Service ID 在同一 Run 内不可覆盖或复用。spawn 沿用现有实现和 Slot 规则，在分配资源前确认所引用的 Service 仍可用。运行中新增定义和服务目录与初始定义使用同一校验、查询及调用路径。

Service 发布须完成校验和 readiness，并在 Runtime 仍接纳时一次提交。退役开始即拒绝新发现、调用、授权和依赖该服务的 Profile/spawn；已接纳调用可按原期限排空。超时保留可查询、可重试的 retiring/pending 状态。必要状态导出先于销毁，close 复用已完成的导出。退役后保留定义、部署引用和业务历史。

实例权限从 Profile 初始化，可撤销其中原有权限。Bridge 发现、分发和 `assertAuthorized()` 读同一实例状态。grant 仅在 Agent 可工作且为 idle/running 时接纳；首次绑定可接收宿主提供的可信引用，后续增减操作沿用该绑定，冲突需拒绝。有效变更确定排序并递增版本；重复请求复用旧结果。Core 的授权变更本身不触发模型轮次。初始 prompt 中的目录是启动快照，后续目录由 Agent 通过 CLI 查询；Harness 发出的目录变化通知携带关联 ID。

撤权使受影响的在途授权失效并发出取消信号。合作式 in-process adapter 必须将 `assertAuthorized()` 和同步副作用放在同一无 `await` 的提交段。重新 grant 使用新授权代次，旧调用继续失效。撤权保留已经发生的副作用；对发出的 HTTP 请求，无法确认远端结果时保留 unknown/pending。退役期间的排空同样受撤权及 Runtime 关闭约束。

管理操作按 Run、可信 caller、operation、target 和 `requestId` 去重。同请求同参数复用结果，参数冲突拒绝；unknown 以原请求核对。服务登记同时核对部署与实现身份。部署和增员在创建资源前建立回执身份。关闭开始后拒绝新登记、grant 和 spawn，宿主仍可查询原请求并继续撤权、退役、停止和清理。迟到的资源列入关闭清单。该保证以同一个存活宿主进程为边界。受控记录保留初始配置和变更历史，以及非秘密定义、实现/部署引用、源码摘要、可信 caller、请求、授权版本、调用接纳和收尾回执。

## Agent 入口与资源归属

| Agent 入口 | 权限和执行归属 |
| --- | --- |
| `swarm agent access_get/grant/revoke` | 现有内置 `agent` Service 检查管理 operation、目标成员和可委派 operations，再调用 Core `runtime.access.*`。Core 保存唯一有效权限与版本。 |
| `manage.profile_register/get/list` | 可选安装的管理 Service 使用 Bridge 可信 caller，将请求交给 Core Profile 注册表。 |
| `manage.service_deploy/register/get/list/retire` | Harness 部署组件负责程序启动、readiness 和停止；Core 负责可用 Service 接入及退役。 |
| `team.spawn_member` 和原请求查询 | 现有 Lead–Worker Harness 准备业务身份、调用同一个 Core spawn、登记成员并确认就绪。 |

CLI 使用现有 Bridge 和 Service v2 manifest、schema、help。管理能力默认关闭。宿主授予的委派范围可以匹配本 Run 内由合规 Lead 创建的 Service operations，无需预列未来 ID。受保护的 Service 和管理入口、跨团队目标、自提权、未知引用以及配置之外的部署目标须拒绝。通用 `agent.spawn` 保留静态 `spawnProfiles` 合同。

Harness 从调用者自己的工作目录捕获受限路径与大小的源码/manifest，冻结字节和摘要，启动独立受管容器或沙盒，ready 后登记 HTTP JSON v2 endpoint。endpoint 与绑定由宿主派生，外部接入只接受宿主批准的配置引用。生成服务使用独立配额，主验收最多 1 个动态服务，Agent 容量另计。Run-owned 服务由 Harness 回收，创建者退出时可继续为团队提供服务；外部服务退役和关闭只分离接入，保留进程和数据。

## Lead–Worker 动态模式

现有固定团队入口继续可用。动态模式使用同一个 Board/Git 项目，初始创建 Lead 和两个直接 child Worker，`maxAgents=4`。Lead、Worker 均无通用 `agent.spawn/send`；初始配置、新 Profile 和 grant 都执行该限制。任务内容从 Board 进入调度。

`team.spawn_member` 从创建意图开始记录原请求，依次准备受限 Git 账号、凭据和分支，使用可信 bindings 调用无首次输入的 Core spawn，登记 Board/Git 成员，并提交就绪状态。成员记录实际 Agent、Profile、请求、角色、Git 身份和绑定。失败保留已创建资源和身份供原请求核对或清理；原团队和任务保持原状。任务认领由 Board 原子校验 owner，交付校验固定 commit、路径、字节和摘要。仅有 Core grant 的非成员仍受 Board/Git 拒绝。

初始就绪只给 Lead 一次完整任务，Worker 等待真实分工。调度订阅衔接 Board 快照与变更编号。就绪任务通知对应成员，准备期通知待成员 ready 后释放。新反馈、已验证交付或未完成任务的轮次结束通知 Lead，Lead 自己的 note 不触发自通知。同一 Agent 最多有一条调度中的工作输入，忙时保留并合并通知 ID，空闲后在同一 Session 继续。任务、反馈和通知 ID 可关联并去重。unknown 使用原输入请求核对，保留 owner 和部分成果；`settled` 只推进输入调度，业务结果以 Board/Git 和独立验收为准。

关闭先停管理创建、授权增加和工作投递，跟踪在途部署和成员准备。Runtime 关闭收束 Agent 与调用，保存所需 Session、文件和 Service 导出，记录退役。随后 Harness 回收本 Run 拥有的服务容器、临时账号/凭据及测试设施，保留约定的 Git、Board 和证据。在途 HTTP 尚无法确认停止写入或所需导出未完成时，保留资源和 pending；修复后可用原请求继续清理。汇总 Runtime 和部署资源回执。

## 任务与关闭条件

[JSONL 订单规格](../../examples/lead-worker/fixtures/spec.md)和[独立 oracle](../../examples/lead-worker/fixtures/oracle.mjs)保留为 L1/L2 的小型回归。宿主隔离执行固定 commit，将真实退出码和 stdout/stderr 交给 oracle。历史真实模型订单 Run 按当时的题目和候选记录。

两名原 Worker 均先开始工作并各有实质成果。Lead 经真实 CLI 部署 Service、登记新 Profile、加入 checker。checker 领取任务并检查本轮固定 Git 候选，提交带具体依据的反馈。原 Worker 经 CLI 先探测不可用，grant 后在原身份、Session、目录及 Git 身份下实际调用，revoke 后再次不可用，checker 仍可用。Lead 读取反馈，安排原 Worker 在原 Session 继续，最终代码或测试出现可追踪的变化。Lead 整合固定 commit，宿主独立验收。宿主负责设施、真实通知和判题，Lead 决定分工、管理调用、修订与整合。

### ProgramBench Pastel 真实任务

L3 使用 [#209](https://github.com/LuNa-shi/murm/issues/209) 已接入的 [ProgramBench Pastel](../../benchmarks/programbench-pastel/README.md)，实例为 `sharkdp__pastel.b60e899`。团队重建完整颜色 CLI，从新 Git 项目开始，交付原创源码和根目录 `compile.sh`。构建在离线环境生成 `./executable`。复用该实例的完整题面、公开说明和可执行参考程序。Agent 只能运行参考程序来观察行为。评测数据、已有解法及其他 Run 的产物留在宿主侧。分工由 Lead 决定。

| 固定输入 | 版本 |
| --- | --- |
| Pastel 源任务 | `b60e89932629b2d162e1ff9f3976a5a0ef1e5db9` |
| ProgramBench 评测器 | `895f65916bc5ba34a915d36da321fde0301125ad` |
| 官方测试数据 | `5954a1957b5e0d770ec2c5523506abd212806315` |
| 参考程序及评测镜像 | `programbench/sharkdp_1776_pastel.b60e899@sha256:e75597f4307bf02746598d2b7eb8ae136b9978f0c2551e04b065b14e9e5f9c4e` |

Pastel 模式为同一个动态 Lead–Worker Harness 配置任务提示、`compile.sh` 交付路径和受限的颜色检查 operation。Lead 自己编写并部署检查 Service。它接收一种公开的 Pastel 格式和颜色输入，返回独立计算的结果。宿主通过固定参考程序核对一组合法与非法输入。checker 在独立临时目录构建和运行 Lead 的固定 Git 候选，记录相同公开输入上的实际 CLI 和 Service 结果，提交带 Git 版本、差异和修订建议的反馈。第二次 Run 更换公开检查输入，保留同一道完整 ProgramBench 题、同一官方评测集和全新的 Run 资源。Core 的授权、受限部署和 Board/Git 成员入口沿用上文合同。

宿主从截止前通过 Board 提交的固定 Git 版本提取源码，在 Run 关闭后制作 `submission.tar.gz`。复用现有 ProgramBench 源码打包与独立评测，清除预编译程序，并在固定 cleanroom 中构建和运行官方测试。记录构建结果、已通过及总用例数、官方分数和基础设施错误。协作、动态权限和资源回收单独核对。部分得分保留为结果证据。任务正确性要求这次固定提交通过完整官方评测。

| 层 | 需要的证据 |
| --- | --- |
| L1 无 key 合同与故障 | 登记/授权/退役、幂等、回执丢失、并发、拒绝、未 ready、通知和任务 owner、部署失败、关闭竞争、外部服务归属、可恢复清理重试、oracle 负例及静态兼容。并发点使用明确事件/barrier。 |
| L2 原生设施和脚本模型 | 从候选包启动，使用实际 Pi/OpenSandbox、CLI/Bridge、Board/Gitea 和独立服务容器，核对并行工作、Session 连续、调用顺序、源码摘要及物理回收。L1/L2 另以合法同 Agent Bridge 绑定证明 dispatch 授权拒绝且 adapter 未执行；CLI 的目录或 manifest 拒绝按实际阶段记录。 |
| L3 真实模型任务 | 同一冻结候选完成两次独立干净的 Pastel Run。第二次使用新 Run ID、冻结的公开检查输入变体及全新动态资源。每次分别核对动态工程链、实际协作、独立任务正确性和正常清理 complete。至少一次从仓库外安装的候选包启动。 |
| L4 包外与离线复验 | 从实际 tarball 严格检查公开导入并运行附带示例。从保存的 Pastel Git 提交或等价冻结源码归档独立复验。复验在 Run 关闭、无动态 Service 和模型调用时运行固定官方评测。缺证据或任何必需项失败返回非零。历史物理清理由保存的资源回执支持。 |

真实模型批次使用 GPT‑6.1 Sol，每轮工作窗口为 15 分钟。用单调时钟封锁截止后的模型请求、工作投递及候选写入。保留平台的单次请求超时及独立清理期限，本批次采用时间作为模型用量上界，不另外设置宿主请求次数或输出 token 额度。记录实际模型请求、token 用量与未知用量回执。缺少有效授权、设施或预算时保持未通过。

启动前固定并记录 provider/model、候选提交/包、镜像和执行者、提示词、任务及评测器，以及 4 Agent/1 动态 Service 上限、CPU/内存/磁盘上限、工作/请求/清理期限、适用的 provider 额度和整批尝试上限。保留全部尝试和失败原因。相关代码、任务、提示、评测器或模型改变后重新标识候选，两次验证属于同一候选。四层均有证据、两次 L3 四项均过线、正常路径物理回收完成且文档与包一致，才满足 #235 关闭要求。实现同时更新 Architecture、实际提示词、生成的 API/存储引用、source-map 和相关中英文用户文档。
