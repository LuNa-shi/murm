# SwarmEnv OpenAI Math 12

这是 SwarmEnv 内部保存的 12 个 OpenAI Math Lean challenge 及其参考证明源码。目录内容是运行输入的一部分，统一由本仓库的 Git 管理。

- 题目和 theorem placeholder 在 `lean/ComparatorChallenges/`。
- 参考证明源码在 `lean/OAI/`。
- 每道题的 solution module 和 theorem 映射在 `reference-solutions.json`。
- 固定版本、选择理由、依赖审核结果在 `SELECTION.md`。
- Lean 工程入口是 `lean/lean-toolchain`、`lean/lakefile.lean` 和 `lean/lake-manifest.json`。

`PlaneColoring.lean` 是额外的流程 smoke 题。12 题正式配置见仓库根目录的 `config/openai-math-12.json`。本地运行脚本会从当前仓库读取这些文件，并在启动时校验源文件摘要。
