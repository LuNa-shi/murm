# Issue 与 PR

仓库使用GitHub。Issue保存获批准的行为与验收合同，PR保存可审阅实现。可使用已授权的GitHub连接器或 `gh` CLI；不因具体工具差异改变权限与验收要求。

当前仅草拟 [三个第一阶段Issue](../plans/phase-1/README.md)，未获发布指令前不创建/关闭Issues，不修改#107状态或标签。ready-for-agent只用于需求、前置条件及验收均已确认的工作。

每项包括问题与证据、交付行为、两小时真实验收及反证、必要回归、依赖和不做的内容。Issue引用规范，不复制成第二套架构。仓库工作分支按 `codex/issue-<number>-<slug>` 或批准的docs分支命名。

一个总Issue跟踪三个sub-issues的完成。实现可以有明确依赖，但每项在其前置基线上必须独立演示与验收。不存在只改schema却把可用行为留给下一项的完成方式。

**PRs as a request surface: no.** 文档草稿PR由本次用户直接授权提出，讨论中的数值门槛未自动成为已批准Issue。
