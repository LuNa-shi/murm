---
title: CLI 参考
description: 宿主机 murm 命令行、统一环境变量表、容器内 swarm CLI 及源码前台运行器的完整参数参考。
section: 参考手册
order: 16
---

`murm --version` 输出当前候选包的版本。已发布的 v0.2.0 使用安装时的 npm prefix 查询，例如 `npm ls -g @luna-shi/murm --depth=0`。

`@luna-shi/murm` 包含两个可执行命令：**`murm`**（运行在可信 Linux 宿主机上）与 **`swarm`**（预装在 Worker 容器内，供 Agent 经 Service Bridge 调用共享服务）。

## 宿主机 CLI（`murm`）

### 子命令一览

| 命令 | 用途 |
| --- | --- |
| `murm` | 在当前 murm 项目目录（如由 `murm init` 生成的目录）启动交互式会话 |
| `murm setup [--mode existing\|local] [--config <module>]` | 本地启动托管 OpenSandbox 并自动生成密钥（`--mode local`），或验证连接已有 OpenSandbox 服务（`--mode existing`），随后准备所选 Worker 镜像 |
| `murm doctor [--config <module>] [--smoke]` | 只读诊断配置与 Lifecycle 鉴权；加 `--smoke` 拉起真实 Pi/Codex Worker 运行端到端冒烟验证 |
| `murm init --template subagents --dir <directory>` | 在指定目录生成可编辑的独立 Subagents 项目脚手架 |
| `murm --harness <module> --prompt <text> [options]` | 在前台对项目目录运行内置、本地 ESM 或 npm 包 Harness |
| `murm --harness <module> --mode rpc [options]` | 通过 JSONL `stdin`/`stdout` 以 RPC 模式运行 Harness，支持 `ready`、`run`、`status`、`stop` 控制 |
| `murm trace [--root] <runs-dir> [--port 8787] [--open]` | 在 `127.0.0.1` 启动内置浏览器 [Trace Viewer](../trace-viewer.md) |

### 运行 Harness（`murm --harness`）

```bash
# 对当前目录前台运行内置 Subagents
murm --harness subagents --prompt "修复解析器并补充回归测试"

# 显式指定目标目录、配置模块与输出根目录
murm --harness taskpool \
  --cwd ./my-project \
  --config ./taskpool.config.mjs \
  --output-dir ./runs \
  --prompt "修复所有失败的单元测试"

# 运行你自定义打包的本地 ESM Harness 模块
murm --harness ./review-harness.mjs --prompt "审计错误处理分支"

# JSONL RPC 模式（收到 ready 后发送 {"id":"1","operation":"run","input":{"cwd":"...","prompt":"..."}}）
murm --harness subagents --mode rpc --output-dir ./runs
```

- **内置 Harness 名称**：`subagents`、`taskpool`、`peermesh`、`substrate`、`lead-worker`、`notes`、`messages`。
- **模块解析规则**：可传内置名称、显式 `.mjs`/ESM `.js` 路径，或当前启动目录已安装的 npm 包名。
- **RPC 协议（`--mode rpc`）**：`stdout` 输出 JSONL 协议帧，`stderr` 输出诊断信息。等待 `ready` 后发送包含 `cwd` 与 `prompt` 的 `run` 请求，运行期间可发送 `status` 查询状态或 `stop` 主动收尾。

## 统一环境变量清单

内置 CLI Harness（`subagents`、`taskpool`、`notes`、`messages`）共享同一套宿主机环境变量（若同时设置了各 Harness 专属前缀如 `MURM_SUBAGENTS_*`，专属变量优先）：

| 变量名 | 默认值 | 用途 |
| --- | --- | --- |
| `MURM_MODEL_URL` | *（必填）* | 兼容流式 OpenAI Responses 的模型端点（以 `/v1/responses` 结尾） |
| `MURM_MODEL_TOKEN` | *（可选）* | 上游模型 Bearer 密钥，仅保留在宿主机 Model Gateway |
| `MURM_MODEL_PROVIDER` | `openai` | Pi/Codex 路由的提供方名称（支持任意自定义 provider） |
| `MURM_MODEL_ID` | `gpt-5.4` *（Pi）* | 传给上游端点的模型 ID（当 `MURM_EXECUTOR=codex` 时必填） |
| `MURM_EXECUTOR` | `pi` | 执行器后端：`pi` 或 `codex` |
| `MURM_WORKER_IMAGE` | `DEFAULT_WORKER_IMAGE` | 自定义 Docker Worker 镜像（默认 `ghcr.io/luna-shi/murm-worker:0.2.0`） |
| `MURM_LIFECYCLE_URL` | `http://127.0.0.1:8080/v1` | 本地 OpenSandbox Lifecycle API 地址 |
| `MURM_LIFECYCLE_TOKEN` | *（可选）* | 可选 OpenSandbox API Key |
| `MURM_ADVERTISE_HOST` | `172.17.0.1` | 容器内可访问的宿主机非 loopback IPv4 地址 |
| `MURM_ENDPOINT_HOST` | `127.0.0.1` | 宿主机访问容器映射端口的本地地址 |

> `PeerMesh`、`Substrate` 与 `Lead-Worker` 还需要额外的外部设施配置（如 Gitea、Mattermost、Board MySQL DSN 或 Lean 工具链路径），请参见 [内置 Harness](../harnesses/index.md) 下对应页面。

## 容器内 CLI（`swarm`）

每个沙箱内预装了 `swarm` 可执行程序，通过 Core 注入的受保护环境变量（`MURM_BRIDGE_URL`、`MURM_BRIDGE_TOKEN`、`MURM_BRIDGE_CONTRACT_VERSION=2`）与宿主机 Service Bridge 通信：

```bash
# 发现获准调用的 Services 并查看完整 JSON Schema
swarm service list
swarm service view <service-id> --json

# 调用已授权操作（支持具名参数、--input 文件或 --stdin）
swarm <service> <operation> --input payload.json --request-id <unique-id>
swarm <service> <operation> --stdin --request-id <unique-id>
swarm service invoke <service-id> <operation> --input payload.json --request-id <unique-id>

# 内置 agent 控制（需在 Profile.services.agent 中显式授权）
swarm agent spawn --profile worker --text 'Audit src/parser.ts' --fork true --request-id child-1
swarm agent get <agent-id>
swarm agent send <agent-id> --text 'Focus on error paths' --mode steer --wake-if-idle false --request-id steer-1
swarm agent stop <agent-id> --request-id stop-1
```

### `swarm` 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 操作执行成功 |
| `1` | 传输、Bridge 或 Service 运行时错误 |
| `2` | 命令行参数或 JSON Schema 契约错误 |
| `3` | 检查器成功完成但返回业务失败判定（`fail` / `failed` / `source_failure` / `mathematical_failure` / `incorrect`） |

## 仓库前台运行器（从源码使用）

在已构建的 `murm` 源码仓库中开发或运行 `taskpool`/`peermesh` 评测夹具时，还可以使用以下两个开发者脚本（通过 `stdin` JSON 行支持 `status`、`kickoff`、`input`、`wait`、`stop`）：

```bash
node dist/scripts/run-harness.js --config <host-config.mjs>
node dist/scripts/read-harness-result.js --run-directory <dir> --runtime-id <id>
```

`runInput`、`runWithReport` 和旧结果读取函数 `readHarnessResult` 均可从 `@luna-shi/murm` 包根导入。

### 会话选项与控制

`--lifetime task|interactive` 选择生命周期，默认 `task`。Subagents 支持持续到期限或停止的前台 `interactive`。`--interaction none|questions` 声明客户端是否能回答，默认 `none`。带 `--prompt` 的显式前台入口立即发起工作。启用互动或问答后通过 JSONL 接收后续命令。`--mode rpc` 等待 `run` 命令启动。

`describe` 查询能力，`status` 读取当前快照，`answer` 按 `questionId` 回答，`agent.getState`、`agent.getStats`、`agent.getMessages` 查询底层会话。成员变更可用 `agent.configure`、`agent.compact`、`agent.abortRetry`、`agent.clearQueue`、`agent.send`、`agent.interrupt` 与 `agent.stop`，实际开放范围由 Harness 和执行器决定。`stop` 收尾整个 Run。最终结果分别记录保存和清理事实。
