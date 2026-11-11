# Experiment-analysis diagnostic checklist

**唯一的正式发布模板是 [docs/experiments/TEMPLATE.md](../../../../docs/experiments/TEMPLATE.md)。** 本文件只帮助逐项检查证据，避免与项目报告格式维护两套重复规范。

## Evidence gate
- [ ] 实验 ID 与预注册输入、固定代码/模型/fixture/schema/预算、实际开始和结束
- [ ] 原始元数据、Task/Execution 状态、Runtime、Bridge、Service、Material、Workspace、Judge 的可用性及未知项
- [ ] source-verified、deterministic、controlled probe、natural run 各自标明
- [ ] 回溯报告和没有匹配对照的结论被明确标注

## Four diagnostic lenses
- [ ] Orchestration：Task 创建/认领/绑定/释放，错误权限和竞争
- [ ] Coordination：Material 生产→读取→接收决定→后续行为，包含未消费与重复使用
- [ ] Execution：Task、Execution、Session、Core、Workspace、版本、handoff/expiry/cleanup
- [ ] Tools/Judge：实际工具请求、可见错误、检查器诊断、下一 Candidate/行动

## Publication check
- [ ] Overview 只写可核实事实，分析判断提供替代原因和反证
- [ ] 下一步建议不冒充人类决定
- [ ] 判据沿用预注册；未知/未触发不能写 PASS
- [ ] 脱敏后无凭据、原始对话、证明源码、候选源码、stdout/stderr 或私人绝对路径
