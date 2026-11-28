---
title: 最新版本 (v0.2.0)
description: murm v0.2.0 完整功能说明——统一的 @luna-shi/murm SDK 与 CLI、开放 Pi 模型目录的 Pi/Codex 双执行器、内置 Trace Viewer 与五种内置 Harness。
section: 版本与更新
order: 15
badge: v0.2.0
---

**`murm v0.2.0`**（发布日期：**2026-11-27**）是 `@luna-shi/murm` 的首个正式开源版本，将 TypeScript SDK、宿主机 CLI 与零外部依赖的浏览器 Trace Viewer 整合为单一安装包，用于构建、隔离运行并观测多智能体 Harness。

本页描述已发布的 v0.2.0 安装包。[当前源码快速上手](quickstart.md)使用较新的 setup 与 Provider 接口，需要安装从当前检出源码构建的候选包。

| 发布产物 | 说明与链接 |
| --- | --- |
| **版本号** | `v0.2.0`（[GitHub Release](https://github.com/LuNa-shi/murm/releases/tag/v0.2.0) · [SHA256SUMS](https://github.com/LuNa-shi/murm/releases/download/v0.2.0/SHA256SUMS)） |
| **安装包** | `@luna-shi/murm`（单包内置 SDK、`murm` CLI、`swarm` CLI 与 `murm trace`） |
| **官方 Worker 镜像** | `ghcr.io/luna-shi/murm-worker:0.2.0`（支持 `linux/amd64`、`linux/arm64`，SDK 导出为 `DEFAULT_WORKER_IMAGE`） |
| **执行器** | Pi `1.3.0`（默认） · Codex CLI `0.172.0` |
| **完整变更记录** | [查看更新日志](changelog.md) |

## 安装或升级到 v0.2.0

通过托管在 GitHub Pages 的一行脚本全局安装最新 CLI：

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
murm setup
```

或直接使用 npm 从 GitHub Release 安装：

```bash
# 全局 CLI（指向最新 Release）
npm install -g --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz

# 项目 SDK 依赖（锁定 v0.2.0）
npm install --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

> 使用 npm 12+ 从包含 GitHub Release tarball URL 的 lockfile 重新安装时，同样需要传入 `--allow-remote=root`（例如 `npm ci --allow-remote=root`）。

## v0.2.0 核心功能

### 1. 统一的 `@luna-shi/murm` TypeScript SDK

收束后的根入口仅导出 7 个公开运行时符号与完整 TypeScript 类型声明：

- `createSandbox` — 配置同宿主机 Docker OpenSandbox 隔离后端（CPU/内存限额、`tmpfs` 字节与 inode 配额、命令与会话超时）。
- `createRuntime` — 管理 Agent 生命周期（`spawn`、`get`、`list`、`send`、`interrupt`、`stop`、`close`）、实时事件流、动态管理接口、文件快照与确定性清理回执（`StopReceipt`、`CloseReceipt`）。
- `DEFAULT_WORKER_IMAGE` — 直接指向与当前版本匹配的预构建 Worker 镜像（`ghcr.io/luna-shi/murm-worker:0.2.0`）。
- `getExecutorCapabilities` — 查询执行器是否支持途中 `steer`、队列取消、非唤醒投递和会话上下文分叉。
- `ServiceRegistry`、`createInProcessAdapter`、`createHttpJsonAdapter` — 基于 Service v2 协议注册进程内或外部 HTTP JSON Service，支持按 Profile 粒度声明操作白名单，并在提交副作用前通过 `assertAuthorized()` 复核调用者权限。

`v0.2.0` 内置的关键 Runtime 能力：

- **实时事件流**：`runtime.onEvent` 推送 `output`、`settled`、`error`、`exit`、`agentChanged`、`runtimeChanged` 与 `management` 事件。
- **文件快照与 CAS 替换**：`runtime.files.snapshot` 与 `runtime.files.replace` 支持对暂停中的 Agent 文件树做只读快照与基于 SHA-256 摘要（`complete:sha256:...`）的原子替换。
- **运行中动态管理**：`runtime.profiles`、`runtime.services`、`runtime.access` 与 `runtime.management.get()` 支持在 Run 期间动态注册 Profile、上线或下线 Service、授予或撤销 Agent 权限，并接受 `agentAccessPolicy` 宿主策略守卫。

详细签名与实战示例请阅读 [Runtime 运行控制面](runtime.md)、[Services 与权限](services.md) 与 [SDK 与 API 参考](reference/api.md)。

### 2. Pi / Codex 双执行器与开放 Pi 模型目录

所有 Agent 均通过宿主机 **Model Gateway** 访问模型，上游 API Key 严格留在宿主机，容器仅持有可即时吊销的单 Agent 令牌：

- **Pi（`1.3.0`，默认）**：支持会话上下文分叉（`spawn({ forkFrom })`）、途中 `steer`、`followUp` 排队、非唤醒条件投递（`wakeIfIdle: false`）以及已入队输入取消。
- **Codex CLI（`0.172.0`）**：可通过 `executor: 'codex'` 或 `MURM_EXECUTOR=codex` 切换，复用同一套 Model Gateway 与 Service Bridge。
- **开放的 Pi 模型支持**：内置 `openai` Responses 常用模型目录（`gpt-5.4`、`gpt-5`、`gpt-5-mini`、`gpt-4.1`、`gpt-4.1-mini`、`o4-mini`），并允许配置**任意**流式 OpenAI Responses 兼容的 `provider` + `model` 组合——宿主机自动合成并附加 SHA-256 校验摘要传递给 Worker。

### 3. 宿主机隔离与凭证安全边界

每个 Agent 运行在由 OpenSandbox（`release-1.2.0`）编排的独立 Linux Docker 容器中：

- **文件系统隔离**：Landlock ABI 5+ 策略（`agent-filesystem-policy`）配合每沙箱独立配额的 `tmpfs`（`mount-agent-workspace.py`）。
- **网络出站隔离**：按 UID 生效的 `nftables` 规则仅放行宿主机 Service Bridge 与 Model Gateway（仅在显式配置 `Profile.network.allow` 时放行指定内网服务，如 PeerMesh / Lead-Worker 的 Gitea）。
- **凭证隔离**：上游模型密钥与外部 Service 管理员令牌永不进入 Agent 容器。

### 4. 统一 `murm` CLI 与透明初始化

`murm` 命令行工具统一覆盖环境初始化、诊断、脚手架、Harness 运行与轨迹回放：

| 命令 | 用途 |
| --- | --- |
| `murm setup` | 检查 Linux/Docker/Landlock/`sudo` 依赖，启动本地 OpenSandbox `release-1.2.0`，拉取 `ghcr.io/luna-shi/murm-worker:0.2.0`（离线或本地开发时自动回退本地 Dockerfile 构建），并执行真实回环冒烟探测。 |
| `murm doctor [--config <file>] [--smoke]` | 只读诊断宿主机环境与 Harness 配置，可选运行真实沙箱冒烟校验。 |
| `murm init --template subagents --dir <dir>` | 在指定目录生成可编辑的独立 Subagents Harness 项目脚手架。 |
| `murm --harness <builtin\|file\|pkg> --prompt <text>` | 在当前项目目录运行内置或自定义 Harness，支持前台运行与 JSONL `--mode rpc`。 |
| `murm trace --root <dir> [--port 8787]` | 启动内置浏览器 Trace Viewer，查看历史归档或正在进行的 Run。 |

内置 CLI Harness（`subagents`、`taskpool`、`notes`、`messages`）统一支持 `MURM_MODEL_URL`、`MURM_MODEL_TOKEN`、`MURM_MODEL_PROVIDER`、`MURM_MODEL_ID`、`MURM_EXECUTOR` 与 `MURM_WORKER_IMAGE` 环境变量。

### 5. 内置浏览器 Trace Viewer（`murm trace`）

在 `v0.2.0` 中，Trace Viewer 直接整合进 `@luna-shi/murm`（`src/trace-viewer/`），零额外依赖即可运行：

- 多 Agent 泳道时间线与跨 Service 协作交接连线；
- 模型请求/响应、Service 调用、Pi/Codex 原生会话与导出产物检查器；
- 基于可恢复 SSE（Server-Sent Events）的实时运行追踪；
- 在远程 SSH 会话中启动时自动打印对应的 `ssh -N -L` 端口转发命令。

详见 [Trace Viewer 使用指南](../operations/trace-viewer.md)。

### 6. 同一 Runtime 驱动的五种参考 Harness

仓库内置五种协作拓扑，共享同一 Runtime，仅在协作协议与 Service 组合上有所差异：

| Harness | 协作模式 | 指南 |
| --- | --- | --- |
| **Subagents** | 父子递归命名委派、可选 Pi 上下文分叉、非唤醒邮箱与中断恢复 | [Subagents](harnesses/subagents.md) |
| **TaskPool** | 带租约与防脑裂版本的独占任务池、Material 谱系、Git Workspace 版本与集中 Judge 校验 | [TaskPool](harnesses/taskpool.md) |
| **PeerMesh** | 对等工程师团队，通过可重叠软认领 Board、Mattermost 群聊/私信与宿主验证的 Gitea PR 协作 | [PeerMesh](harnesses/peermesh.md) |
| **Substrate** | 对等成员围绕不可变知识库发布、检索、阅读并引用成果（含 Lean 4 FATE 定理证明配置） | [Substrate](harnesses/substrate.md) |
| **Lead-Worker** | 固定或动态编制的 Lead-Worker 团队，通过共享 Board 分工并在 Git 中沉淀交付 | [Lead-Worker](harnesses/lead-worker.md) |

横向对比请见 [选择 Harness](harnesses/index.md)。

## 从 v0.1.x 迁移

- **包名变更与合并**：将代码中的 `@murm/core` 导入替换为 `@luna-shi/murm`。如先前单独安装了 Trace Viewer 包，请卸载旧包——`murm trace` 已直接内置于 `@luna-shi/murm`。
- **默认 Worker 镜像**：内置 Harness 现在默认使用 `DEFAULT_WORKER_IMAGE`（`ghcr.io/luna-shi/murm-worker:0.2.0`），无需手动指定 `murm-worker:local` 镜像 ID。如果你维护自定义 Worker 镜像，请基于 `v0.2.0` 的 `deploy/worker/Dockerfile` 重新构建，以确保 Worker 启动契约与 Pi 模型目录摘要一致。
- **统一环境变量**：`MURM_MODEL_URL`、`MURM_MODEL_TOKEN`、`MURM_MODEL_PROVIDER`、`MURM_MODEL_ID`、`MURM_EXECUTOR` 与 `MURM_WORKER_IMAGE` 适用于 `subagents`、`taskpool`、`notes` 和 `messages`（各 Harness 专属覆盖变量仍按需生效）。

## 宿主机要求

v0.2.0 已发行版的 OpenSandbox 隔离后端需要单台 Linux 宿主机（`x86_64` 或 `aarch64`），具备 **Linux 内核 Landlock ABI >= 5**、**Node.js 22.19+**、本地 **rootful Docker Engine**、系统工具（`python3`、`nftables`、`util-linux`、`coreutils`、`iproute2`）以及最小权限免密 `sudo` 规则。该发行版的安装说明见 [v0.2.0 快速上手](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/zh/quickstart.md)。
