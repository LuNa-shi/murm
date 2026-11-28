# JSONL 订单校验与汇总

交付零外部依赖的 Node.js 程序 `orders.mjs`。调用为 `node orders.mjs`（标准输入）或 `node orders.mjs <file>`（UTF-8 文件）。单个参数按文件路径解释。多个参数及文件打开或读取错误属于 CLI 错误。

## 记录

- 按 LF 分行，接受 CRLF 和缺少末尾换行。忽略空行及仅含空格、制表符或回车的行。后续错误使用原始 1-based 行号，含被忽略的行。
- 每条记录须为 JSON 对象，包含 `id`、`currency`、`amount_cents`。忽略未知字段。字段重复按 JSON.parse 的规则取最后一个值。
- `id` 为非空字符串，接受 Unicode，保留大小写、空白和原始字符，不做正规化。
- `currency` 只接受 `EUR`、`GBP`、`USD`，区分大小写。
- `amount_cents` 为 0 到 9,000,000,000,000 的安全整数，含两端。金额按整数分汇总。
- 最多 1,000 条非空输入行，包括错误行。第 1,001 条出现时整份输入以 `INPUT_LIMIT` 拒绝，丢弃部分输出。任意币种累计最大值为 9,000,000,000,000,000，仍在安全整数范围内。

每条非空行只取一个错误，按下表顺序检查。除输入条数超限外继续处理后续行。只有通过所有字段校验并被接纳的 ID 才参与重复判断。

| 错误码 | 条件 |
| --- | --- |
| `INVALID_JSON` | JSON 语法错误 |
| `INVALID_FIELDS` | 非对象、缺必需字段、字段类型错误或空 ID |
| `INVALID_CURRENCY` | 币种不在列表内 |
| `INVALID_AMOUNT` | 数值非安全整数或超出金额范围 |
| `DUPLICATE_ID` | ID 已被合法记录使用 |

## 输出与退出码

对可处理的输入，stdout 写一个 JSON 对象和末尾 LF，stderr 为空。对象键顺序不限，数组顺序按输入。输出包含且仅包含以下键。

- `valid` 为合法订单数组，每项恰含 `id`、`currency`、`amount_cents`。
- `totals` 为已出现的合法订单币种到整数分的对象，零金额币种仍保留。
- `errors` 为错误数组，每项恰含 `line` 和 `code`。

| 退出码 | 条件 |
| --- | --- |
| 0 | 无数据错误，包括空输入 |
| 1 | 至少一条数据错误，并返回完整汇总与错误列表 |
| 2 | stdout 为空，stderr 为一个恰含 `code` 键的 JSON 对象加 LF。错误值为 `INPUT_LIMIT`、`USAGE` 或 `FILE_ERROR`。 |

检查 Service 的业务 operation 为 `check_orders({ jsonl })`。对可处理的输入返回同一业务对象，即使其中有逐行错误；超限返回 `{ "code": "INPUT_LIMIT" }`。实际 Service ID、manifest 和程序由 Lead 在 Run 内产生。最终程序使用自身提交的代码，能够离线独立工作。
