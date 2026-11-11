# Observability 运行与数据边界

> Type: Operations · Status: Current entry guide, verify flags against source · 2026-11-11

`scripts/serve-observability.mjs` 启动观测服务；`src/observability/` 维护事件接收、持久化与查询，相关源码及测试比历史部署说明更权威。前端以 Experiment 列表、Core 时间线、Execution 交互、Task/Material 和 Service 诊断等视图展示已记录活动。

静态报告导入、实时 SSE 和持久 Observation Store 的配置依赖部署环境。运行或重新部署前检查当前 CLI、监听地址、观测数据库位置及对外访问权限。不要在公共服务暴露 raw Agent 对话、候选/证明源码、token 或私有路径。

`experiments/.observability/` 是共享观测数据的本地忽略存储；每次实验的观测元数据与固定代码提交需要保留。事件汇总可以帮助定位问题，但不是 Task、Context、Judge 或 Runtime 的权威状态，也不能从利用率或 Material 数直接推断有价值研究。详情见 [架构 06](../architecture/06-observability-experiments.md)。

实验的审阅和报告输出遵循 [实验流程](../workflows/experiment.md)，不是由前端仪表盘自动宣布实验成功。
