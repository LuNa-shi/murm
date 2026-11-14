---
name: use-workspace
description: 读取公开项目文件，保存不可变 revision，在同一 E 接续版本并请求合入 main。
---

# 使用 Workspace 文件与共同主线

Workspace 在 sandbox 外由 Runtime 管理 Git。你只修改当前 E 的 /workspace/project。candidate 是某一 revision 中的普通文件；不存在 Candidate ID 或专用存储。

1. 用 view、files/read/search --at R 理解确切版本。若使用 --at main，保留 resolved revision；用 history --all 发现未合入的公开版本。
2. 用 status/diff 区分 take 时的初始输入、当前工作基准、parents、最近保存版本和未保存修改。
3. 值得保留的文件调用 save。Runtime 固定一致文件树，返回 revision、changed paths 和来源；main 不动。连续 save 的 parents 沿上一保存版本，并包含 apply 的来源；编号大小不等于继承关系。检查与引用都绑定这份固定版本。
4. 接续公开 R 或跟进 main 时，先 save 未保存改动，再 apply --from R 或 main。Runtime 取得稳定窗口后才三方整合目录并记录 parents；main 不动，初始输入不改写。apply 响应未知时查询原请求，不重复安装；Runtime 对账期间暂停该工作面的新写入。
5. apply 后未保存的目录不是持久 revision。接续带未解决冲突的 revision 会继承冲突状态，换 E 不会清除。可由当前 E 修改文件解决后 save --resolved；普通 save 可保留未解决进度但不解除 merge 限制。独立、复杂或超出预算的责任才另提整合 Task；main 前进本身不要求换 Bot。
6. 认为成果适合共同主线时，直接 merge --from R。原 Task 不必专门包含合入；若 done 明确要求 main 包含成果，则需合入成功才能 done。
7. 审阅整个 revision 的全部变更，按整版粒度请求 merge。一个 path 只定位文件，不能作为仅合入该文件的参数；只需部分成果时先准备新的完整 revision。
8. Runtime 对 R 和当前 main 三方合成，检查最终固定树并条件更新。不同合成内容必须重新检查；main 发生并发变化则按有界重试处理，不能强制覆盖或套用旧 PASS。
9. merge 成功不改变当前 E 目录，需要新主线时显式 apply --from main。失败保留源 revision、固定 M/R 和诊断，不保证公开失败合成树。若合入的是其他 Bot 的 R，先核对当前目录是否已包含其变更；没有时先 save 自己的进度，再 apply --from R、解决冲突并保存，然后 apply 固定 M 或明确重新读取的最新 main，修复/save 后重试。不能只 apply main 而丢失待合入的 R。明确冲突后用新尝试 ID，未知响应继续原 ID；不能无限重试耗尽收尾额度。已包含的 R 可返回 no-op；曾合入但被后续撤回的成果需要新的修正 revision，重复提交旧 R 不表示恢复。

未合入的实验版本可以不再选用，不要求专门 discard 或删除。需要改变当前项目文件集合时，通过普通文件修改/删除后 save 表达；历史 revision 仍可读取。没有 candidate discard，也不为多文件成果创建 manifest 对象。

Mission 验证期间 main merge 会冻结。查询现有 submission，不用其他接口绕过；save/apply 本身不改变被验收快照。
