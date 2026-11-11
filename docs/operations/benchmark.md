# 基准环境与运行入口

> Type: Operations · Status: Verify commands against current scripts before use · 2026-11-11

本仓库当前使用 PutnamBench/Lean/Mathlib 做系统协作机制实验。`scripts/run-putnambench-benchmark.mjs` 是已有入口；`config/`、`fixtures/`、`services/` 和 `src/benchmark/` 决定实际行为。这里不是新的运行协议，具体参数以该提交的脚本为准。

## 运行前检查

1. 必须有已批准的 [阶段说明](../phases/INDEX.md) 和 [实验登记](../experiments/INDEX.md)。付费真实实验需要明确授权；不因文档指令自动启动。
2. 锁定 clean SwarmEnv commit、PutnamBench revision、Lean/Mathlib、模型和 provider、prompt/schema、Core 数和总预算；相同输入才可做匹配对照。
3. 凭据使用忽略的本地 `.env` 或环境变量。`.env.example` 仅用于非敏感变量名/默认提示，不输出 secret。
4. 在本地忽略的 `experiments/` 写原始数据；提交到 `docs/experiments/` 的只能是脱敏摘要。环境缺失则记录 BLOCKED，不能静默切换 provider/model。

## 最小入口示意（非自动执行）

~~~sh
node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /path/to/PutnamBench \
  --problem putnam_2025_b1 \
  --cores 4 \
  --timebox-ms <approved-ms> \
  --provider <approved-provider> \
  --model <approved-model> \
  --experiment-dir experiments/<registered-id>
~~~

参数组合与实际可用性必须先核对当前脚本，示例中的 Core 数和题目不是默认研究决策。运行后按 [实验流程](../workflows/experiment.md) 生成并审阅报告。服务部署另见 [Built-in](../../services/builtin/README.md) 和 [Mathlib Search](../../services/mathlib-search/README.md)。
