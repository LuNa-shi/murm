# 阶段说明：`<人类标题>`

状态：`DRAFT | APPROVED | CLOSED`

负责人：`<人类决定负责人>`

Worktree：`<绝对路径或worktree名称>`

## 问题

这个阶段只回答哪个项目问题？

## 假设

用一两句话写出可被实验否定的假设。

## 允许变更

- Code paths:
- Prompt/schema/tool changes:
- Report/instrumentation changes:
- Bug fixes allowed without a new decision:

## 非目标

列出不得进入本阶段的工作。

## 基线

| Input | Value |
|---|---|
| Code commit | |
| Architecture/document baseline | |
| Fixture/environment | |
| Provider/model | |
| Prompt/tool schema identity | |

## 实验矩阵

每次运行前登记规范的`EXP-YYYYMMDD-NN`。

| Experiment | Purpose | Changed variable | Primary observation | Stop condition |
|---|---|---|---|---|
| | | | | |

## 判定规则

说明什么算支持、矛盾、证据不足和停止理由。不得看完结果后再增加阈值。

## 收尾

只有人类负责人记录以下内容后，本阶段才关闭：

- what the evidence establishes;
- what remains unknown;
- which bugs were fixed inside the charter;
- which proposed changes were rejected or deferred;
- the next decision or the reason to stop.
