# 05. Workspace：Git Repository、Candidate 与 main 整合

> 设计附件：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · 状态：供审核的目标设计，尚未实现。
> 已确认：Mission 与 Workspace 一对一；Workspace 是 sandbox 外的本地 Git Repository；main 是 Git branch；版本只使用 Workspace revision，不创建 Git tag；Candidate 长期保留，不要求全部合入 main。

本文只定义 Workspace 本身：仓库与 revision、Execution 工作副本的 Git 边界、Candidate 保存/查看/discard、main 整合、并发和来源追踪。Sandbox 的创建、挂载、身份和销毁见 [02](02-sandbox-runtime.md)；Task 合同见 [03](03-task.md)；Material 内容及其 Evidence/纠错见 [04](04-material.md)。

## 1. Workspace 对象和存储职责

Mission 与 Workspace 一对一绑定，但二者是不同对象：
- Mission ID 标识共同目标。
- Workspace ID 标识该 Mission 对应的 Git Repository。
- main 是 Workspace Repository 中的普通 Git branch。
- Git commit 固定文件树内容。
- Workspace revision 是系统维护的连续版本标识，例如 0.1、0.2；第一版不创建 Git tag。

Workspace 位于 sandbox 外部，跨 Bot、Task 和 Execution 长期存在。Mission 完成或停止不自动删除 Workspace。一个 Workspace 可以保留 main 历史和 Candidate；Mission 完成不代表所有 Candidate 都必须合入。

| 对象 | Workspace 中的职责 | 不负责什么 |
|---|---|---|
| Workspace | 本地 Git Repository、main branch、revision、Candidate 元数据 | 不存研究材料正文，不替 Bot 判断研究价值 |
| main | 所有 Bot 后续可选择的共同项目基线 | 不等于 Mission 完成，也不保证每条知识主张都正确 |
| commit | 不可变文件树和父提交关系 | 不等于独立 Material |
| revision | main 每次成功更新后递增的版本标识 | 不创建 Git tag |
| Candidate | 从某个 Execution clone 导入的完整 Git commit/文件变更 | 不自动进入 main，不是 Material |
| Execution clone | 当前 E 的独立本地 Git 副本 | 不作为后继 E 的私有恢复源 |

Material 与 Git 严格分离：Material 保存可独立读取、引用和纠错的研究内容及来源；Workspace 保存项目文件和版本。Material 可以引用 Workspace revision/commit，Candidate 可以引用相关 Material ID/版本，但两者不互相替代。

## 2. Workspace Repository 与服务职责

第一版 Workspace 逻辑模块可与 Task Service 同一协调进程部署，以复用可信 Execution 身份和 Task 状态；这只是部署选择，不意味着 Workspace 是 Task 的字段。Git Repository 和 Candidate 的实际文件内容由 Workspace 模块管理。Context Service 只管理 Material，不管理 Git Candidate；Workspace 需要检查 Candidate 引用的 Material 状态时，通过 Context API 查询，不直接打开 Context 数据库。

| 责任 | 负责方 |
|---|---|
| 创建/保留 Workspace Repository、main、revision | Workspace Service / 可信 Runtime |
| 为新 E 创建独立本地 clone 并记录 base commit/revision | Runtime |
| 在 sandbox 内通过基础文件工具修改当前 Execution 工作目录 | 当前 E 的 Bot |
| 从 E clone 导出并安全导入 Candidate | 可信 Runtime + Workspace Service |
| 查看 Candidate、diff、来源和状态 | Workspace Service |
| 判断是否值得保存 Candidate、是否值得 integrate | 当前有效 Execution 的 Bot |
| 验证 E、Candidate、base revision 和更新 main | Workspace Service |
| 保存研究说明、证明、实验结果和纠错关系 | Context / Material Service |

Workspace 不需要远程 GitHub Repository。第一版使用本地 Git Repository，所有 Execution 的副本也通过本地 clone 创建。

## 3. 初始化与 Execution 工作副本

### 3.1 Mission 初始化

操作者提供 Mission 和初始项目文件。Runtime/Workspace Service 在 sandbox 外创建本地 Git Repository，导入初始文件，建立 main 初始 commit，并初始化 Workspace revision 0.1。空项目也创建明确的初始 commit。独立说明、文献、数据集等研究输入可以另存为 Material；Git 文件树本身不包装成 Material。

Workspace 初始化必须可验证：Repository 和初始 commit 能从本地仓库物化前，不向 Bot 宣告 Workspace 已就绪。Mission 和 Workspace 一对一绑定，两个 ID 分别保存，不混用。

### 3.2 每个 Execution 的 clone

每个新 Execution 从明确的 Workspace main commit/revision 创建独立 local clone。若 Task 指定 base revision/commit，就使用该版本；若没有指定，take 时解析当时 main HEAD，并把实际 commit 和 revision 固定到 Execution。

Bot 启动后先通过 Workspace Service/只读 API 浏览 Workspace；take 成功时 Runtime 从指定 main commit 导出文件树，通过 Sandbox Provider 已验证的受信任文件传输接口写入 sandbox 中预留的 Execution 专属目录，再由 OS 权限授予当前 Bot 用户写权限。不要假设 Provider 支持运行时动态挂载新 volume。Bot 只使用 Pi 文件工具/Bash 修改文件，不创建 Git branch/commit，不访问任何 .git、共享 refs 或管理凭据。Sandbox 内目录准备和权限细节见 [02](02-sandbox-runtime.md)。

新 E 不克隆前任 E 的私有 clone，也不继承前任 Pi 会话、shell history 或未导出的 Git 对象。跨 Execution 的研究接续通过 Material；项目代码接续通过 Workspace main 或明确保存的 Candidate。

Sandbox 生命周期和权限切换不在本文重复，见 [02](02-sandbox-runtime.md)。

### 3.3 为什么第一版采用独立 local clone

Git linked worktree 共享主 Repository 的对象数据库和部分 refs/配置，不能直接当作不可信 Bot 的隔离边界。第一版宁可承担本地 clone 的磁盘成本，也不把共享可写 .git 暴露给 Bot。

Runtime 为每个 Execution 创建独立、互不共享可写 .git 的工作副本；Bot 不需要知道底层使用 clone、worktree 还是受控文件树导出。第一版 Workspace Repository 内部可用本地 Git，但 sandbox 中只提供导出的项目文件树，不向 Bot 暴露 Git 元数据；不使用共享可写 .git、--shared alternates 或前任私有对象库。后续可根据实测磁盘成本评估 reflink/COW 或受控只读对象池，但不得降低隔离边界。

## 4. Git 可见性、导出和安全边界

| 操作/数据 | 当前 E 的 Bot | 其他 Bot | Workspace Service / Runtime |
|---|---|---|---|
| 当前 Execution 工作目录中的项目文件 | 可读写 | 不可读 | Runtime 管理导出 |
| Workspace main 与公开历史 | 可读 | 可读 | 受控维护 |
| Candidate | 可查看有权限的 Candidate | 可查看有权限的 Candidate | 管理对象和状态 |
| Workspace 主 Repository 的 .git/refs | 不可访问 | 不可访问 | 独占管理 |
| 其他 E 的私有 clone | 不可访问 | 不可访问 | 受控销毁/审计 |

Bot 只能修改 Runtime 为当前 Execution 准备的工作目录；不向 Bot 暴露 Git 管理能力。文件变更不会自动改变共享 main。Runtime 不把宿主 Git 凭据、Docker socket、服务数据库、provider 管理接口或共享可写 refs 放进 sandbox。

导出 Candidate 时，可信 Runtime 必须读取真实文件字节并计算摘要，不能信任 Bot 自报的文件清单或可能滞后的本地 manifest。第一版拒绝：
- 越出项目根目录的路径；
- 符号链接和特殊文件；
- 超过配置大小上限的文件；
- .git、Pi 会话、运行日志、凭据和运行元数据；
- 不属于明确导出范围的 sandbox 内容。

.gitignore 只影响 Git 跟踪，不是安全策略。Candidate 必须能在 Workspace Repository 中完整物化目标文件树；只有 patch 和前任 sandbox 路径、没有可访问基准内容，不能成为 Candidate。

## 5. Candidate：保存、查看与放弃

### 5.1 Candidate 的意义

Candidate 是 Runtime 从某个 Execution 工作目录安全导入 Workspace Repository 后创建的 Git commit/文件变更，附带来源、base revision/commit、摘要和状态。Candidate 不属于 Material，不自动进入 main，也不要求最终合并。

不是每个 Execution 都必须保存 Candidate：
- 研究结论、证明、实验观察、反例、失败经验发布为 Material。
- 值得复用的代码、证明文件、数据结构和项目文档变更保存为 Candidate。
- 有些临时改动不值得保留，可以不创建 Candidate。
- 同一个 Execution 可以同时发布 Material 和保存 Candidate，它们分别承担知识与文件版本职责。

### 5.2 Candidate 最小信息

| 信息 | 用途 |
|---|---|
| Candidate ID / Workspace ID | 唯一定位候选和所属仓库 |
| Git commit / tree | 固定候选文件树 |
| base revision / base commit | 说明从哪个 main 版本开始 |
| 来源 Task / Execution / Bot | 追溯贡献者和责任 |
| 内容摘要 / diff | 查看实际改动 |
| 相关 Material ID/版本（可选） | 说明候选依赖的研究知识 |
| 指定检查引用（如有） | 确认检查绑定确切候选 |
| 状态 active/discarded | 控制默认列表可见性 |

### 5.3 Candidate 长期保留与 discard

Candidate 长期保留，不因 integrate 失败或 Mission 完成自动清理。第一版不设置 TTL 或自动 GC。

Bot 可以显式调用 candidate discard。discard 只将 Candidate 状态改为 discarded，并从默认列表隐藏；不物理删除 Git commit、对象或来源记录。历史查询仍可审计 discarded Candidate。这样既允许 Bot 清理日常候选列表，又避免误操作造成历史不可追溯。

磁盘增长作为需要观测的运维问题，后续根据实测规模评估归档、配额或 GC；第一版不暗中清理。

## 6. 什么时候以及如何整合 main

### 6.1 由 Bot 自主判断

不是所有 Candidate 都值得进入 main。Candidate 可以长期保留，供后继 Bot 参考或重新整合。

默认情况下，当前有效 Execution 的 Bot 可以判断自己的 Candidate 值得成为共同项目基线时，直接调用 Workspace integrate，不必为每次合入额外创建 Task。

若整合涉及多个 Task 的成果协调、复杂冲突解决、大范围重构或独立验证，Bot 可以提出普通整合 Task，由另一个 Bot 接续。整合 Task 不是特殊 Task 类型，也不设固定整合 Agent。

Candidate 保存、Task 完成和 main 整合是不同事实：
- Task 只要求交付可复用文件变更时，保存 Candidate 即可满足交付，不必 integrate。
- Task 要求交付研究内容时，发布 Material。
- 只有 Task 明确要求 main 已包含某项变更时，才必须等待 integrate 成功。

### 6.2 最小整合政策

第一版不建立通用审批 DSL、复杂 Mission policy engine 或逐次人工审批。Workspace Service 只检查：
1. 当前调用者是有效 Execution，且有权操作该 Workspace；
2. expected revision 与当前 main revision 一致，Candidate base commit 与该 revision 对应的 main commit 一致；
3. Candidate commit 已完整导入、可物化且来源可追溯；
4. Mission/Task 明确指定的检查已针对该 Candidate commit 执行并通过。

若没有指定额外检查，不虚构测试门槛，但版本、完整性和来源检查仍必须通过。默认不要求逐次人工批准。

main 表示项目接纳的当前共同工作基础，不保证里面每个研究主张已被证明为真。Material 的 disputed/superseded 状态不自动改写 Git 历史；如果 Candidate 依赖已被质疑的 Material，Bot 应重新判断并在必要时提出修复工作。

### 6.3 integrate 流程

1. Bot 读取当前 main revision/commit、自己的 base、Candidate 实际内容和来源。
2. Bot 在当前 Execution 工作目录中完成必要的文件层面整合；底层 Git 操作由 Runtime 执行。Git 没有文本冲突不代表语义兼容。
3. 若 Task/Mission 明确指定检查，运行真实检查并确保结果绑定 Candidate commit。检查后修改文件，旧检查即不再适用。
4. Bot 调用 Workspace integrate，提交 Candidate ID；expected revision 由 Runtime 从 Candidate/当前 main 读取并做条件检查，Agent 不管理 Git SHA。
5. Workspace Service 验证当前 E、Candidate 来源和完整性、base commit、expected revision 以及指定检查。
6. 若检查通过且 main 未变化，Workspace Service 在本地 Repository 中受控推进 main，产生新 commit 并递增 Workspace revision。
7. 返回新的 revision 和 commit。Bot 将结果记录到 Task 交付中。

## 7. 并发、旧版本与失败处理

| 情形 | 服务与 Bot 的行为 | 保证与边界 |
|---|---|---|
| 两个 Bot 都基于 revision 0.2 请求 integrate | 首个请求得到 revision 0.3；另一个得到版本冲突 | 不会静默覆盖 |
| Candidate 基于 revision 0.1，main 已到 0.3 | Runtime 返回版本冲突；当前 Execution 不能自行切换 Git 基线；由 Agent 结束当前 Execution/提出后续 Task，新 Bot 从最新 main 开始重新整合并保存 Candidate | 不允许把旧快照直接当成新 main |
| 合入有内容冲突 | Bot 解释冲突并解决，或保留 Candidate 暂不整合 | v1 不要求自动语义合并器 |
| 检查通过后文件又变了 | 检查与 Candidate commit 不匹配，拒绝接纳 | 重新检查，不复用旧 PASS |
| Candidate 导出失败或文件校验失败 | 当前 E 内修正/重试 | 不登记为可整合候选 |
| integrate 失败 | Candidate 仍保留 | 不自动 discard |
| Task finish 后旧 E 再请求 integrate | 服务验证当前 E 并拒绝 | 旧凭据不能更新 main |

多个 Bot 可以并行准备和保存 Candidate；main 更新是一条串行提交线。Workspace revision 每次成功推进递增。第一版不创建 Git tag。

Candidate 保存与 main 更新是两个操作。Candidate 导入成功但 integrate 失败时，Candidate 仍保留，可比较、重新整合或显式 discard。

## 8. 错误成果与 Workspace 修复

Material 纠错见 [04](04-material.md)。当某个 Candidate 或 main 文件依赖的研究主张被质疑/替代时：
- Material 保留原文和纠错关系；
- Candidate 和历史 commit 不被静默改写；
- Workspace 查询/显示相关 Material 的当前纠错状态；
- 需要修复时创建普通 Task，从最新 main 开始验证并修改；
- 修复通过同样的 Candidate 保存和 integrate 流程形成新的 main revision。

撤回以新版本表达，保留被撤回版本、原因、证据和后继版本关系；不要求 Bot force-push 或抹除历史。

## 9. Workspace 长期生命周期

Workspace 与 Candidate 均不因 Mission 完成而删除。Mission 完成表示该目标的验收状态，不是仓库生命周期终止。

第一版：
- Workspace Repository 和 main 历史长期保留；
- Candidate 长期保留；
- Candidate discard 只隐藏，不物理删除；
- 不自动 TTL、不自动 GC；
- 磁盘增长作为运维指标观察，未来再按真实数据讨论清理/归档策略。

Mission 完成后是否允许继续创建 Task、是否允许新的 Bot 继续贡献，属于 Mission 生命周期策略，不能由 Workspace 自行推断；本章只保证仓库和版本仍然保留。

## 10. Workspace CLI 合同

以下是拟议 CLI，不代表当前已实现命令。统一入口规范见 [06](06-prompts-and-skills.md)。

| 命令 | 用途 |
|---|---|
| swarm workspace view | 查看 main、Workspace revision、commit 和公开历史 |
| swarm workspace history | 查看 revision/commit 历史、来源 Task/E 和整合说明 |
| swarm workspace status | 查看当前 Execution 工作目录的 base 和变更摘要 |
| swarm workspace diff | 查看当前 Execution 相对 base 的文件差异 |
| swarm workspace save | 请求 Runtime 保存当前 Execution 的文件成果并创建 Candidate；Bot 不提交 Git commit/SHA |
| swarm workspace candidate list | 默认列出 active Candidate |
| swarm workspace candidate list --include-discarded | 查看包含 discarded 的历史 Candidate |
| swarm workspace candidate view ID | 查看 Candidate 来源、base、commit 和 diff |
| swarm workspace candidate discard ID | 将 Candidate 标记 discarded；不物理删除对象 |
| swarm workspace integrate ID | 请求 Runtime 按最小政策检查并整合 Candidate；revision/CAS 由 Runtime 内部管理 |

所有命令由服务端验证身份与 E 状态。Bot 不得通过填写 Execution ID、Task ID 或 Git author 字段伪造权限。候选保存和整合都是普通 Service 调用；不建立通用 pending/permit 协议。若实际 Git 操作确实需要异步执行，由 Workspace Service 自己定义专属状态查询。

## 11. 当前实现差距与验收

当前基线的 WorkspaceManager 会为每个 Execution 初始化自己的 Git 仓库及名为 main 的分支，并支持从前任 Workspace 的指定 revision/commit 克隆。它没有由所有 Bot 共同推进的 Workspace 主线。当前 architecture 还明确说明本地文件索引可能滞后于 shell 写入，Git 提交与元数据快照不等于一个覆盖全部实际字节的原子版本。事实来源：[固定版本 WorkspaceManager](https://github.com/LuNa-shi/SwarmEnv/blob/008ecdb9ab64adcd8135042ff2160ec1db704952/src/runtime/workspace-manager.js) 与 [当前 Workspace 实现手册](../../architecture/05-workspace-continuity.md)。

实现验收至少应能观察到：
- 一个 Mission 对应一个长期 Workspace Repository；Mission 完成后仓库仍可读取。
- main 是真实 Git branch；每次成功推进生成 commit 并递增 Workspace revision；不创建 Git tag。
- 每个 Execution 的工作目录由 Runtime 从固定 main commit 创建；Bot 不直接管理 Git；修改一个 clone 不改变其他 E 或 main。
- Bot 不能通过共享 .git、宿主卷、旧私有仓库或伪造 CLI 字段绕过权限。
- Candidate 由 Runtime 保存后可在 sandbox 删除后完整物化，来源 Task/E 和 base revision/commit 可追溯。
- Candidate 长期保留；discard 只隐藏默认列表，不物理删除 commit；历史查询可见。
- Candidate 保存不自动推进 main；Bot 可以请求 Runtime integrate；复杂整合可使用独立普通 Task。Bot 不直接操作 Git。
- 两个相同 expected revision 的 integrate 最多一个成功；失败者保留 Candidate 并重新整合。
- 指定检查绑定确切 Candidate commit；文件变化后旧检查不能授权。
- Material 纠错不会静默改写历史 commit，相关 main 可被识别并通过新 Task 修复。

这些是待实现验收。文档 PR 不能证明 sandbox 隔离、Git 安全或 main 更新路径已经运行通过。
