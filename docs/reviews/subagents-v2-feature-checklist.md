# Codex V2 Subagents：功能清单与 SwarmEnv 对照

对应 [#199](https://github.com/LuNa-shi/SwarmEnv/issues/199)。直接按 **原版功能 → 当前代码 → 缺什么、改哪里 → 如何验收** 核对；不再按 S0–S5 拆工程阶段。

范围是 Codex V2 的六项协作操作及其配套运行行为、相关配置。普通任务入口也列入，便于检查这六项操作是否真正接到用户使用的路径。原版有而本票已明确采用不同实现的地方单列，避免既漏项又无意扩大范围。

**阅读现状列时，以普通 Subagents example 是否接通为准。Core 提供某个 API，不等于这个功能已在 example 中完成。** 以下是源码审核，验收列写的是需要验证的行为，本次没有新增运行验收。改完一项就在 #199 记录对应代码和检查结果。

## 1. 功能总览

| 功能 | Codex V2 要做什么 | 当前 Subagents | 主要修改位置 |
| --- | --- | --- | --- |
| 普通任务与交互 | 接收完整任务，按需要委派，允许持续输入和自然回答 | 不同：固定人数、固定续轮、指定 JSON；补充输入仅在启动时提交 | Env |
| spawn_agent | 创建具名 Child，允许递归、角色选择及 all/none 历史继承 | 部分：仅有父创建直接孩子；Core 的 fork 未接 | Env + Service |
| send_message | 向同树目标发通知；按参考配置不主动启动 idle Turn | 缺少：现有 bot.send 是执行输入，没有独立消息队列 | Service + Env；严格自动推送存在接口差距 |
| followup_task | 向原 Agent 追加任务，idle 启动、busy 尽早收到 | 部分：原 Child 可续跑，但现有 followUp 会排到下一大阶段 | Service + Env，接现有 steer |
| wait_agent | 在当前工作中等自己的消息或用户输入，不等指定孩子列表 | 缺少：waitForFinal 是宿主等待最终答案 | Service + Env |
| interrupt_agent | 停止当前工作，保留 Agent；返回此前状态 | Env 未接：当前暴露 stop；Core 已有 interrupt | Service + Env |
| list_agents | 列出当前树中可见活 Agent、状态及路径前缀结果 | Env 未接：只有受限 get；Core 有 list 基础 | Service + Env |
| 自动结果通知 | 符合原版通知条件的 Child 结果回真实直接父节点 | 部分：仅固定 Root 的直接孩子，使用 followUp，状态策略也不同 | Env + Service |

六项操作之外，创建关系、寻址、能力开关和自动结果通知共同构成完整协作流程。无需为每一行建立一个新 Service；可以由同一协作 Service 的操作和内部模块完成。

## 2. 原版六项操作的参数与返回

| 操作 | 参数 | 原版成功返回 |
| --- | --- | --- |
| spawn_agent | task_name、message；可选 fork_turns，以及按配置开放的 agent_type/model/reasoning_effort/service_tier | {task_name}；metadata 可见时另有 nickname；不返回最终答案 |
| send_message | target、message | 空文本；表示提交成功，不表示对方已采用 |
| followup_task | target、message | 空文本；同一 Agent 继续，不是另建 Agent |
| wait_agent | 仅 timeout_ms 可选；handler 要整数 | {message, timed_out}；不返回 Agent 名单或正文 |
| interrupt_agent | target | {previous_status}；是提交前状态，不是停止完成的确认 |
| list_agents | path_prefix 可选 | {agents:[{agent_name, agent_status}]} |

`AgentStatus` 包含 `pending_init`、`running`、`interrupted`、`shutdown`、`not_found`，以及带内容的 `{"completed": string|null}`、`{"errored": string}`。没有一个裸 `idle` 状态可以代替所有已结束结果。

上表是原版合同；SwarmEnv 已选择 Bash/Service 形式，可在返回中提供请求回执，wait 也可直接带消息正文。不能把这种允许的适配写成原版原生返回值完全相同。[原版 schema][U-schema] · [消息 handler][U-message] · [wait handler][U-wait]

## 3. 逐项功能核对

### 3.1 普通任务与持续交互

| 编号 | 应有行为 | 当前情况与补改 | 验收方法 |
| --- | --- | --- | --- |
| A01 | Root 接收用户的实际任务，自主决定是否委派及创建数量。 | **不同｜Env。** 移除普通流程的 childCount 下限、精确人数与强制续轮；只保留人数等上限。 | 直接回答、创建一个 Child、递归创建都能被普通入口接纳；无需凑人数。 |
| A02 | 任务的最终回答不要求固定题目、固定引用数量或特殊 JSON。 | **不同｜Env。** 把固定题目、checkDelivery 与 stages.ts 留在测试入口；普通回答与可选任务检查器分开。 | 自然回答正常返回；原固定通信测试仍可单独运行。 |
| A03 | 用户可以在运行期间补充输入，原 Root 和会话继续。 | **部分｜Env。** 当前 goal + supplements 在启动时统一提交；增加持续输入入口并接等待唤醒。 | Root 未回答前输入补充；同一 Root 在真实模型请求中收到它。 |
| A04 | 一轮回答结束后可继续交互；结束整次运行由宿主决定。 | **部分｜Env。** 区分 Root 回复、任务检查结果和全队关闭；等待回复不能阻塞新 input/status。 | Root 回答后能追问；停止时整队收尾，业务失败与清理失败分别可见。 |

依据：[当前入口][S-main] · [固定 Prompt][S-prompts] · [固定阶段脚本][S-stages] · [前台宿主][S-host] · [命令处理][S-commands]。

这里的“固定测试场景”指原来为了测试而规定的题目、人数、轮次和检查器。它们保留在测试入口，普通运行不强制使用；不是简单把同样的限制改写进一个配置文件。

### 3.2 spawn_agent：创建、递归和继承

| 编号 | Codex V2 行为 | 当前情况与补改 | 验收方法 |
| --- | --- | --- | --- |
| B01 | task_name 与非空 message 创建一个 Child 并提交首任务；返回身份，不同步等待最终答案。 | **部分｜Service。** 包装现有 runtime.spawn + start；创建身份与首任务是否受理分别记录。 | 调用先返回 Child 身份，Child 随后执行；首任务失败不会丢失已创建的 Bot。 |
| B02 | task_name 为小写字母、数字、下划线构成的单段；禁止空、root、斜杠、点段及大写。 | **缺少｜Service。** 增加名称验证和规范路径；实际正例使用 /root/a/b。 | 合法名称成功；非法名称明确拒绝。 |
| B03 | 新 Child 的父节点是实际调用者；可形成 Root → Child → Grandchild。 | **缺少｜Env + Service。** Child 获得授权的协作操作；父身份从可信 caller 推导，调用 Core parentId。 | 三层真实 Bot 关系与目录一致，伪造 parent 无效。 |
| B04 | 同一父节点下名称不可重复；不同父节点下同名可以存在。 | **缺少｜Service。** 预留规范路径并映射到 Bot ID；同一请求重试继续核对原创建。 | 同父重名拒绝；并发/丢回执不产生两个同路径 Bot。 |
| B05 | 可继续使用原 Child；容量限制只约束资源，不要求每次创建满员。 | **部分｜Env。** 用 maxAgents 表示包含 Root 的上限；idle 保留 Slot，复用原 Child。 | 少于上限合法；超过上限拒绝；清理未完成不提前释放容量。 |
| B06 | fork_turns 省略为 all，继承当前可用父会话上下文；none 不复制普通父历史。压缩历史、显式 retained items 另有规则。 | **Core 有，Env 未接｜Service。** all 映射真实父 forkFrom；none 不传；检查 fork 权限。 | Child 第一个真实模型请求体现 all/none 差别，工具调用完整，父子独立演化。 |
| B07 | 原版可按配置选择角色 agent_type 与模型；这些可选能力需在完整对照中列明。 | **部分｜Env + Service。** 以宿主预注册的 Profile 表达允许角色/模型；详细覆盖与隐藏规则见配置表。 | 允许角色生效，越权角色/模型被拒绝；实际请求使用选择的配置。 |
| B08 | Child 继承授权的运行环境；会话历史继承与工作文件可见性各有明确规则。 | **部分｜Env。** 复用 Core 私有/共享/固定副本能力，显式说明所选策略；不把 fork 当文件复制。 | 分别观察历史与文件；私有目录不凭路径字符串共享，授权共享实际可读，只读不能写。 |
| B09 | 原版返回规范 task_name；未隐藏 metadata 时另有 nickname。 | **不同｜Service。** 返回可寻址的 task_name；nickname 按配置。Bash 适配可另附受理回执，但不能把它当最终结果。 | 返回的名称能直接用于后续操作；隐藏配置不泄露对应展示字段。 |

依据：[原版创建 handler][U-spawn] · [真实创建与启动][U-thread] · [路径校验][U-path] · [当前入口/权限][S-main] · [旧 Bot Service][S-bot] · [Core 创建与文件接口][S-types]。

名称目录负责协作路径到真实 Bot ID 的映射。Core 的 parentId 和运行状态仍作为真实对象信息，不能另造一棵与 Core 不一致的树。`maxAgents` 是最多允许多少 Bot；不是要求每次把它用满。工作区是文件配置，任务路径则是 Agent 名称，两者不要混淆。

### 3.3 send_message：普通消息

| 编号 | Codex V2 行为 | 当前情况与补改 | 验收方法 |
| --- | --- | --- | --- |
| C01 | target 支持同树的 Agent ID、相对名与规范路径；相对名从调用者路径解释。 | **缺少｜Service。** 共用一个目录解析器并验证目标属于当前树。 | /root/a 调用 b 找 /root/a/b；联系兄弟用 /root/b；跨树 ID 也拒绝。 |
| C02 | 普通消息可发送给同树 Root、兄弟和自身；发送者身份可信。 | **不同｜Service。** 当前 bot.send 主要限自己/直接孩子；增加 V2 规则，按可信 caller 包装 MESSAGE/NEW_TASK/结果的来源和类别。 | 这些合法目标均可达；模型伪造 from 不能改变真实来源。 |
| C03 | 主参考配置下，普通消息入队，不因目标 idle 而主动开启新 Turn。 | **缺少｜Service + Env。** 建立外部收件箱；活动 wait 可返回正文；idle 不直接调用 start/steer。 | 给 idle 发消息后无新模型请求，消息仍在，后续明确消费可读到。 |
| C04 | 运行中的目标在允许的输入边界及时看到消息；旧 Turn 收束时可延后保留。 | **有差距｜Env / Core 接口。** get(running) 后 steer 存在目标已结束的竞态；现有公开 API 无原子“仅运行中注入”。不能以轮询宣称完整支持。 | 同时检查运行中自动送达与不误唤醒；仅靠 wait/主动读取的适配须记录此行尚未完全对齐。 |
| C05 | 发送失败向调用者明确报告；成功表示消息提交，不表示对方已经采用。原版成功输出为空文本。 | **需补｜Service。** 保存消息身份和送达状态，Bash 可返回结构化回执；重复请求不变成新消息。 | 坏目标/空消息/权限错误可见；重复投递不重复入队；采用与受理分别有证据。 |

主参考行为采用普通消息不自动唤醒 idle 的配置；wake 和 durable-sleep 的其他分支见配置表。消息写入队列、进入真实模型上下文、模型随后采用它，是三个不同事实。

**C04 的具体差距：** 当前 Core 的 steer 在 idle 时也启动工作。查询到 running 后，目标可能在 steer 到达前结束。只用外部 wait/主动读取收件箱可以保持 idle 不被唤醒，但不能保证一个从不读收件箱的 running Bot 自动收到消息。若要求两者同时严格成立，需补实际执行边界上的条件交付保证；这一问题属于 C04，不另设一套实施阶段。

依据：[目标解析/QueueOnly][U-api] · [输入队列与收束期处理][U-queue] · [运行中消息边界][U-turn] · [当前派发][S-controller] · [Core 输入实现][S-core]。

### 3.4 followup_task：让原 Agent 继续工作

| 编号 | Codex V2 行为 | 当前情况与补改 | 验收方法 |
| --- | --- | --- | --- |
| D01 | 给 idle 的现有非 Root Agent 一个新任务，启动工作并保留原身份/会话。 | **已有基础｜Service。** 新操作接 runtime.steer，复用原 Child。 | 原 Bot 第二轮继续，能使用原会话和文件。 |
| D02 | 目标 busy 时尽早送入当前工作，在允许边界生效，不固定排到下一大阶段。 | **不同｜Service + Env。** 替换当前指定 followUp 的路径；活动 wait 经同一输入入口结束等待。 | busy 的真实后续模型请求收到任务；等待中的目标也能及时继续。 |
| D03 | 拒绝 Root；同树其他合法目标可用，不额外禁止合法 Child 给自身 followup。 | **需补｜Service。** 统一解析与授权；不能沿用仅直接孩子的旧规则。 | Root 拒绝；允许的兄弟/self 调用符合参考；跨树拒绝。 |
| D04 | 参数为 target、非空 message；原版成功输出为空文本，失败明确返回。 | **需补｜Service。** Bash 回执可适配，但追加任务不等同完成任务；未知结果按同一请求核对。 | 重复与丢回执不重复激活；不能把 accepted 标成任务完成。 |

注意名字区别：原版 followup_task 对 busy Agent 尽早送达，不能直接等同于本地旧的 send(mode: followUp)。后者排到后续大阶段，现有 steer 才更接近所需行为。

依据：[原版 TriggerTurn 与 Root 限制][U-api] · [消息 handler][U-message] · [当前 Prompt][S-prompts] · [Core start/steer][S-core]。

### 3.5 wait_agent：等待自己的消息

| 编号 | Codex V2 行为 | 当前情况与补改 | 验收方法 |
| --- | --- | --- | --- |
| E01 | wait_agent 等自己的消息活动，没有“指定 child 列表”参数。 | **缺少｜Service。** 为调用者登记可取消等待；当前宿主 waitForFinal 不充当这个操作。 | 只有 timeout_ms；等待对象来自可信 caller。 |
| E02 | 已有消息立即返回；后到消息唤醒；任一 Child 的结果即可让 Parent 继续。 | **缺少｜Service。** 收件箱检查和登记等待之间不丢消息，长等待不占全局锁。 | 先到/后到都通过；一只先完成时 Parent 可继续，不必等齐。 |
| E03 | 等待发生在当前执行中，结束后原 Agent 继续。 | **Core 有基础，Env 未接｜Service + Env。** 使用真实 Bash 长调用；返回后继续同一 Pi 工作过程。 | 检查实际工具返回与紧随其后的模型请求，而不是先结束再由宿主 start。 |
| E04 | 当前执行收到用户 steer 时，等待也提前结束。 | **缺少组合接线｜Env。** 用户输入与 followup 共用入口；活动 wait 仍有效时，确认 steer 为 accepted/queued 后结束该等待；正文只送一次，unknown 按原请求核对。 | 用户输入和 followup 分别验证：等待及时结束、原会话继续、正文不重复。 |
| E05 | 默认 30 秒；最小 10 秒（不足则提升到最小值）；最大 1 小时（超过拒绝）。 | **需补｜Service。** 实现参数规则，并配置相应 Service/传输时限；运行预算可更早结束。 | 省略、过小、超上限、超时和取消各有确定结果，关闭后无残留等待。 |
| E06 | 原版返回 {message, timed_out} 摘要；消息正文由原生消息机制消费。 | **已允许适配｜Service。** 本票经 Bash 返回消息正文，保留原因/超时区分；丢响应后同请求返回同一批。 | 摘要/正文消费规则清楚；未确认的响应不造成消息静默丢失。 |
| E07 | 用户 steer 与 mailbox 同时待处理时，等待活动优先标记为 Steer；这不是任意优先级消息系统。 | **需补｜Env + Service。** 统一待处理输入判断，不让普通消息遮住新的用户要求。 | 两类输入同时待处理时，wait 以新输入中断的原因返回；输入进入后续模型请求，普通消息仍保留。 |

wait_agent 是 Agent 的工具调用；宿主等待 Root 回复是另一个接口。两者都不应阻塞其他消息或用户输入的接收。长等待使用已有 Service timeout/signal/授权复查能力，不需要把 mailbox 放进 Core。

依据：[原版 wait][U-wait] · [输入类别优先关系][U-queue] · [Service 调用合同][S-service] · [当前宿主 waitForFinal][S-controller]。

### 3.6 interrupt_agent：停止当前执行，保留 Agent

| 编号 | Codex V2 行为 | 当前情况与补改 | 验收方法 |
| --- | --- | --- | --- |
| F01 | 中断当前执行后，Agent 仍可收消息和继续任务；不等同销毁 Agent。 | **Core 有，Env 未接｜Service。** 接 runtime.interrupt，不用 bot.stop 冒充。 | 一只 Child 停止后以原身份续跑，Session/文件保留，另一只继续。 |
| F02 | 拒绝 Root 和调用者自身；合法已空闲或未加载目标不因中断而被唤醒。 | **需补｜Service。** 检查可信目标；本票不做卸载恢复，对已结束对象正确处理。 | Root/self 拒绝；idle 目标无新模型请求；坏目标明确失败。 |
| F03 | 返回发出中断前观察到的 previous_status，使用原版 AgentStatus 语义。 | **Env 未接｜Service。** 由目录的状态记录和 Core 状态合成；另保留 Core 实际中断回执。 | 返回此前状态，不能把回执、观测状态、任务最终结果混成一个值。 |
| F04 | 原版操作只接 target，没有调用方指定的执行代次参数；本项目另外要求迟到中断不误伤新工作。 | **基本能力有，严格边界待核｜Env。** 分别处理旧 ID 重放、Env 内旧任务排队、底层跨执行首次迟到；已有保障不足时才提出具体 Core 修改。 | 分别验证三种迟到；保留 #199 原验收，未解决的情形不算通过。 |

原版 previous_status 是观测状态，不是“底层已经完全停止”的完成回执。本地可以提供更清楚的执行回执。旧请求重放与首次到达但已经跨执行的请求应分别检查；不能把其中一个测试当成另一个的证明。

依据：[原版中断权限与动作][U-interrupt] · [原版状态格式][U-schema] · [Core interrupt][S-core] · [Worker 中断处理][S-worker]。

### 3.7 list_agents：真实目录与状态

| 编号 | Codex V2 行为 | 当前情况与补改 | 验收方法 |
| --- | --- | --- | --- |
| G01 | 返回当前树中可见的活 Agent，含可查询的 Root 与其他分支，不限直接孩子。 | **Core 有基础，Env 未接｜Service。** 目录结合 Core list/get；关闭历史不直接混进活列表。 | Child 可见同树其他分支，跨树不可见；与实际 Bot 存活情况一致。 |
| G02 | 可选 path_prefix，按规范路径及完整后代段过滤；支持调用者相对路径解析。 | **缺少｜Service。** 共用路径解析和按段前缀匹配。 | /root/a 匹配自身和后代，不匹配 /root/ab；非法路径拒绝。 |
| G03 | 返回 {agents:[{agent_name, agent_status}]}，状态区分 pending_init/running/completed/errored/interrupted/shutdown/not_found。 | **部分｜Env + Service。** Core idle 无法单独表达这些结果；结合真实终态和中断记录，不虚构状态。 | 完成、错误和中断可区分；completed/errored 携带对应结果信息。 |
| G04 | 上游实际枚举已加载且可查询的 runtime；持久身份目录不等同 list 的输出。 | **适配｜Service。** 本票 idle 常驻，不实现上游卸载；仍区分身份保留、当前可见、已关闭。 | 列表与寻址不矛盾；不能为了显示完整目录伪造仍活着的 Agent。 |

依据：[原版实际列表][U-control] · [路径规则][U-path] · [状态 schema][U-schema] · [Core list/状态][S-types]。

### 3.8 自动结果通知

| 编号 | Codex V2 行为 | 当前情况与补改 | 验收方法 |
| --- | --- | --- | --- |
| H01 | 完成结果自动进入真实直接父的消息队列，即使后续任务由另一分支发起。 | **部分｜Env。** 当前只回固定 Root；改成按可信 parentId 路由。 | 孙节点结果到父节点，父结果到 Root；不是全部平铺给 Root。 |
| H02 | Completed/Errored/Shutdown/NotFound 可生成相应通知；普通 Interrupted 不生成同类完成通知。 | **不同｜Env。** 当前把 aborted 也作为结果回传；区分本地事件记录与原版通知条件。 | 完成、错误、退出、中断分别核对；中断不伪装完成，也不额外制造原版没有的完成通知。 |
| H03 | 自动结果采用 QueueOnly；关闭 direct message 不会自动取消这条结果通路。 | **不同｜Env + Service。** 与普通消息共用收件箱；替换当前 followUp 派发，自动结果不依赖消息工具可见性。 | idle 父不被结果强制启动；关闭 direct message 后仍可收到合法自动结果。 |
| H04 | 完成时，原版另给发起者生成活动记录；通知正文仍带真实来源并按直接父路由。 | **部分｜Env。** 保留已有事件去重和失败记录；用可信目录生成消息来源，活动日志与结果路由分开。 | 重复终态不重复入队；不能伪造发送者；活动记录不改变结果接收者。 |

**纠正此前描述：** 不能把“每次终态，包括普通中断，都自动回父结果”归为 Codex V2 行为。原版格式化器对 Interrupted 返回空；本地仍须记录中断事件，但额外向父发送中断通知属于本地行为选择。

依据：[通知路由][U-completion] · [各状态是否形成通知][U-format] · [当前固定 Root 路由][S-controller]。

## 4. 原版配置与可选分支

这些分支属于完整对照的一部分。表中明确现状及处理方式；未实现的可选分支不会因为主配置工作正常就自动算完成，也不自动变成本票新的产品范围。

| 功能/配置 | 原版行为 | SwarmEnv 对照与处理 |
| --- | --- | --- |
| V01 能力启用 | 显式选 V2；disable_native_tools=false 才暴露原生六操作；disable_direct_message 默认 false、wait_agent_enabled 默认 true；Child 模型还须支持 V2。关闭 direct-message 不关闭自动结果。 | **Env + Service。** 生成实际帮助和授权列表；关闭的操作调用也拒绝，不能只改 Prompt。当前未提供这些完整开关。 |
| V02 角色选择 | agent_type 可按配置暴露；显式角色适用于 all/none。省略角色时，all 不额外应用 default role；none 应用 default role；其他参数仍各自继承或覆盖。 | **Env + Service。** 用预注册 Profile 表达允许角色，补省略/显式角色的映射。当前固定 parent/child 不完整。 |
| V03 模型与推理参数 | expose_spawn_agent_model_overrides 默认 true；先取父实际 model/effort，再取显式参数或子 Agent 默认值，最后角色配置仍可覆盖；换模型且显式参数与子 Agent 默认配置都没有 effort 时，才用新模型默认。 | **部分能力。** model 可映射允许 Profile；当前公开配置没有 reasoning_effort，若开放需补通用模型参数支持。不能只靠 Prompt 声称已生效。 |
| V04 service tier | expose_spawn_agent_service_tier 默认 false；schema 还需 model-overrides 开关。原版 tier 开关关闭时会过滤显式请求；开启后才校验。省略走 root/host 通常继承，显式 tier 不直接变成孙代默认。 | **缺少可选分支。** 当前公开配置未提供 tier；若开放需后端真实传参。本地若对未开放参数明确拒绝，应记为与原版过滤行为不同的适配。 |
| V05 metadata 与说明 | hide_spawn_agent_metadata 默认 true，控制 spawn 返回 nickname 等展示；V2 下不等同隐藏 role/model/effort。role 由 agent_roles 暴露，model/effort 有独立开关。 | **Env + Service。** 控制帮助、参数和返回展示；不要把“隐藏 metadata”误等于“模型参数一定隐藏”。Codex 原生呈现形式见下表。 |
| V06 fork 兼容输入 | 标准 all/none 不区分大小写并去首尾空白；省略、null、空白按 all。旧正整数文本等价 all；0/负数/其他文本拒绝。fork_context 布尔值拒绝，V2 无 items 参数。 | **Service。** 参数正规化即可；如支持该兼容分支，验证正整数等价 all，非法值拒绝。当前完全没有 fork_turns facade。 |
| V07 idle Root 消息唤醒 | wake_on_agent_messages 默认 false；打开后 idle Root 的自动唤醒仍受未中断状态、模式/预算等约束，不覆盖所有 Child。未结束 durable-sleep 另有唤醒分支。 | **Env + Service。** 默认按 C03 核对；Root 自动唤醒/durable-sleep 分支当前未接。完整列出不代表自动扩展所有模式。 |
| V08 运行中消息时机 | defer_mailbox_preemption=false 时在已完成的 assistant commentary/partial-answer 或 reasoning 项边界检查；最终回答收束后可留到下一轮。true 推迟到下一正常输入边界；与 idle 唤醒独立。 | **已选底层差异 + 未接消息。** Pi 工具批次/下一模型请求边界可使用现有 steer；不能声称复现 Codex 逐项抢占或任意 token 中断。 |
| V09 中断时机选项 | interrupt_at_item_boundary 默认 false；开启仅对 V2 Child 生效：立即取消工具，允许已注册采样在输出项边界收束；没有相应采样状态仍硬中断。 | **普通能力有，可选边界未支持。** 当前 Core 未暴露同名项边界选项；普通 interrupt 先按 F01 核对，不能把这个分支算作已完成。 |
| V10 收件箱与额外 Message Board | 六操作的 mailbox 管理 Agent 输入消息；另有可选 Agent Message Board，能接内存、SQLite、远程/MCP 等设施，它不是六操作 mailbox 的同义词。 | **Service 实现六操作收件箱。** 额外 Message Board 不因本次消息修复自动纳入；不能把内存 mailbox 或报告称作远程共享板/跨宿主恢复。 |
| V11 历史前缀与压缩 | preserve_fork_prefix 默认 true；它与 compaction 影响继承历史的布局。完整前缀可含旧 Agent 消息，需重建子身份且不继承活工具会话。 none 也可能保留显式 child_retention 项，因此并非完全空白。 | **已有 Pi fork，布局不同。** 验 B06 的合法历史、身份和独立演化；不承诺 Codex 特有原生记录逐项相同。 |
| V12 容量与深度 | 上游并发配置 4 为 Root 预留 1，非 Root 执行/驻留限制用 3；上游还能卸载 idle。V2 不使用 V1 的 max_depth 门槛。 | **Env。** 本票 maxAgents=4 表示含 Root 的 live 上限；maxDepth 是本地明确配置。idle 常驻与上游卸载机制的差异保留，不能宣称容量生命周期完全一致。 |
| V13 工具呈现与可配置提示 | 默认 namespace 为 collaboration；non_code_mode_only 默认 true，可被模型 metadata 覆盖。root/child usage hints、developer instructions、模式提示可独立配置，模型 catalog 还能覆盖工具 schema/说明。 | **Env + Service。** 提供对应帮助和可配置 Prompt；schema 覆盖不等于改变 handler。原生 code-mode 呈现按既定 Bash 适配处理。 |
| V14 native review | 启用相关 Guardian 审查时，spawn/send/followup/interrupt 受原生 review；wait/list 不走这项设置。 | **原版产品分支。** 本票使用 SwarmEnv 可信 caller 与 Service 授权；不把关闭工具或隐藏字段当授权，也不复刻 Guardian 产品。 |
| V15 dynamic tools 继承 | MultiAgentV2DynamicTools 默认 false；开启时 fresh V2 Child 可以继承父的 dynamic tools。 | **原版可选分支，未复刻。** 本地能力来自宿主允许的 Profile/Service；不把它声称为 Codex 动态工具继承。 |
| V16 环境选择 | SubagentThreadEnvironments 默认 false；默认继承当前 step 的环境选择，开启后改用 thread 配置环境。 | **实现介质不同。** 本地启动前配置镜像、工作区和服务权限；不复刻 Codex 的 turn/thread 环境选择系统。 |
| V17 上下文窗口设置 | SubagentDefaultContextLimits 默认 false；开启时清掉继承的窗口/自动压缩限制，使用 Child 模型默认。 | **原版可选分支，未接。** 当前模型/Profile 配置没有同等动态选项，不能声称 fork 已覆盖这项配置。 |

配置与工具暴露依据：[V2 配置默认][U-config] · [feature 默认][U-features] · [配置说明][U-feature-config] · [工具注册][U-spec-plan] · [工具 schema][U-schema]。

运行行为依据：[Root 消息唤醒条件][U-wake] · [输入边界][U-turn] · [中断边界选项][U-sampling] · [历史继承][U-history] · [容量与卸载][U-residency] · [可选 Message Board][U-board] · [dynamic tools 继承][U-native-spawn] · [环境选择][U-session]。

本地依据：[Profile/创建合同][S-types] · [Backend 模型配置][S-backend] · [协作 Service 可用合同][S-service]。

### 4.1 spawn 参数的继承与拒绝细节

- task_name、非空白 message 必填。未知字段拒绝；V1 的 items 不在 V2 合同内。fork_context 的布尔值会被专门拒绝，提示改用 fork_turns。
- fork_turns 的 all/none 先去首尾空白且大小写不敏感；省略、null、空白字符串按 all。可解析的正整数文本同样按 all；JSON 数字不是该 string 字段的等价写法。
- agent_type 可省略，空白相当于省略；原版有 default/explorer/worker 等内置角色，也允许配置角色覆盖同名内置角色。未知或不可用角色报错。显式角色在 all/none 都可以应用。
- 模型与 effort 从调用 step 的有效配置出发；显式字段优先于对应 agent_default_subagent_*，随后角色配置仍可能覆盖。更换模型时，只有显式参数和配置的子 Agent 默认均未指定 effort，才用新模型默认。请求模型必须匹配可用模型，V2 排除 metadata 明确禁用 multi-agent 的模型；effort 必须为该模型支持的值。请求参数先校验，不能靠随后角色覆盖让非法请求变合法。
- tier 显式请求与通常继承 tier 分开保存。原版 tier 开关关闭时会过滤传入的显式值；开启后 default 可接受，其他显式值须满足模型、feature 和 provider 支持，否则报错。没有显式值时按 root/host 通常继承；继承值若模型不支持则清除。父 Agent 本次显式 tier 不直接成为孙代默认。
- metadata/schema 是否显示字段，与 handler 是否解析或拒绝字段不是同一件事。本地 Service 需要落实实际授权，不能靠隐藏帮助文本代替检查。

**原版自身有一处需要保留的差异：** 默认 usage hint 要求 all 沿用父模型/推理并用 none 才指定覆盖；但所核 V2 handler/config 链没有硬性拒绝 all + overrides，且有 full-history 子模型变化的代码路径。本文不把提示文字误写成已经执行的拒绝规则，也不声称已取得该分支的端到端结果。

依据：[spawn 解析][U-spawn] · [子配置层叠与权限][U-child-config] · [角色应用][U-role] · [tier 继承][U-tier] · [默认提示][U-hints] · [full-history 创建路径][U-thread]。

## 5. 已约定的实现差异

以下遵循 #199/#198 已有边界，完整列出但不重新展开为额外开发项目。

| 原版能力/形式 | 本票处理 | 核对时的要求 |
| --- | --- | --- |
| 原生 function tools / 原生 Agent message 项 / code-mode namespace | 本票坚持 read/write/edit/bash + swarm Service CLI；保留协作行为，参数和输出经 Bash 表达。wait 可直接返回消息正文。 | 不为外观改造 Pi 工具层；实际帮助、权限和调用路径仍要完整。 |
| idle Agent 卸载与按需重载 | 原版可保留身份并卸载运行体；本票已决定 idle 保留 Session 和 Slot，不做 suspend/resume。 | 列表、容量、interrupt 的未加载对象分支注明差异；不把冷恢复列成本次新增工作。 |
| 离线 Replay / 跨宿主接管 | 本票明确不做；保留带时间戳的 Session、模型和 Service 调用记录。 | 运行内重试不等于进程重启恢复；记录真实关闭和未完成清理。 |
| Codex 专有 Guardian/UI 活动呈现 | 原版有 Guardian 多次拒绝的专门提示和 UI 活动项。SwarmEnv 保留自己的授权/错误/日志合同。 | 不把普通错误伪装 Guardian，也不为了本例复刻整个 Codex 客户端。 |

Codex 的历史前缀、显式 retained client items 和环境继承也不是 Pi Session/文件策略的同名功能；保持真实历史 fork、可信权限与明确文件可见性，不宣称两个底层格式相同。

## 6. 对应到现有代码

| 位置 | 直接修改内容 | 对应条目 |
| --- | --- | --- |
| examples/subagents-environment/main.ts / prompts.ts | 普通任务输入、自然回答、Root/Child 权限与可配置协作提示；移除必须人数/必须续轮/固定引用要求。 | A01–A04、B03/B05/B07 |
| 协作 Service（可新增 collaboration-service.ts，目录/收件箱可拆内部模块） | 六操作、参数检查、可信路径与调用权限、名称预留、消息与等待；调用已有 Core API。 | B01–G04、相关 V 项 |
| examples/subagents-environment/controller.ts | 真实树的结果路由、用户输入、消息交付、状态记录与统一关闭。 | A03/A04、C03/C04、D02、E02–E07、H01–H04 |
| examples/subagents-environment/stages.ts 与对应测试 | 保留固定题目/人数/引用场景作为独立测试，不再作为普通运行要求。 | A01/A02 及各功能回归 |
| 前台入口、README、编译后的 example 目录 | 用户等待回复时仍能输入/查状态；完整打包所需代码；明确运行和交付方式。 | A03/A04、六操作普通入口可用 |
| src/core / Backend / Worker | 已有 spawn/list/steer/interrupt/fork/workspace/长等待优先直接使用。只有 C04、F04 或开放 V03/V04 时发现具体通用能力不足，才在对应条目说明并修正。 | 不预设全面重做 Core |

请求去重、未知结果核对、授权、取消和关闭竞争，放在对应功能的验收中处理，不另算一组 Codex 功能。完整 Session、实际模型请求、Service 调用记录、文件导出、安装入口与 Architecture 更新仍按 #199 的交付要求检查。

Workload/domain 适配只保留正常任务、初始文件、允许工具、交付方式、可选检查器和预算等配置入口；不强制固定分工或轮次。完整跨领域任务效果仍归 #205，不增加为这份协作功能表的前置步骤。

## 源码与审核记录

- 原版：Codex MultiAgentV2 [a0d5b0a](https://github.com/openai/codex/commit/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b)。
- 当前代码：SwarmEnv [ded4cd2](https://github.com/LuNa-shi/SwarmEnv/commit/ded4cd2c32772b46a5ea581499c60c2fcf97d210)，已合入 #208。
- 对应 Issue：[Subagents #199](https://github.com/LuNa-shi/SwarmEnv/issues/199)；[Core #198](https://github.com/LuNa-shi/SwarmEnv/issues/198)；[完整任务评测 #205](https://github.com/LuNa-shi/SwarmEnv/issues/205)。
- 本次交付为功能清单与源码差距核对，没有修改运行代码、没有新增模型或原生运行验收。各项实施及通过证据回填 #199。

[U-schema]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs
[U-spawn]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs
[U-thread]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/thread_spawn.rs
[U-path]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/protocol/src/agent_path.rs
[U-api]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control/api.rs
[U-message]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs
[U-wait]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs
[U-interrupt]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control/interrupt.rs
[U-control]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control.rs
[U-completion]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control/completion.rs
[U-format]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/session_prefix.rs
[U-queue]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/session/input_queue.rs
[U-turn]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/session/turn.rs
[U-wake]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/session/turn_input.rs
[U-config]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/config/mod.rs
[U-features]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/features/src/lib.rs
[U-feature-config]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/features/src/feature_configs.rs
[U-spec-plan]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/tools/spec_plan.rs
[U-child-config]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/child_config.rs
[U-role]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/role.rs
[U-tier]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/host/service_tier.rs
[U-history]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/history.rs
[U-residency]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control/residency.rs
[U-hints]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/prompts/src/multi_agent_instructions.rs
[U-board]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/agent-message-board-host/src/lib.rs
[U-native-spawn]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/agent/control/spawn.rs
[U-session]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/session/mod.rs
[U-sampling]: https://github.com/openai/codex/blob/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/core/src/session/sampling_interrupt.rs
[S-main]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/examples/subagents-environment/main.ts
[S-prompts]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/examples/subagents-environment/prompts.ts
[S-controller]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/examples/subagents-environment/controller.ts
[S-stages]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/examples/subagents-environment/stages.ts
[S-readme]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/examples/subagents-environment/README.md
[S-types]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/src/core/types.ts
[S-core]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/src/core/index.ts
[S-service]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/src/core/service-types.ts
[S-bot]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/src/core/bot-service.ts
[S-backend]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/src/core/backend-config.ts
[S-host]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/src/environments/shared/foreground-host.ts
[S-commands]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/src/environments/shared/foreground-commands.ts
[S-worker]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/scripts/opensandbox-agent-worker.ts
[S-package]: https://github.com/LuNa-shi/SwarmEnv/blob/ded4cd2c32772b46a5ea581499c60c2fcf97d210/package.json
