# ScaleMAS 样例审核：原版对照、FATE-M 接入与验收条件

对应 [#202](https://github.com/LuNa-shi/SwarmEnv/issues/202)，组织方式参考 [Subagents #199 的审核样例][subagents-review]。

**建议把本例交付为：N 个平等 peer 接收同一道 FATE-M 原题，通过共享成果库自行检索、引用和继续证明，提交各自的完整 Lean 证明，再由独立检查器评分。** 首轮以 FATE-M 为主，先完成普通入口的真实运行，再对照论文的共享库、私有库、无共享库三组结果。软件任务可在后续接 SWE-bench Verified。

这次审核回答四个问题：原版怎样工作；当前普通入口实际做了什么；哪些能力保留、哪些需要补；如何同时验收运行行为、完整任务与论文效果。

**状态：本文是源码审核与实施建议。没有修改运行代码，没有启动新的模型或 benchmark 实验，也没有产生新的通过成绩。** 本地源码固定为 [`ce3e503`][source]；论文固定为 [Qi 等：Scaling Multi-Agent Intelligence with Substrate-Centric Coordination，v1][paper]。Core [#208][core-pr] 已合并，#202 中的旧阻塞说明不再表示必须等待这项 Core 实现。本文不把既有历史验收重新标记为当前版本通过。

## 1. 原版完整流程是什么

### 1.1 谁决定工作，成果怎样传给别人

原版给所有 agent 相同的任务和协作说明；各自保留任务工具，再获得发布、搜索和按地址读取三个操作。每个 agent 自己选择接下来探索什么，也自己判断何时提交最终答案。整个过程没有 lead 派工，没有预设的“引理作者 / 检查者 / 整合者”角色。[论文 §2、§3.2][paper-flow]

一条典型的信息流是：

1. A 检索已有成果，调用任务工具开展工作，发现一条可用的局部证明。
2. A 将做过的工作、具体产物、理由及引用写入共享库。这次发布不会自动给其他 peer 发通知。
3. B 在自己的工作过程中搜索相关问题，读到 A 的内容，必要时沿引用继续读取。
4. B 检查、修改或采用这项成果，再发布自己的进展。A 此时可以继续工作，也可以已经结束。
5. 每个 peer 完成后提交自己的最终答案；其他 peer 继续。全部结束或触及预算后，宿主保存结果并评测。

这是可能出现的工作过程，不是要写进 driver 的固定顺序。自然任务不要求每个 peer 都发表、引用，也不要求它们同时进入下一轮。第三方 benchmark 按组内是否至少有一份正确最终答案计分；不会额外设置一个 coordinator 替团队选择答案。[论文 §2.2、C.3][paper-eval]

### 1.2 哪些机制决定它是不是 ScaleMAS

| 部分 | 原版要求 | 对本例的意义 |
| --- | --- | --- |
| 发布内容 | `sub_task / artifact / rationale / refs`：已做的工作、可继续使用的产物、理由和引用。 | 不能只把普通聊天文字塞进数据库；别人应能找到并继续使用成果。 |
| 引用 | 指向已有消息或任务工具暴露的资源；理由说明每条引用的贡献；无效引用整条拒绝。 | 共享结果有可检查的来路，但发布成功不代表数学正确。 |
| 存储 | 只追加，地址稳定，原作者退出后内容仍存在。 | 后续工作不依赖作者继续在线。 |
| 读取 | search 和 visit 每次最多 8 条；返回有界的内容、出向引用及至多 8 条最新入向引用。 | 有限读取和沿引用导航都是协作机制的一部分。 |
| 模型看到的内容 | 不显示作者和引用权重。 | 模型依据内容判断；宿主可以保留作者与权重用于审计。 |
| 排序 | 归一化 BM25 相关性加动态引用权重，只排序相关性大于零的消息，同分优先较早消息。 | 引用能改变不同相关性分数的结果顺序，不只是平分时的加分项。 |

以上依据论文 [§2.1–2.3][paper-method]。FATE 的 `sub_task + artifact` 合计上限为 1,024 tokens，最多 32 条引用；不能把当前的 8 KiB 正文限制当成相同合同。[Table 6][paper-settings]

引用权重的规则应按论文实现：新消息权重为 0；每个新引用消息对被引消息更新一次 `s ← s + 0.3 × (1 − s)`；随逻辑步骤按 `s ← 0.98 × s` 衰减。搜索分数为：

```text
score(query, message)
  = citation_weight(message)
  + BM25(query, message) / max_positive_BM25(query)
```

BM25 参数为 `k1 = 1.5, b = 0.75`。没有正相关结果时返回空结果，不进行除零计算；资源引用不累积消息权重，同请求重放不能再次加权。论文没有规定只有跨作者引用才加权，不额外加入这个条件。[§2.3、Table 6][paper-method]

**需要明示的适配：** 论文没有给出可逐行核查的 BM25 分词、异步 group-step 定义和“理由说明了贡献”的自动判定实现。本例必须冻结这些约定并记录差异；不能仅因公式相同就声称整个执行过程完全一致。当前检查的论文和作者页面未定位到 ScaleMAS 官方实现及 Contradiction Audit 原始数据的发布链接。[论文][paper] · [作者页面][author]

## 2. 当前普通入口实际执行了什么

### 2.1 已经存在的完整路径

安装包中的 `dist/examples/scalemas-environment/main.js` 读取配置，创建公共 Pi/OpenSandbox backend，再调用 `runScaleMAS`。Env 建立一个 Runtime、固定 peer 池和 SQLite substrate，将问题写入每个 peer 的私有目录。[普通入口][local-main]

当前默认任务是“比较输入验证方法”，可通过配置替换。默认 3 个 peer、每人 2 个大轮次、120 秒工作窗口；池大小允许 3–8，轮数允许 2–32。[配置][local-config] · [driver][local-driver]

**当前已有异步运行。** `Promise.all` 启动各 peer 自己的循环，一个 peer 等待自己的输入完成时，其他 peer 可以继续；不存在全员 round barrier。需要改变的是固定轮数和固定续轮提示，以及它们对“任务完成”的替代作用。现在每轮重复要求 search、visit、work、publish，轮数用完就退休并停止 peer；普通成功结果主要是 `peerIds / completedRounds`。[driver 第 77–138 行][local-driver-flow]

### 2.2 与论文的实质差距

| 维度 | 当前实现 | 本次建议 | 源码 |
| --- | --- | --- | --- |
| 发布 | `content + references`；正文上限 8 KiB，最多 16 引用。 | 补四字段、逐引用理由和任务资源引用；保留事务与不可变内容。 | [发布][local-publish] |
| 搜索排序 | 全文词命中次数优先，引用数仅在词频相同时参与。 | 改为归一化 BM25 + 加权 + 衰减；保存排序时的快照以便复核。 | [检索][local-read] |
| 搜索返回 | 前 240 字符摘要，向模型暴露 `textOccurrences / incomingReferences`。 | 返回论文要求的有界内容和引用；排序数值留在宿主记录。 | [结果合同][local-contract] |
| visit | 单地址，返回作者、正文、出向引用。 | 支持至多 8 地址、入向引用；模型视图隐藏作者。 | [读取][local-read] |
| pool | 3–8 peers。 | 允许 N=1、2、4、8、16 的受控配置，默认 4；实际规模受运行预算约束。 | [池限制][local-pool] |
| 工作结束 | 每人固定 2–32 大轮次，然后 stop。 | 按最终提交、预算、明确失败结束；保持其他 peer 独立推进。 | [driver][local-driver-flow] |
| 任务工具 | Profile 仅开放 substrate；Runtime 装配没有 benchmark Service 组合入口。 | 接入 FATE 的 Mathlib 检索和 Lean 检查；宿主按原题构造配置。 | [Profile / 装配][local-driver] |
| 最终产物 | 报告轮数和调用状态，没有 FATE 候选与评分。 | 保存每个 peer 的最终证明、独立检查结果和团队 Pass@N。 | [结果返回][local-driver-flow] |
| 对照条件 | 仅有共享库，没有 private / none 模式。 | 共用同一运行器切换可见范围和协作工具；基线保留相同解题能力。 | [访问控制][local-read] |

已有测试明确锁定了旧的“词频优先、引用只打破平局”规则。修复时应同步更新其预期，不把旧测试通过当作论文排序已实现。[现有排序测试][local-rank-test]

### 2.3 哪些已有成果应保留

SQLite 持久内容、稳定地址、可信作者、按 run 隔离、原子引用写入、同请求重放与冲突、读取记录、独立目录、真实会话续用和关闭回执都有实际实现。这些是可继续使用的底座，没必要另造一套存储与生命周期框架。[substrate][local-substrate] · [driver][local-driver]

历史上也已经做过真实运行：[#190][historical-native] 记录了真实 Pi/OpenSandbox 配合脚本化模型的持久共享验收；[#185 的一小时记录][historical-k3] 记录了旧版本的 6 Bot、K3 编程任务和作者停止后的成果交接。**不能说本例从未运行过真实模型。** 这些结果支持对应版本的工程链路，不能换算为 FATE-M 分数，也不证明当前版本已复现论文。当前 Pastel matrix 只包含 subagents、flat、agensh。[历史边界][historical-boundary] · [Pastel matrix][pastel-matrix]

## 3. 保留什么，具体怎样补

### 3.1 本例的实现取舍

| 处理 | 范围 | 判断理由 |
| --- | --- | --- |
| **必须保留 / 补齐** | 平等固定池、同一原题、自主异步工作；四字段发布；匿名有界读取；动态引用排序；内容在作者退出后可用；真实 FATE 工具、最终证明和独立评分。 | 这些决定运行是否具有论文中的协作方式，以及能否完成真实任务。 |
| **有限适配** | Pi + 四工具 + Bash Service；SQLite；稳定地址的具体格式；宿主保留作者；本地错误和请求回执；显式记录 action、摘要和 step 的映射。 | 保留可观察的行为，继续使用 SwarmEnv 已确定的 Core。不能将底层差异隐藏在“相同 benchmark”之下。 |
| **首轮不做** | 四个 benchmark 全量复现、128/1024 规模、MAD/DeLM/AOrchestra 全部移植、动态扩缩容、跨宿主恢复、跨任务长期记忆、新监控平台。 | 不影响先交付一个完整例子；也不能将未做部分记成已支持。 |

**首轮效果对照保留三组：完整共享库、每人私有库、无库独立运行。** BM25-only 在 N=8 做后续消融，N=16 做后续规模点；不用一开始复刻论文全部基线。

### 3.2 模块与状态各归一处

以下路径是建议修改或新增的位置，其中标“新增”的文件尚不存在。

| 位置 | 职责与修改 | 完成时应交付什么 |
| --- | --- | --- |
| `src/environments/scalemas/substrate.ts` | 保留 SQLite 和可信身份；增加四字段、资源引用、入向关系、匿名视图和引用权重；提供 shared/private 配置。 | 同一服务同时支持普通协作和可比的消融；原文与宿主审计信息完整。 |
| `src/environments/scalemas/index.ts` | 保留每 peer 独立驱动；接入任务 Services、一次性原题输入、最终提交与预算终止；扩展 pool 配置。 | 模型自行决定搜索和发表；宿主不再通过固定续轮强迫产生协作轨迹。 |
| `benchmarks/scalemas-fate/adapter.ts`（新增） | 从固定题库创建任务；提供 `search_mathlib / check_lean`；登记最终 proof 与引用；对每个 peer 计量检查次数。 | 普通 Env 能处理原始 FATE-M 题，而非收到宿主事先拆好的引理。 |
| `benchmarks/scalemas-fate/evaluate.py`（新增） | 在独立的 4.28 工程里重新构造原题、编译冻结的候选并记录结果。 | 评分可单独重跑，不依赖模型声称“检查通过”。 |
| `benchmarks/scalemas-fate/run.ts`、manifest、README（新增） | 枚举题目、N、条件、seed；装配同一 Env；保存每题报告、汇总分数和成本。 | 仓库外安装后有一条说明清楚的准备、运行、评分路径。 |
| 模型目录与 Worker 镜像 | 若接论文模型，登记 Qwen3.5-9B 的真实模型身份、固定 checkpoint 和兼容端点，更新镜像。 | 实际请求、生成参数和 usage 可核验；不能只改配置里的模型名。 |
| example 配置、Architecture 19、Prompt 说明 | 普通入口给真实任务配置；说明实际输入、终止、共享内容与结果位置。 | 文档与实现同步，不继续宣称旧词频排序就是论文算法。 |

交付顺序建议为四个完整阶段：**先固定题库与独立 checker → 补 substrate 主要语义 → 接通自主运行和最终提交 → 用同一入口做真实任务与三组对照。** 每阶段都能独立检查，不把对照表每行拆成各自一套零散补丁。

### 3.3 三组对照怎样保持公平

- **shared：** 同题 peers 访问同一个库，使用完整引用排序。
- **private：** 接口、模型、提示和自身记忆能力基本相同，服务端按可信调用者隔离内容、搜索、visit 和引用。本地实现同时在每个私有库内计算 BM25 统计、归一化分母与引用权重，避免不可见的其他 peer 内容仍改变结果；这是本例的明确实现约定，不冒称已经核查上游代码。只改提示词说“不要读别人”不算隔离。
- **none：** 去掉 substrate 操作和相应协作提示，保留同样的原题、Mathlib 检索、Lean 配额、模型和生成设置。不能让独立基线仍被要求调用不存在的共享工具。

每题重建独立库；结束后可保留审计副本，但不把上一题的成果喂给下一题。所有条件均保留各 peer 的私有会话，使用同一套任务 checker。新增消息只入库，不通过 `steer` 广播；给大家自动推送答案会改变要验证的检索机制。

### 3.4 Core 接入与预算边界

主体修改属于 Env、substrate 和 benchmark adapter。继续使用 Core 的创建、输入、停止、文件和 Trace 能力；不把数学题、消息库或排序搬进 Core。

有两处应明确写进实施范围，不能在验收时模糊处理：

1. **检查配额可以由任务 Service 保证。** `check_lean` 在受信入口按 peer 和稳定请求身份计数；相同请求重放不重复编译。Bot 不获得另一条可以绕过配额的 Lean 验证入口。900 秒是每次编译的上限，不是整道题的总运行时长。
2. **论文 action/step 不等于当前 maxRounds。** 一次 Pi 大轮可以有很多工具调用，一条 Bash 也可包含多次 Service 操作。任务与 substrate Service 必须按底层操作计数，拒绝调用也计入；原生四工具调用另由 Trace 核对。当前公共 `onEvent` 没有逐工具执行前的预算入口，不能声称已有全部基础工具的精确实时额度控制。[公共事件类型][core-types]

建议先交付同一 Pi 条件下的明示预算版本：对任务/共享库操作实施配额，对模型运行实施明确的时间/总用量政策，并同时输出原生工具与语义操作计数。G1之前，实施PR必须冻结逻辑时钟的推进事件、加权与衰减顺序、失败调用是否推进、以及shared/private的时钟口径，并写入manifest和确定性测试。同一请求的重放不推进时钟；一次正常的新查询与旧请求重放必须区分。这个约定与论文未完全定义的group-step之间的差异也进入manifest。**不把论文“120 steps/run”直接改写成“全队总共120次服务调用”，也不以2轮或120秒代替它。**

计数分别记录 `native_tool_calls / semantic_operations / decay_ticks`。网络重试同一请求不重复产生发布与加权；模型主动再发起一次工具调用，即使参数相同或得到幂等回执，原生工具调用数仍增加。副作用去重不等于模型调用免费。

若后续要求严格的原生工具 action 上限、相同摘要触发及 group-step 语义，再单列最小的受信接入缺口；在这些差异未解决前，可报告本地对照效果，不能标记“论文配置完全一致”。Core 的模型授权可能被反复检查，也不是每次调用加一即可得到的模型请求计数器。[模型授权实现][model-access]

### 3.5 与旧设计需要同步的差异

[当前 Phase 0005 §7][phase-scalemas] 明确采用文本相关性优先、引用同分排序、模型可读作者及按轮驱动，并声明不证明论文等价；当前实现具体选择了词频算法。#202 还要求 B 回读原作者。这与此次更贴近论文的目标存在差异。

建议实施时同步修改设计与派生验收：**模型只读匿名内容；可信作者、版本和精确字节继续保存在宿主记录，验收者可以核查。** 旧版能力和证据继续保留其版本归属。本文记录这项建议，不通过一条评论把旧版验收重新解释成已经完成的新目标。

## 4. 选哪一个论文 benchmark，怎样真正接入

### 4.1 选择：FATE-M 主验收，SWE-bench Verified 后续扩展

| 论文 benchmark | 可取得的材料与接入代价 | 本例安排 |
| --- | --- | --- |
| **FATE-M** | 官方题库、Lean 工程与评测代码公开；最终证明可独立编译；一个固定工具链可服务整套任务。 | **主验收。** 观察局部证明如何进入其他 peer 的完整证明。 |
| SWE-bench Verified | 官方数据和 Docker evaluator 公开；每题需准备仓库与测试环境，论文使用 mini-SWE-agent。 | 后续扩展。各 peer 的 patch 分别评测，不能先合入共同 main 再当作论文 Pass@N。 |
| BrowseComp-Plus | 数据与语料公开；论文使用 OpenResearcher 搜索/浏览和指定 LLM judge，与数据集默认配置存在差别。 | 首轮不接，避免同时搭建搜索和判分链。 |
| Contradiction Audit | 论文描述注入方式，但本轮未定位原始注入语料；评价是较宽松的召回。 | 不以自行生成的新语料冒充原实验；获得原始数据后再评估。 |

原论文使用范围及评测口径见 [C.3][paper-eval]；可取得的材料见 [FATE-M][fate-repo]、[SWE-bench evaluator][swe-eval]、[BrowseComp-Plus][bcp-repo]。选择 FATE-M 是本次工程判断，不代表它是论文中所有机制最强的证据。

### 4.2 数据和工具链已经核实到什么程度

| 项目 | 本次核实并建议冻结的值 |
| --- | --- |
| 数据来源 | `frenzymath/FATE-M@4eb33c8ccd0ff058b461cd763cc406509129743f` |
| 数据文件 | `FATE-M.json`，150 条，ID 按 1–150 排列；包含自然语言和完整 Lean 声明 |
| 主评测清单 | 原文件前 100 条，即 ID 1–100；接线预检使用 ID 1–10 |
| Lean | `leanprover/lean4:v4.28.0` |
| Mathlib | `8f9d9cff6bd728b17a24e163c9402775d9e6a365` |
| 数据 SHA-256 | `39c13a39f82bb2f39fc42d0a0efb41c6b0ef16b8194c8c8e0ae281c5cf0276fb` |
| 评测组件参考 | `frenzymath/FATE-Eval@fe358fb5b0a53fdafaaf156540a2ecbf9b5b98a4` |

数据、工具链和 manifest 已按 Git blob 核对并实际读取；**这证明来源可取得和版本可固定，不表示模型或 Lean 运行已通过。** 来源：[JSON][fate-data] · [Lean][fate-lean] · [Mathlib][fate-mathlib] · [评测器][fate-eval]。

论文写“FATE-M 前100题”，没有在已查材料中给出题目 manifest 和精确数据提交。因此，ID 1–100 是依据当前官方固定数据确定的复现清单，尚不能声称与作者原始清单逐项相同。不能看过模型成绩后再换成容易的100题。

**评测器不能直接按默认配置运行。** FATE-Eval 默认指向 Lean 4.16；内置 workspace 列表尚无 4.28。其自带 FATE-M JSON 与上述题库有 15 条 formal_statement 不同，其中 8 条在前100题内。实现应使用这里冻结的题库和4.28工程，只复用合适的评测组件。[配置][fate-eval-config] · [旧题库][fate-eval-data]

### 4.3 一道题从输入到得分的具体路径

1. **装载原题。** runner 按 manifest 读取原始声明，宿主保留不可修改的模板。每个 peer 收到相同原题和任务工具说明，不给它们预先分配引理，也不把其他题或参考答案放进可见目录。
2. **工作中验证。** `search_mathlib` 只搜索固定版本的 Mathlib，返回至多10个声明；`check_lean` 把候选证明装入原题模板，在受信的4.28工程中编译并返回诊断。每 peer 至多10次，每次上限900秒，重放和失败处理明确记录。
3. **共享中间成果。** 使用同一 substrate。引用可指向既有消息和已注册的 Mathlib/题目资源；资源地址绑定版本。模型自行决定搜索、阅读、发布和采用。
4. **提交最终候选。** 每 peer 自行显式提交或更新一份当前候选及引用；自然结束或预算触及时，冻结其最后一次已确认提交。候选选择由peer在已有工具反馈内完成，宿主不额外评分中间尝试再替它挑选。没有可用提交的peer记为未成功，不无限续轮直到解出。
5. **独立评分。** 在干净工作目录中，用宿主原始题面和冻结依赖重新编译；检查目标声明和前提不变、无 `sorry`，证明不引入额外未证明的公理。普通辅助引理、证明中的局部假设和Mathlib已有逻辑基础照常使用。不能只检查 theorem 名称，也不能接受模型修改后的题面。[官方静态检查参考][fate-precheck]
6. **保存结果并结束。** 保存候选字节与摘要、peer来源、引用、独立检查结果、调用和用量、结束原因及清理回执；随后计算团队指标。最终评分结果不在解题中途反馈给其他 peer，工作中反馈仍只经有配额的 `check_lean`。

任务 Service 只控制检查和评测边界；数学结论是否正确最终由冻结的 Lean 目标检查。共享消息的引用权重不进入正确性判定。

### 4.4 交付的运行入口必须可实测

实现 PR 应同时提供并验证三条实际命令：**准备冻结题库/镜像/Mathlib索引，运行指定实例与条件，重评已冻结候选并汇总。** 命令名由实现确定；本审核不把尚不存在的 CLI 写成现在可执行的命令。

运行路径应使用打包后的普通 Env 和公开 Core/Service/backend 入口，在仓库外新建的 consumer 目录验证。当前没有 `@swarmenv/core/environments/scalemas` 这一导出，不能写一个不存在的 import 作为接入说明。[现有 package exports][package-exports] · [安装示例][installed-readme]

**论文模型也是实际接入工作。** 当前shipped模型目录只有K3和两项GPT配置，没有Qwen3.5-9B；Core会拒绝未登记的provider/model。要跑论文参考模型，须同步模型目录、Worker镜像和兼容推理端点，核查真实checkpoint、采样参数与用量。先用现有K3可以完成本地三组对照，但必须单独标明，不能用42/38/36作为同模型复现门槛。[镜像模型目录][model-catalog-data] · [模型准入][model-admission] · [目录校验][model-catalog-code]

## 5. 具体效果参考什么，怎样验收

### 5.1 论文已经报告的参考值

以下都是论文结果，**不是当前 SwarmEnv 成绩**。主参考模型是 Qwen3.5-9B，任务是 FATE-M 前100题；共同生成参数、预算和 seed 见论文 Table 6。

| 论文配置 | 参考值 | 本地需核对的部分 |
| --- | --- | --- |
| 模型 / 题目 | Qwen3.5-9B；FATE-M前100题 | 模型实际身份、checkpoint和题目manifest。 |
| 每agent行动 / 每run步骤 | 100 actions；120 steps | action与group-step映射按§3.4单独冻结，不能用大轮数替换。 |
| 工作中Lean验证 | 每agent最多10次，每次最多900秒 | 任务Service实际限额及重放；900秒不是全组预算。 |
| 生成参数 / 重复 | temperature=1.0；每次最多16,384 tokens；seed=0/1/2 | 核对发往实际模型的设置；不支持某参数时记录偏差。 |
| 历史摘要 | 到10轮时压缩，保留最近3轮，摘要至多1,024 tokens | Pi默认压缩不自动等同该策略；摘要tokens计入成本。 |
| substrate | search/visit≤8；refs≤32；子任务+产物≤1,024 tokens | 核对返回内容、tokenizer和服务端限制。 |

来源：[Table 6、C.2][paper-settings]。这是论文参考配置；尚未实现的映射不标成“已匹配”。

| 对照 | 论文分数 | 用来回答的问题 |
| --- | ---:| --- |
| N=1，ScaleMAS | 24.0% | 单 agent 配合个人成果库的起点。 |
| N=4，共享库 | **42.0%** | 这次主效果对照的目标参考。 |
| N=4，私有库 | 38.0% | 去掉跨 agent 共享，保留个人外部记忆。 |
| N=4，无库独立 ReAct | 36.0% | 更多独立尝试本身能获得多少收益。 |
| N=8，完整引用排序 | 49.0% | 后续规模与排序验证。 |
| N=8，BM25-only | 42.0% | 引用权重带来的差异。 |
| N=16，ScaleMAS | 56.0% | 后续规模参考，不是4人运行的验收分数。 |

来源：[§3.3][paper-main]、[Table 2][paper-table2]、[§3.5][paper-ablation]。FATE-M 在16人之后趋于平台，不能把论文结论改写为“规模一直增加就一直提升”。论文 N=8 的引用消融还报告默认排序约2.7M tokens/题、BM25-only约5.7M；这说明成绩应与实际计算量一起看，不能只看人数。

建议实际结果表与上述表并排，保留如下列：`条件 / N / 题数 / seed / 团队成功率 / 与论文差值 / 与本地无通信基线差值 / 总输入输出tokens每题 / Lean时间 / 超时与错误 / 清理结果`。没有运行的格子写“未运行”，不填估计成绩。

### 5.2 评分合同

对每一道题、每个 seed，独立检查这次团队实际提交的 N 份最终候选；只要其中至少一份证明原题成功，该题组记1，否则记0。然后在固定题目与 seed 上求平均。这就是本例对应论文的团队 Pass@N。

必须保留以下边界：

- 不把中间10次 Lean 尝试全部当成最终候选池；最终提交规则一致。
- 不从一组16人协作轨迹中抽取8份答案估计N=8；各N需要实际独立运行。
- 不因超时、基础设施错误或缺失提交删除题目。主表保留固定分母，另列基础设施有效覆盖率；修复后若重跑，保留原记录并注明。
- 不使用“发表了多少条内容”“引用了多少次”代替任务分数。
- 如另需输出唯一推荐证明，可以预先固定选择规则，但其单答案成功率另报，不替代论文的团队指标。

同一道题的不同 seed 是重复观测，不算新的独立题目。比较条件时按题目配对汇总，给出95%区间；不能把100题×3 seed当作300个独立样本。所有条件统计完整输入与输出 tokens，包括摘要、纠错和失败请求中实际消耗的部分；未知用量单列。**相同N不代表相同计算量。** 同时报告实测成本，再决定是否补充同总token预算的对照。[论文评测口径][paper-eval]

### 5.3 分阶段验收，不把全部论文实验变成首例待办

| 阶段 | 具体运行或检查 | 通过条件 |
| --- | --- | --- |
| **G0：来源与检查器接通** | 固定题库、ID、4.28工具链和Mathlib；在独立目录验证已知正确证明，以及含sorry、改题、额外公理和编译错误的负例。 | 来源哈希一致；正确候选通过，负例明确失败；评分不受peer工作目录修改影响；四工具不能绕过工作中Lean配额。 |
| **G1：核心机制** | 同一实际Service验证综合排序、衰减、同请求重放、匿名、有界读取、入向引用、跨run拒绝；原生双peer场景验证A退出后B继续读取和使用。 | 引用权重确实可改变不同相关性分数的排序；重放不增加内容/权重；A实际释放后B原Session仍能访问精确内容；失败与pending有记录。 |
| **G2：原题端到端跑通** | 从普通安装入口跑固定ID1–10，N=4、seed0，先共享库再核查private/none；共30次题组运行，真实模型、Pi/OpenSandbox和Lean，使用相同通用代码。 | 每题每条件都有候选或明确失败结果，均进入独立评分与收尾；观察到正确证明的完整交付路径，三种条件的权限和提示符合配置。只完成工具调用或只有scripted模型不算这一项通过。 |
| **G3：主效果对照** | 固定ID1–100，N=4，shared/private/none；先seed0形成300次题组的整表，正式报告再补论文列出的seed1/2。 | 三组使用相同模型、原题、任务工具和冻结策略；完整分母、分数、成本和区间可重算；自然跨peer采用次数如实报告，可为0，逐条说明可核查案例及后继证明结果。 |
| **后续扩展** | N=1、2、8、16规模点；N=8 BM25-only；必要时SWE-bench。 | 单独冻结执行范围与预算，再判断规模/排序/跨任务效果，不阻塞首轮接线。 |

G1 可以用可控模型触发罕见边界，G2/G3 必须是原始任务上的真实模型执行。自然运行不强制A先完成某个引理，不要求每个peer引用，不由宿主指定一份“必须采用”的正确内容；这些脚手架只能用于机制验证。

G3 完整配置是 **100题 × 3条件 × 3 seed = 900次题组运行**，每次4个peer；按10题接线预检、100题单seed、补全重复的顺序推进。如果预检或seed0后修改了配置、提示或实现，旧运行标为pilot；新冻结候选需重新取得完整同配置结果，不能把旧seed0与新seed1/2拼成一张表。它是正式效果实验，不应伪装成一个廉价单元测试。先完成代码、G0/G1和明确的运行配置，使后续资源评审面对具体的任务数与上限；各批次在执行范围与预算明确后运行，900次实验不是完成源码审核和接线准备的前提。此次审核没有启动这些运行。[正式实验边界 #205][issue205]

### 5.4 怎样判定“跑通”和“复现效果”

**工程验收：** G0–G2 的链路、正确候选交付、错误处理和收尾通过，才能称“FATE-M 已接入并跑通”。只把题目文本传给模型，或只证明 publish/search/visit 能调用，均不满足。

**机制验收：** G1 通过，并在真实任务中给出至少一条可复核的信息采用过程：谁发布了什么，接收者何时读到，后续证明或检查怎样变化。引用链用于定位，再核对具体证明内容；一条引用不能单独证明采用，更不能证明因果收益。未观察到自然采用时，报告“能力已验证，真实任务采用未证实”。

**效果验收：** G3 报告本地三组的绝对分数和差值，参考论文42/38/36。若共享组高于另外两组，记录观察到的改善；若题目配对区间仍跨0，统计结论写“不确定”；只有差异得到相应证据支持，才宣称已验证共享收益。得分低于论文或基线时，保留结果并排查模型、检索、预算、摘要和协作轨迹，不能靠更换题目或削弱基线让它通过。

**“达到论文效果”的更强说法要另行判断。** 同名模型但不同checkpoint、不同题目清单、不同任务工具或Pi历史策略，都可能影响绝对分数。论文未提供主表逐seed原始结果，不能自行杜撰一个“论文允许误差”。如要设置“与42%相差不超过若干个百分点”的数值门槛，应在看结果前明确该容差；本审核不将无依据的±5个百分点设为事实。工程可以通过而效果未复现，此时Issue必须保留效果缺口。

### 5.5 运行中应能观察到什么

| 需要看见的行为 | 最低证据 |
| --- | --- |
| peers 真正并行、没有宿主派工 | 重叠的实际模型/工具时间；所有peer原始任务一致；无按答案安排的角色提示。 |
| 有限读取仍能找到有用成果 | 实际search/visit结果、查询时库版本、排序依据的宿主记录、下一次模型输入。 |
| 成果被采用 | 发布原文、接收者读取、具体证明片段/策略变化、对应Lean检查和最终候选。 |
| 作者退出不打断其他工作 | A的stop/实际清理回执，B原身份/Session后续读取和执行。 |
| 最终正确性与调用成功分开 | 全部候选和独立checker结果；模型自述通过不计分。 |
| 预算和结束可信 | 调用计数、检查次数、模型用量、终止原因、未处理输入及所有cleanup/pending。 |

采用已有 Session、Gateway、Service Trace，加上必要的排序、任务与评分记录即可。评审者应能沿这些记录回答“共享是否改变了实际工作”，无需为本例再建设一套观测平台。

## 6. 本轮审核结论与后续回填

**当前结论：持久共享底座可以保留；论文核心读写与排序、普通入口的最终答案语义、FATE-M工具和独立评分需要补齐。** 主验收明确采用论文实际使用的FATE-M，效果主表采用N=4的三组对照；128规模和四benchmark全面复现不进入首轮门槛。

后续实现与证据继续回填 #202：代码提交、冻结的数据/模型/配置、安装入口、G0–G3各自结果、论文与本地数值对照、剩余差异。审核文档发布不等于实现或验收通过。

[subagents-review]: https://github.com/LuNa-shi/SwarmEnv/issues/199#issuecomment-7151673865
[source]: https://github.com/LuNa-shi/SwarmEnv/commit/ce3e503ba534d2b9cf42423aa0cdcdcc80766828
[core-pr]: https://github.com/LuNa-shi/SwarmEnv/pull/208
[paper]: https://arxiv.org/html/2610.16120v1
[paper-flow]: https://arxiv.org/html/2610.16120v1#S2
[paper-method]: https://arxiv.org/html/2610.16120v1#S2.SS3
[paper-settings]: https://arxiv.org/html/2610.16120v1#A3.T6
[paper-eval]: https://arxiv.org/html/2610.16120v1#A3.SS3
[paper-main]: https://arxiv.org/html/2610.16120v1#S3.SS3
[paper-table2]: https://arxiv.org/html/2610.16120v1#S3.T2
[paper-ablation]: https://arxiv.org/html/2610.16120v1#S3.SS5
[author]: https://zhentingqi.github.io/
[local-main]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/examples/scalemas-environment/main.ts#L4-L7
[local-config]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/examples/scalemas-environment/config.ts#L4-L18
[local-driver]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/environments/scalemas/index.ts
[local-driver-flow]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/environments/scalemas/index.ts#L77-L138
[local-publish]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/environments/scalemas/substrate.ts#L64-L88
[local-read]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/environments/scalemas/substrate.ts#L34-L62
[local-contract]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/environments/scalemas/substrate.ts#L13-L18
[local-pool]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/environments/scalemas/substrate.ts#L21-L24
[local-substrate]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/environments/scalemas/substrate.ts
[local-rank-test]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/test/scalemas-substrate.test.ts#L33-L47
[core-types]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/core/types.ts#L163-L168
[model-access]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/core/model-access.ts#L184-L199
[model-catalog-data]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/services/opensandbox-agent/pi-models.json
[model-admission]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/core/model-access.ts#L124-L127
[model-catalog-code]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/src/agent/model-catalog.ts
[phase-scalemas]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/docs/phases/0005-core-environment/02-environment.md#7-scalemas
[historical-native]: https://github.com/LuNa-shi/SwarmEnv/issues/190#issuecomment-7110071309
[historical-k3]: https://github.com/LuNa-shi/SwarmEnv/issues/185#issuecomment-7126892228
[historical-boundary]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/docs/architecture/21-hour-matrix.md
[pastel-matrix]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/benchmarks/programbench-pastel/pastel-matrix.ts#L15
[fate-repo]: https://github.com/frenzymath/FATE-M/tree/4eb33c8ccd0ff058b461cd763cc406509129743f
[fate-data]: https://github.com/frenzymath/FATE-M/blob/4eb33c8ccd0ff058b461cd763cc406509129743f/FATE-M.json
[fate-lean]: https://github.com/frenzymath/FATE-M/blob/4eb33c8ccd0ff058b461cd763cc406509129743f/lean-toolchain
[fate-mathlib]: https://github.com/frenzymath/FATE-M/blob/4eb33c8ccd0ff058b461cd763cc406509129743f/lake-manifest.json
[fate-eval]: https://github.com/frenzymath/FATE-Eval/tree/fe358fb5b0a53fdafaaf156540a2ecbf9b5b98a4
[fate-eval-config]: https://github.com/frenzymath/FATE-Eval/blob/fe358fb5b0a53fdafaaf156540a2ecbf9b5b98a4/config/verify_config.yaml
[fate-eval-data]: https://github.com/frenzymath/FATE-Eval/blob/fe358fb5b0a53fdafaaf156540a2ecbf9b5b98a4/data/FATE-M.json
[fate-precheck]: https://github.com/frenzymath/FATE-Eval/blob/fe358fb5b0a53fdafaaf156540a2ecbf9b5b98a4/src/lean_verifier/utils.py#L240-L294
[swe-eval]: https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/docs/guides/evaluation.md
[bcp-repo]: https://github.com/texttron/BrowseComp-Plus/blob/046949032b0328319cc9a02663a759ec601d9402/README.md
[package-exports]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/package.json#L7-L20
[installed-readme]: https://github.com/LuNa-shi/SwarmEnv/blob/ce3e503ba534d2b9cf42423aa0cdcdcc80766828/examples/scalemas-environment/README.md#L9-L35
[issue205]: https://github.com/LuNa-shi/SwarmEnv/issues/205
