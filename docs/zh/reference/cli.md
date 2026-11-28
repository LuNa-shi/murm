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
| `murm` | 在当前目录打开 Subagents 终端界面 |
| `murm setup [--mode existing\|local] [--endpoint <url>] [--public-url <url>] [--config <module>]` | 本地启动托管 OpenSandbox 并自动生成密钥（`--mode local`），或验证连接已有 OpenSandbox 服务（`--mode existing`），随后准备所选 Worker 镜像 |
| `murm doctor [--config <module>] [--smoke]` | 只读诊断配置与 Lifecycle 鉴权；加 `--smoke` 拉起真实 Pi/Codex Worker 运行端到端冒烟验证 |
| `murm init --template subagents --dir <directory>` | 在指定目录生成可编辑的独立 Subagents 项目脚手架 |
| `murm --harness <module> --prompt <text> [options]` | 在前台对项目目录运行内置、本地 ESM 或 npm 包 Harness |
| `murm --harness <module> --mode rpc [options]` | 通过 JSONL `stdin`/`stdout` 以 RPC 模式运行 Harness，支持 `ready`、`run`、`status`、`stop` 控制 |
| `murm trace [--root] <runs-dir> [--port 8787] [--open]` | 在 `127.0.0.1` 启动内置浏览器 [Trace Viewer](../trace-viewer.md) |

### 前台终端界面

使用 `murm`、`murm --harness notes` 或 `murm --mode tui --harness subagents --prompt '预填草稿'` 打开界面。stdin 和 stdout 均需连接终端。`--cwd` 指定提交时要捕获的项目。相对 Harness 路径、`--config` 与 `--output-dir` 从执行命令的目录解析。

- F1 查看 Run 和配置，F2 查看 Agent，F3 查看结果，F4 查看待答和已结算问题。
- F5 编辑初始任务或发送 Run 输入。F6 选择配置、Agent 或问题。F7 打开 Agent 操作、在 Subagents 的 Run 页选择 followUp，或预览保存的报告。F8 确认停止整个 Run，F9 核对结果未知的操作。Alt+Enter 换行，Esc 关闭编辑器并保留草稿。Page Up 和 Page Down 滚动，End 恢复跟随最新 Agent 输出。
- 在 F6 选择可信的 ESM 配置，或使用内置环境变量。Doctor 执行只读检查，Setup 需要明确确认。记住配置只将绝对路径与适用 Harness ID 保存到 `$XDG_CONFIG_HOME/murm/launcher.json`（通常为 `~/.config/murm/launcher.json`）。`--config` 优先于已保存路径，可在 F6 清除偏好。缺少模型或模板时仍能打开配置。
- Subagents 在 TUI 默认保持交互。`--lifetime task` 允许任务完成后自动结束，`--interaction none` 单独关闭问答。运行时 Ctrl+C 请求有序停止并停留在结果页，运行前或结算后按 Ctrl+C 可退出。
- 退出码 0 表示成功或运行前正常退出，1 表示失败、取消或收尾未确认，2 表示启动、参数或终端错误。收到 SIGINT 或 SIGTERM 时先请求停止活动 Run，退出码分别为 130 和 143。

旧模板用户若要继续运行自定义 host，可在项目目录执行 `node ./main.js ./config.js --interactive`。新模板的 `npm start` 已指向该命令。`npm run tui` 使用已安装的内置 Harness 和项目的配置。Init 保留已有项目文件。

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

内置 CLI Harness（`subagents`、`taskpool`、`notes`、`messages`）共享同一套宿主机环境变量。OpenSandbox 连接由公共 resolver 解析，普通变量优先于旧的 Harness 专属别名：

| 变量名 | 默认值 | 用途 |
| --- | --- | --- |
| `MURM_MODEL_URL` | *（必填）* | 兼容流式 OpenAI Responses 的模型端点（以 `/v1/responses` 结尾） |
| `MURM_MODEL_TOKEN` | *（可选）* | 上游模型 Bearer 密钥，仅保留在宿主机 Model Gateway |
| `MURM_MODEL_PROVIDER` | `openai` | Pi/Codex 路由的提供方名称（支持任意自定义 provider） |
| `MURM_MODEL_ID` | `gpt-5.4` *（Pi）* | 传给上游端点的模型 ID（当 `MURM_EXECUTOR=codex` 时必填） |
| `MURM_EXECUTOR` | `pi` | 执行器后端：`pi` 或 `codex` |
| `MURM_WORKER_IMAGE` | `DEFAULT_WORKER_IMAGE` | 自定义 Docker Worker 镜像（默认 `ghcr.io/luna-shi/murm-worker:0.2.0`） |
| `OPEN_SANDBOX_ENDPOINT` | `http://127.0.0.1:8080/v1` | OpenSandbox endpoint，优先于保存的连接 |
| `OPEN_SANDBOX_API_KEY` | *保存的连接* | OpenSandbox 管理凭据 |
| `MURM_RUNTIME_PUBLIC_URL` | *保存值或本地发现* | Sandbox 可达的共同 Runtime 回调地址 |
| `MURM_ADVERTISE_HOST` | *本地发现* | 高级回调宿主覆盖 |

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

## murm recover

```sh
murm recover --run-dir /private/runs/original-runtime-id --config /private/recovery.mjs
```

配置模块默认导出原始 Runtime options 对象或返回 options 的零参数异步工厂。命令只恢复清理权限，调用 `close()` 并输出回执；仅清理完成时退出 0。需要同主机、同 boot 的独占 writer 和匹配的持久化配置。待处理资源继续留账，并保留有限截止时间。参见 [Runtime 恢复](../runtime.md#持久化恢复与-kubernetes)。
