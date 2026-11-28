---
title: 更新日志
description: '@luna-shi/murm 的版本发布记录，涵盖 v0.2.0 首个公开版本及早期里程碑。'
section: 版本与更新
order: 16
---

本页同步记录 **murm**（`@luna-shi/murm`）的历次重要变更，与仓库根目录的 [`CHANGELOG.md`](../../CHANGELOG.md) 保持一致。如需了解当前最新版本的完整功能导览，请查看 [最新版本 (v0.2.0)](latest.md)。

## 尚未发布

- Runtime 支持镜像内安装的外部执行器及经过验证的 Pi 版本。Pi 增加 Chat Completions，宿主机可接入自定义模型 transport。项目文件分阶段配置预算，通过磁盘暂存和分块支持更大的目录输入。
- Linux setup 可以接入已鉴权的 OpenSandbox 服务，也可以先部署本地服务，再准备 Worker。默认使用 API 路径。严格本地模式保留显式工作区配额与网络规则。
- SDK 可通过 `createSandbox` 接入外部 Sandbox Provider。setup、doctor 与内置配置共用连接解析。基础设施探针支持 Pi 和 Codex。
- npm 全局目录不可写时，CLI 安装器改用用户目录。本机 setup 在内置 Worker 缺失时直接用安装包构建。setup 会指出拉取失败的 OpenSandbox 镜像，并给出使用镜像站 Node 基础镜像的构建方法。

## v0.2.0 — 2026-11-27

[GitHub Release](https://github.com/LuNa-shi/murm/releases/tag/v0.2.0) · [SHA256SUMS](https://github.com/LuNa-shi/murm/releases/download/v0.2.0/SHA256SUMS) · `ghcr.io/luna-shi/murm-worker:0.2.0`

`murm` 首个正式开源版本，将 TypeScript SDK、宿主机 CLI 与 Trace Viewer 合并为单一安装包发布。

### 新增功能

- **统一的 `@luna-shi/murm` 公开 SDK**：收束后的根入口导出 `createRuntime`、`createSandbox`、`DEFAULT_WORKER_IMAGE`、`getExecutorCapabilities`、`ServiceRegistry`、`createInProcessAdapter` 与 `createHttpJsonAdapter`，附带完整 TypeScript 类型声明（[SDK 与 API 参考](reference/api.md)）。
- **实时观测与动态管理**：提供 `runtime.onEvent` 实时事件流（`output`、`settled`、`error`、`exit`、`agentChanged`、`runtimeChanged`、`management`），运行时动态管理接口（`runtime.profiles` / `runtime.services` / `runtime.access`），以及基于 SHA-256 摘要 CAS 的文件控制（`runtime.files.snapshot` / `replace`）。
- **双执行器与开放 Pi 模型目录**：在宿主机 Model Gateway 后方同时支持 **Pi（`1.3.0`）**（含 `forkFrom` 会话分叉）与 **Codex CLI（`0.172.0`）**。Pi 内置 `openai` Responses 模型目录（`gpt-5.4`、`gpt-5`、`gpt-5-mini`、`gpt-4.1`、`gpt-4.1-mini`、`o4-mini`），并支持通过宿主机动态合成与 SHA-256 校验接入任意 OpenAI Responses 兼容的自定义 `provider` + `model`。
- **统一宿主机 CLI（`murm`）**：
  - `murm --harness <builtin|file|pkg> --prompt <text>`（支持前台运行与 JSONL `--mode rpc`）
  - `murm setup`（透明宿主机预检、本地 OpenSandbox `release-1.2.0` 容器启动、GHCR 优先拉取 Worker 镜像并支持本地 Dockerfile 回退构建、以及真实回环冒烟探测）
  - `murm doctor [--config <config.js>] [--smoke]`
  - `murm init --template subagents --dir <directory>`
- **内置浏览器 Trace Viewer（`murm trace`）**：直接集成到 `@luna-shi/murm` 的 `src/trace-viewer/`，零外部依赖，提供多 Agent 泳道时间线、协作交接连线、模型/Service/会话检查器、可恢复 SSE 实时追踪与自动 SSH 端口转发提示。
- **五种参考 Harness**：基于共享 Runtime 提供 `Subagents`、`TaskPool`、`PeerMesh`、`Substrate` 与 `Lead-Worker`（[选择 Harness](harnesses/index.md)）。
- **公开分发与发布自动化**：
  - 托管于 GitHub Pages 的一行 CLI 安装脚本（`https://luna-shi.github.io/murm/install.sh`）
  - GitHub Release 提供锁定版本（`luna-shi-murm-0.2.0.tgz`）、最新稳定版（`luna-shi-murm.tgz`）与 `SHA256SUMS`
  - GHCR 提供多架构（`linux/amd64`、`linux/arm64`）官方预构建 Worker 镜像 `ghcr.io/luna-shi/murm-worker:0.2.0`
  - 部署至 GitHub Pages 的中英文双语 Astro 文档站

### 变更与优化

- 包名由 `@murm/core` 调整为 `@luna-shi/murm`，并将独立 Trace Viewer 包合并进 `@luna-shi/murm`，彻底消除全局 `murm` 命令名冲突。
- 内置 CLI Harness（`subagents`、`taskpool`、`notes`、`messages`）默认使用 `DEFAULT_WORKER_IMAGE`，统一支持 `MURM_MODEL_*` / `MURM_WORKER_IMAGE` 环境变量并保留各自专属覆盖参数。
- 重写中英文 [快速上手](quickstart.md) 与 [SDK 与 API 参考](reference/api.md)，透明列出 Linux 宿主机前置要求（Landlock ABI 5+、rootful Docker Engine、宿主机工具、最小权限 `sudoers`）并提供自包含的 TypeScript SDK 完整示例。

### 安全与隔离

- 同宿主机 Linux Docker 隔离：每沙箱独立配额 `tmpfs`（字节与 inode 限额）、Landlock ABI 5+ 文件系统策略（`agent-filesystem-policy`）与按 UID 限制的 `nftables` 出站规则（仅放行宿主机 Bridge 与 Model Gateway）。
- 单 Agent 可即时吊销网关令牌；上游模型 API Key 与外部 Service 管理员凭据始终保留在可信宿主机上。

---

## v0.1.2 — 2026-11-12

[GitHub Tag](https://github.com/LuNa-shi/murm/releases/tag/v0.1.2)

- 实现 Mission 级扁平 Task 流转、独占租约与防脑裂版本、Material 成果发布、不可变 Mission Workspace Git 版本以及集中式 Judge 校验。
- 引入独立 Service 对等节点进程与持久化 SQLite 账本。

---

## v0.1.0 — 2026-11-11

[GitHub Tag](https://github.com/LuNa-shi/murm/releases/tag/v0.1.0)

- SwarmEnv 首个真实 Agent 端到端验收里程碑：在 OpenSandbox 隔离环境中运行 Pi Agent。
