---
title: 快速上手
description: 准备本地沙箱环境，跑通第一个多智能体 Harness，检查落盘归档，并在独立项目中安装 @murm/core。
section: 快速开始
order: 1
---

在 `murm` 中，每个 Agent 运行在由轻量级 Worker 守护进程监管的独立 Docker 容器（**Sandbox**）内，而你编写的 **Harness** 运行在宿主机的 Node.js 进程中。

开始之前，请确认本地已准备好三项前置条件：

- **Node.js `>= 22.19.0`** 与 **Docker**。
- **本地 OpenSandbox**（Docker provider），并启用仓库的 Core 项目配额支持（默认生命周期端点：`http://127.0.0.1:8080/v1`）。参见 [OpenSandbox 后端说明](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/16-pi-opensandbox-backend.md)。
- **兼容 `/v1/responses` 的模型端点**（内置示例配置使用 `kimi_proxy/k3`；上游密钥只保留在宿主机，绝不进入容器）。

## 1. 克隆、构建并制作通用 Worker 镜像

克隆仓库并将 TypeScript 源码编译到 `dist/`：

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci
npm run build
```

构建一次标准 Worker 镜像。它内置了 **Pi `1.3.0`**、`swarm` CLI 与容器 Worker 守护进程，所有内置与自定义 Harness 都复用同一镜像：

```bash
docker build -f services/opensandbox-agent/Dockerfile -t murm-worker:local .
worker_image=$(docker image inspect murm-worker:local --format '{{.Id}}')
```

> 使用 `docker image inspect` 得到的不可变镜像 ID（`sha256:...`），可以确保每个启动的 Agent 都解析到完全一致的镜像版本，并精确记录在 `runtime.json` 中。

## 2. 运行你的第一个 Harness：Notes

推荐先跑 **[Notes](https://github.com/LuNa-shi/murm/tree/main/examples/notes)**——它是最小的端到端多智能体示例（2 个 Agent、1 个进程内自定义 `notes` Service，零外部数据库或聊天服务）。

`writer` 通过 `swarm notes put` 发布一条预置事实；`reader` 通过 `swarm notes get` 读取校验并写入 `review.md`，随后在同一持久化会话的第二轮中将其复制为 `followup.md`。宿主会在停止 `reader` 后核验 Service 记录与归档文件字节。

```bash
export MURM_NOTES_IMAGE="$worker_image"
export MURM_NOTES_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_NOTES_MODEL_TOKEN='your-bearer-token'

node dist/examples/notes/main.js dist/examples/notes/config.js > notes-result.json
```

如果容器访问宿主网桥的 IPv4 地址不是 `172.17.0.1`，额外设置 `MURM_NOTES_ADVERTISE_HOST=<宿主机IPv4>`。可选生命周期参数为 `MURM_NOTES_LIFECYCLE_URL`、`MURM_NOTES_ENDPOINT_HOST` 和 `MURM_NOTES_LIFECYCLE_TOKEN`。

## 3. 检查落盘的 Run 目录与回执

CLI 会在标准输出打印包含 `runtimeId` 和 `reportPath` 的 JSON 摘要。你可以无需加载模型配置，直接离线检查 Harness 报告与 Core Runtime 摘要：

```bash
runtime_id=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("notes-result.json","utf8")).runtimeId)')
run_dir=$(node -e 'const fs=require("node:fs"),p=require("node:path"); console.log(p.dirname(JSON.parse(fs.readFileSync("notes-result.json","utf8")).reportPath))')

node dist/examples/notes/main.js --result "$run_dir" --runtime-id "$runtime_id"
```

默认配置下，每次运行会在 `./notes-runs/<runtimeId>/` 下生成一个私有（`0700`）目录：

```text
notes-runs/<runtimeId>/
├── runtime.json                 # 有效配置、停止回执与清理结论
├── harness-report.json          # 业务结果、Notes 状态与 verifiedFiles
├── evidence.jsonl               # 有序的生命周期、输入与事件时间线
├── service-calls.jsonl          # 每次经过校验的 Service 调用与返回
├── model-trace/<attemptId>/     # 请求 JSON、原始流式响应与状态元数据
└── <agentId>/
    ├── session/                 # 原生 Pi JSONL 完整会话归档
    └── artifacts/files/         # 导出的 review.md 与 followup.md
```

## 4. 体验交互式多智能体团队：Subagents

Notes 跑通后，可以启动 **[Subagents](../harnesses/subagents/)** 体验递归委派、上下文分叉与实时邮箱消息。把目标交给 `/root`，它会自动拆解任务、并行派生命名子 Agent、实时沟通并整合结果：

```bash
export MURM_SUBAGENTS_IMAGE="$worker_image"
export MURM_SUBAGENTS_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBAGENTS_MODEL_TOKEN='your-bearer-token'

# 单次任务执行
node dist/examples/subagents/main.js \
  dist/examples/subagents/config.js \
  'Inspect this workspace, split into two independent subtasks, and synthesize a concrete plan.'

# 交互式会话（随时追加需求，/status 查看团队状态，/exit 安全退出）
node dist/examples/subagents/main.js \
  dist/examples/subagents/config.js --interactive
```

默认上限为 4 个活跃 Agent（`MURM_SUBAGENTS_MAX_AGENTS`）与 3 层嵌套深度（`MURM_SUBAGENTS_MAX_DEPTH`）。

## 5. 在你自己的项目中安装 `@murm/core`

如果要在仓库外部编写自己的 Harness，可以将 `@murm/core` 打包成 tarball 并安装到独立目录：

```bash
repo=/absolute/path/to/murm
mkdir my-harness && cd my-harness
npm pack "$repo" --pack-destination .
npm init -y
npm pkg set type=module
npm install --omit=dev --ignore-scripts ./murm-core-0.2.0.tgz
```

随后即可直接导入三个公共入口：

```ts
import { createRuntime } from '@murm/core';
import { ServiceRegistry, createInProcessAdapter, createHttpJsonAdapter } from '@murm/core/services';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
```

## 下一步

| 目标 | 推荐阅读 |
| --- | --- |
| 建立 Harness、Runtime、Sandbox、Services 与 Trace 的清晰心智模型 | [核心心智模型](../concepts/) |
| 了解宿主机与容器的信任边界、Bridge 校验与 Model Gateway | [系统架构与边界](../architecture/) |
| 走读 `spawn`、统一 `send`、文件交接、`interrupt` 与 `close` 全流程 | [一次运行的完整脉络](../run-lifecycle/) |
| 从零编写自定义共享 Service 与宿主控制循环 | [构建你自己的 Harness](../build-your-harness/) |
| 对比全部五种内置协作拓扑 | [五种协作拓扑总览](../harnesses/) |
