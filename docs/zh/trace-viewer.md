---
title: 观测与调试（Trace Viewer）
description: 使用内置零依赖浏览器 Trace Viewer（murm trace）缩放回放多 Agent 泳道时间线、跨 Agent 协作交接、模型上下文与导出文件。
section: 核心构件与实战
order: 8
---

每一次 `murm` 运行都会将结构化轨迹写入 `outputDir/<runtimeId>/`。内置的 **Trace Viewer**（`murm trace`）让你直接在浏览器里回放已完成或正在进行的 Run，**无需安装任何额外前端依赖**。

上方展示的是由内置 `release-notes`（`Subagents`）演示轨迹驱动的**真实交互式泳道组件**——无需滚动内框，直接就能上手操作：

- **切换展示视图**：通过外侧顶栏按钮在 **泳道时间线**、**协作交接** 与 **产物与文件** 之间切换，或点击 **打开完整版 ↗** 进入完整工作台（含左侧 Run 列表与全量事件账本）。
- **泳道缩放与平移**：在泳道上滚动滚轮即可围绕光标精确缩放，拖拽泳道或缩略小地图平移，也可使用 `W`/`S`（缩放）、`A`/`D`（平移）和 `0`（重置）。
- **悬浮与点击检视**：鼠标悬浮任意条块可实时查看模型/工具耗时与摘要；点击任意条块会在右侧滑出 **Evidence Inspector**，支持 **Structured** 与 **Raw JSON** 两种查看方式。

## 1. 本地启动 `murm trace`

把 `murm trace` 指向包含多次运行的父目录（自动发现目录内所有 Run，包括新启动的）或单个 Run 目录：

```bash
# 查看某个 Harness 的全部运行记录
murm trace --root ./runs --port 8787 --open

# 也可以直接把目录作为位置参数传入
murm trace ./runs --port 8787
```

在浏览器打开 `http://127.0.0.1:8787`。Trace Viewer 只读取本地文件，**不需要 Docker、OpenSandbox 或模型密钥**；对正在进行的 Run 会通过 SSE 自动实时刷新。

## 2. 远程 Linux 服务器查看（SSH 端口转发）

由于沙箱跑在 Linux 执行宿主机上，推荐只监听回环地址 `127.0.0.1`，再通过 SSH 转发到你本机浏览器：

```bash
# 在 Linux 宿主机上启动（处于 SSH 会话时会自动打印本机转发命令）
murm trace --root /path/to/runs --port 8787

# 在你的本机电脑上执行端口转发
ssh -N -L 8787:127.0.0.1:8787 user@your-linux-host
```

随后在本机访问 `http://127.0.0.1:8787`。运行记录包含私有提示词与源码，请始终通过 SSH 转发查看，不要直接暴露公网端口。

## 3. `outputDir/<runtimeId>/` 里记录了什么？

| 路径 | 内容 |
| --- | --- |
| `runtime.json` | 本次运行的生效配置、Agent 汇总与最终清理回执（`cleanup: complete \| pending`） |
| `evidence.jsonl` | 宿主机按时间记录的生命周期事件账本（启动、发消息、收束、中断、停止与管理操作） |
| `service-calls.jsonl` | 经 Service Bridge 鉴权的全部 Service 调用入参、结果、耗时与错误 |
| `service-state.<id>.json` | 关闭时由各 Service `exportState()` 导出的业务状态快照 |
| `model-trace/` | 经 Model Gateway 转发的原始 `/v1/responses` 请求与流式响应 |
| `<agentId>/session/` 与 `artifacts/` | 归档的 Pi / Codex 原生会话与 `Profile.collect` 导出的工作区文件 |
| `harness-report.json` | 内置 Harness 生成的业务结果与验收报告 |

---

**下一步**：把前面 6 个核心构件全部串联起来，亲手搭建一套真正的 **[多智能体 Swarm Harness](build-your-harness.md)**！
