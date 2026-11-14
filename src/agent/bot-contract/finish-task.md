---
name: finish-task
description: 软收尾、正常完成、动态阻塞、责任撤回或未完成交接时，先保存可用成果再终止执行。
---

# 保存交付并结束当前 Execution

停止扩展工作，读取完成条件和剩余收尾额度。软收尾允许有限 save/publish/finish；finish 已接受或硬停止后没有补交机会。

1. 判断哪些实际成果值得保留，明确验证、未验证、失败和未知。没有有用新成果也能如实退出。
2. 有文件成果时先 workspace save，取得 revision 与 changed paths，再通过公开读取确认可用。多文件成果保留同一 revision；只在本地跑过测试不等于已交付代码。
3. 有研究说明或交接内容时 publish Material，引用确切 revision/path、已完成部分、失败路线、未决问题、正在运行的服务操作 ID 和建议下一步。核对正文/附件可读，来源自动绑定。
4. 选择真实 outcome：done 需合同满足；incomplete 表示还未完成；blocked --wait-for T2 表示明确动态前置；cancelled 表示责任撤回，存在替代项时附 --replacement T3。不能放宽完成条件制造 done。
5. 发布/保存失败可在有效 E 和有限重试额度内处理；仍失败时如实记录哪些内容未持久化，不能声明共享交付或编造空材料。失败不改变已经确认的责任状态：有必要前置仍用 blocked --wait-for；责任已撤回用 cancelled；未完成且没有新前置才用 incomplete。不能因上传失败丢掉等待关系，让尚不具备条件的 Task 再次 ready。
6. 用稳定 request ID 调用 task finish。受理后 E closing，不再 save/publish。Runtime 撤权并停止全部进程，确认停止后才解除 owner/释放 Core。

后继在新 sandbox/Pi 读取公开 Task、Material 和 Workspace revision，可通过 apply 接续文件；不继承私有会话、目录或审计存档。

已被具体服务持久接受的长操作按其合同继续。交接保留可查询 ID、输入版本和未知状态；finish 不表示所有外部副作用回滚。

CLI 可能在响应完整返回前断开；最终结果由外部持久记录确定，不要求当前 Bot 在结束后查询或补交。尚未 take 且无未决 take 的 Bot 应使用 bot exit，不伪造 Task finish。
