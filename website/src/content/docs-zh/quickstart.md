---
title: 快速上手
description: 从源码检出目录运行 Subagents 示例，查看运行报告，并在独立项目中安装 @murm/core。
section: 快速开始
order: 1
---

## 1. 克隆并构建

在运行 rootful Docker Engine 的同一台 Linux 主机上使用 Node.js 22.19 或更新版本及 npm。示例需要本地 OpenSandbox provider 和兼容的 Worker 镜像。[主机要求](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/07-run-configuration.md#host-checks-and-checkout-preparation)

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci
npm run build
```

如果主机还缺少 OpenSandbox 或 Worker，请在检出目录根目录运行 `./scripts/setup`，代替上面的安装和构建命令。它会构建源码、准备基础设施，并使用本地模型端点验证真实 Sandbox。配置示例时请使用输出中 `worker.id` 的值。

## 2. 配置示例

创建 `examples/subagents/.env`，填入 Worker 镜像 ID 和支持流式响应及工具调用、接受 `k3` 的 `/v1/responses` 端点。如果端点需要 Bearer 认证，再填入令牌。

```bash
MURM_SUBAGENTS_IMAGE="sha256:<your-worker-image-id>"
MURM_SUBAGENTS_MODEL_URL="https://your-gateway.example/v1/responses"
MURM_SUBAGENTS_MODEL_TOKEN=""
```

OpenSandbox 生命周期端点默认为 `http://127.0.0.1:8080/v1`。如果端口不同或 provider 需要认证，请参阅 [Subagents 配置说明](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md#run-from-the-checkout)。

## 3. 运行任务

```bash
cd examples/subagents
node --env-file=.env ../../dist/examples/subagents/main.js \
  ../../dist/examples/subagents/config.js \
  'Suggest two checks to make before merging a pull request.'
```

示例等待 Root 回复，随后关闭团队并报告 `subagents-runs/<runtimeId>/harness-report.json` 的路径。报告包含任务结果和 Sandbox 清理回执。可以在该目录下修改 `main.ts` 或 `config.ts`，然后回到检出目录根目录重新构建。

请将 Run 目录保留在私有位置，其中可能包含模型请求、Service 调用和归档会话。

## 4. 尝试自定义 Service，或在独立项目中安装 Core

[Notes 示例](https://github.com/LuNa-shi/murm/tree/main/examples/notes) 演示两个 Agent 如何通过自定义 Service 交接一条事实，再由宿主校验读取者保存的文件。示例 README 说明了如何从 Core 安装包运行，以及如何离线查看已保存的 Run。

要在自己的项目中安装同一个包，请将 `repo` 设置为源码检出目录的绝对路径：

```bash
repo=/absolute/path/to/murm
mkdir my-harness
cd my-harness
npm pack "$repo" --pack-destination .
npm init -y
npm pkg set type=module
npm install --omit=dev --ignore-scripts ./murm-core-0.2.0.tgz
```

```ts
import { createRuntime } from '@murm/core';
import { ServiceRegistry } from '@murm/core/services';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';
```

## 下一步

| 目标 | 推荐阅读 |
| --- | --- |
| 理解 Harness 如何组织各个组件 | [核心心智模型](../concepts/) |
| 了解宿主、Worker、Bridge 与 Model Gateway | [系统架构与边界](../architecture/) |
| 走读 Agent 启动到清理的生命周期 | [一次运行的完整脉络](../run-lifecycle/) |
| 对比 Agent 协作模式 | [五种协作拓扑总览](../harnesses/) |
| 实现自定义 Service 与 Harness | [构建你自己的 Harness](../build-your-harness/) |
