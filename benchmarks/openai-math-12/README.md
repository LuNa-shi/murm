# SwarmEnv OpenAI Math 12

这是 SwarmEnv 内部保存的 12 个 OpenAI Math Lean challenge 及其参考证明源码。目录内容是运行输入的一部分，统一由本仓库的 Git 管理。

- 题目和 theorem placeholder 在 `lean/ComparatorChallenges/`。
- 参考证明源码在 `lean/OAI/`。
- 每道题的 solution module 和 theorem 映射在 `reference-solutions.json`。
- 固定版本、选择理由、依赖审核结果在 `SELECTION.md`。
- Lean 工程入口是 `lean/lean-toolchain`、`lean/lakefile.lean` 和 `lean/lake-manifest.json`。

`PlaneColoring.lean` 是额外的流程 smoke 题。12 题正式配置见仓库根目录的 `config/openai-math-12.json`。本地运行脚本会从当前仓库读取这些文件，并在启动时校验源文件摘要。

## 可选的论文输入

保留的库函数 `selectOpenAiMathContext(config, selected, mode)` 接收所选题目及 `none` 或 `paper` 条件。12 个配置目标均支持论文条件。`paper` 条件验证每道所选题目的论文 manifest 和文件摘要，并返回包含 `benchmark/paper.pdf` 与便于搜索的同文 `benchmark/paper.txt` 的初始 Workspace 输入配置。宿主负责向 runner 传入返回的配置及题目，并保存所选条件与 manifest 摘要。制备论文包时使用原始 PDF 和 pypdf 6.4.1 逐页提取的文本（页首编号，清理行尾空白；原 PDF 的不可读控制字形显示为 �，见 k-median 的部分公式）；公式和图形以 PDF 为准。上游出处与两个文件的 SHA-256 保存在每篇论文的 manifest 中。论文沿用本目录的上游许可。

评估者使用[论文路线验收表](paper-progress/README.md)。分母、证据范围和根通过规则均在表中；这套表与 [#151 的参考实现拆分](https://github.com/LuNa-shi/SwarmEnv/pull/151) 分别定版。
