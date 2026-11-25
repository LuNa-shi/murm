---
title: 安装与快速上手
description: 在几分钟内准备好运行环境，启动第一个多智能体协作会话，并检查整次运行留下的结构化轨迹。
section: 快速开始
order: 1
---

## 先花 30 秒看懂你需要准备什么

在 `murm` 中，每个 **Agent** 默认运行在一个隔离的 Docker 容器（**Sandbox**）里，保证并发改代码、跑测试时互不干扰、不污染宿主机。为了在容器里运行模型会话并提供协作命令，启动前需要准备好两样基础部件：

1. **Sandbox 运行环境**：本地运行的 OpenSandbox（Docker provider）以及一份**标准 Sandbox 镜像**（把 `Pi 1.3.0`、`swarm` CLI 和轻量监管进程打进容器的基础镜像；构建一次后，所有 Program 复用同一镜像）。
2. **模型端点**：任意兼容 `/v1/responses` 的模型服务（内置示例配置使用 `kimi_proxy/k3`）。API Key 仅留在宿主进程中，不会进入容器。

## 1. 获取源码并构建

确认本地已安装 **Node.js `>= 22.19.0`** 与 Docker，拉取仓库并编译：

```bash
git clone https://github.com/LuNa-shi/SwarmEnv.git
cd SwarmEnv
npm ci
npm run build
```

构建一次标准 Sandbox 镜像（后续所有示例与自定义 Program 共用这一镜像）：

```bash
docker build -f services/opensandbox-agent/Dockerfile -t murm-worker:local .
```

启动本地 OpenSandbox 后（默认地址 `http://127.0.0.1:8080/v1`），即可直接运行内置协作 Program。

## 2. 运行你的第一个多智能体协作：交互式 Subagents

推荐直接从 **[Subagents](../programs/subagents/)** 开始体验：它能让你像使用命令行工具一样给 Root 下达真实任务，Root 会自主拆分工作、创建具名子 Agent 并行推进，并在过程中与你交互。

配置镜像与模型端点后启动交互会话：

```bash
export SWARMENV_SUBAGENTS_IMAGE='murm-worker:local'
export SWARMENV_SUBAGENTS_MODEL_URL='https://your-model-endpoint/v1/responses'
export SWARMENV_SUBAGENTS_MODEL_TOKEN='your-bearer-token'

# 方式一：单次任务运行
node dist/examples/subagents-environment/main.js \
  dist/examples/subagents-environment/config.js \
  '分析当前项目目录，拆分成两个独立子任务并行调研后给出改进方案。'

# 方式二：交互模式（支持随时追加要求、/status 查看全队状态、/exit 关闭团队）
node dist/examples/subagents-environment/main.js \
  dist/examples/subagents-environment/config.js --interactive
```

如果容器访问宿主网桥的地址不是默认的 `172.17.0.1`，额外设置 `SWARMENV_SUBAGENTS_ADVERTISE_HOST` 为容器可达的宿主 IPv4 地址即可。

## 3. 在 Trace Viewer 中可视化检查这次 Run

运行结束后，Runtime 会把整次执行的所有现场自动脱敏并写入 `./subagents-runs/<runId>/`。你不需要手工翻阅原始 JSON 日志——直接用可视化工具打开该目录：

```bash
cd website
npm install && npm run build
npm run view -- ../subagents-runs/<runId>
```

浏览器打开终端输出的地址后，你可以看到：
- **多 Agent 泳道时间轴**：按时间或轮次查看 Root 与每个 Child 的 `Input`、`Model`、`Tools`、`Service` 并行重叠情况；
- **逐轮事件与交接流**：展开任意一次工具调用、`collaboration.spawn_agent` 或 `send_message` 的完整入参与返回值；
- **清理与归档状态**：一眼确认所有会话归档、导出文件与沙箱清理是否全部完成。

你也可以直接在在线版 [Trace Viewer](../../trace-viewer/) 页面点击 **选择本地 Run 目录** 打开本机记录（数据完全在浏览器本地解析，不会上传）。

## 4. 最小开发示例：用 Notes 看清自定义 Service

如果你准备开发自己的协作机制，想先看一个只有 2 个 Agent、1 个自定义 Service、零外部设施的极简示例，可以运行 **Notes**：

```bash
export SWARMENV_NOTES_IMAGE='murm-worker:local'
export SWARMENV_NOTES_MODEL_URL='https://your-model-endpoint/v1/responses'
export SWARMENV_NOTES_MODEL_TOKEN='your-bearer-token'

node dist/examples/notes-environment/main.js \
  dist/examples/notes-environment/config.js > notes-result.json
```

它依次驱动 `writer` 发布一条记录、`reader` 读取核对并在同一会话中完成两轮文件写入，最后自动导出并校验文件。完整代码在 [examples/notes-environment/main.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/notes-environment/main.ts)。

## 5. 作为独立包接入你自己的项目

如果想在仓库之外的新项目中导入 `@swarmenv/core`，可以通过本地打包安装：

```bash
repo=/absolute/path/to/SwarmEnv
mkdir my-murm-program && cd my-murm-program
npm pack "$repo" --pack-destination .
npm init -y && npm pkg set type=module
npm install --omit=dev --ignore-scripts ./swarmenv-core-0.2.0.tgz
```

安装完成后即可从三个公开入口导入：`@swarmenv/core`、`@swarmenv/core/services` 与 `@swarmenv/core/backends/pi-opensandbox`。

## 下一步去哪

| 你的目标 | 推荐阅读 |
| --- | --- |
| 逐个理清 Agent、Service、Runtime、Program 等核心概念 | [核心概念](../concepts/) |
| 看懂宿主、沙箱容器、Bridge 与模型网关如何协同 | [系统架构](../architecture/) |
| 对比五种内置多智能体协作机制如何实现 | [五种协作机制总览](../programs/) |
| 从零编写你自己的 Service 和 Program | [编写你自己的 Program](../build-your-program/) |
