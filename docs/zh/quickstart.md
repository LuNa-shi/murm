---
title: 快速上手
description: 使用公开 TypeScript SDK，跑通一次有结果验收的双 Agent Service 交接。
section: 快速开始
order: 1
---

本文运行 [Messages 交接示例](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services)：宿主程序把一个值放进 writer 的工作区，writer 通过 Service 发布它，reader 读取并写入 `received.txt`，最后由宿主核对导出文件并保存报告。

## 1. 准备代码与执行环境

需要 **Node.js 22.19 或更新版本**、npm，以及运行 rootful Docker Engine 的 Linux 宿主机。当前后端还需要同宿主机上的 OpenSandbox Lifecycle API，以及包含 `jq` 的兼容 murm Worker 镜像。

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci
npm run build
```

如果还没有准备 OpenSandbox 和 Worker 镜像，在 checkout 根目录运行 `./scripts/setup`。它会构建代码、准备本地基础设施，并使用本地模型端点对真实 Sandbox 做探测。下文使用它输出的 Worker 镜像 ID。宿主检查与配置详见 [环境准备参考](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/07-run-configuration.md#host-checks-and-checkout-preparation)。

## 2. 配置模型与 Worker

设置 Worker 镜像名称或 ID，以及支持流式输出的 OpenAI Responses 兼容端点完整 URL。这些变量由 [`handoff-config.ts`](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff-config.ts) 读取。

```bash
export MURM_SDK_IMAGE='your-worker-image'
export MURM_SDK_MODEL_URL='https://your-gateway.example/v1/responses'
export MURM_SDK_MODEL_TOKEN='your-token-if-required'
```

示例默认使用 Pi，provider 为 `kimi_proxy`，模型为 `k3`。若要使用 Worker 支持的其他模型，设置 `MURM_SDK_MODEL_PROVIDER` 与 `MURM_SDK_MODEL_ID`。使用 Codex 时，还需设置 `MURM_SDK_EXECUTOR=codex`；此时必须提供 `MURM_SDK_MODEL_ID`，provider 默认是 `openai`。

OpenSandbox 默认地址为 `http://127.0.0.1:8080/v1`，Sandbox 可访问的宿主地址默认为 `172.17.0.1`。需要时通过 `MURM_SDK_LIFECYCLE_URL` 和 `MURM_SDK_ADVERTISE_HOST` 覆盖。[示例 README](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/README.md#run-the-typescript-handoff) 还列出了生命周期令牌、端点宿主地址、输出目录和外部 Messages Service 的配置。

## 3. 运行交接

在 checkout 根目录执行：

```bash
node dist/examples/bridge-services/handoff.js
```

程序向 stderr 输出观察游标与事件种类，最后向 stdout 输出一条 JSON，包含交接标识、原始输入 request ID 和报告。默认报告路径是：

```text
handoff-runs/<runtimeId>/run-finalization.json
```

这个示例仅使用公开包入口。打开 [`handoff.ts`](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts)，可以完整看到创建 Service 与 Runtime、开始观察、依次运行角色、检查 Service 操作和执行完成、调用 `finalizeRun` 核对导出文件的全过程。

## 4. 核对结果

一次成功运行应同时满足：

| 报告字段 | 预期值 | 证明了什么 |
| --- | --- | --- |
| `business.status` | `completed` | 观察到了预期 Messages 操作和 Agent 执行结束 |
| `artifactVerification.status` | `passed` | reader 导出的文件与宿主最初提供的值一致 |
| `coreClose.status` | `complete` | Core 已确认其资源清理完成 |
| `reportSaveFailure` | `null` | 收尾报告已保存 |

任一必需条件失败，示例都会以非零状态退出。排查失败运行时，应保留尚不确定的 send request ID 和待清理资源标识。Run 归档中还包含私有提示词、Service 调用和原生会话。

## 5. 在自己的项目中使用同一 SDK

当前 `@murm/core` 通过 checkout 或 tarball 安装。在 checkout 根目录打包：

```bash
npm pack --pack-destination /tmp
```

在 checkout 外的新目录安装它，并复制示例源文件：

```bash
mkdir my-harness
cd my-harness
npm init -y
npm pkg set type=module
npm install --save-exact /tmp/murm-core-0.2.0.tgz
npm install -D typescript @types/node
cp node_modules/@murm/core/examples/bridge-services/{handoff.ts,handoff-config.ts,messages.ts,tsconfig.handoff.json} .
npx tsc --project tsconfig.handoff.json
node build/handoff.js
```

在这个 shell 中保留第 2 步的模型与基础设施环境变量。包安装提供 SDK 和示例源码，执行宿主仍需具备 Docker、OpenSandbox 和 Worker 镜像。这个 TypeScript 工作流不要求先运行 `murm init`。

## 下一步

先读 [使用 SDK](sdk.md)，了解公开接口与生命周期；再读 [构建你自己的 Harness](build-your-harness.md)，学习如何改变 Service 契约与协作规则。需要递归委派时，可以按照 [Subagents 指南](harnesses/subagents.md) 使用它自己的配置运行。其他机制见 [Harness 横向对比](harnesses/index.md)。
