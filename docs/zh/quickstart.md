---
title: 快速上手
description: 在 Linux 上准备环境、安装 murm、初始化 OpenSandbox 与 Worker，并运行第一个多智能体示例。
section: GET STARTED
order: 1
---

要使用已安装的 SDK 归档编写自己的应用，请从[搭建第一个 SDK Harness](first-harness.md)开始。

`murm` 将 CLI 与 TypeScript SDK 打包在同一个安装包中，并在 [OpenSandbox](sandbox.md) 隔离沙箱中运行 Agent。你可以在 Linux 本机通过 Docker 一键启动 OpenSandbox，也可以接入团队已有的服务。

## 前置要求

| 依赖 | 要求与说明 | 检查命令 |
| --- | --- | --- |
| **Linux** | 控制器宿主机（如 Ubuntu / Debian） | `uname -s` |
| **Node.js 与 npm** | `>= 22.19`（Ubuntu 24.04、Debian 13 等软件源默认版本偏旧，请从 [nodejs.org](https://nodejs.org/en/download) 安装 LTS） | `node --version` |
| **Git 与 curl** | 安装脚本与工作区操作必需 | `git --version` |
| **Docker Engine** | 仅本机启动 OpenSandbox 时需要；接入已有服务可跳过（[安装指南](https://docs.docker.com/engine/install/)） | `docker info` |

Ubuntu / Debian 一键安装系统依赖（如已有 Docker 或接入远程服务，去掉 `docker.io` 与 `systemctl` 即可）：

```bash
sudo apt-get update && sudo apt-get install -y docker.io git curl ca-certificates
sudo systemctl enable --now docker.service
```

> **Docker 权限**：请使用实际运行 `murm` 的账号执行 `docker info`。若提示无权访问 socket，请让管理员授权并在用户组变更后重新登录（[`docker` 用户组具有等同于 root 的权限](https://docs.docker.com/engine/install/linux-postinstall/)）。

## 1. 安装 murm

### 方式 A：一键安装最新发行版

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

安装器优先写入可写的 npm 全局目录，否则安装到 `$HOME/.local`。如果终端打印了 `export PATH=...`，请先在当前 shell 执行后再调用 `murm`。

> **版本提示**：公开安装器下载最新的 GitHub Release。当前 **v0.2.0** 发行版仍依赖旧版宿主机配置（本机 rootful Docker、Landlock ABI 5+ 与非交互式 sudo 规则，Ubuntu 24.04 默认 6.8 内核不满足），使用该发行版请在第 2 步前先完成 [v0.2.0 宿主配置指南](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/zh/quickstart.md)。若希望仅凭上面的前置要求直接使用默认 OpenSandbox API 模式，请改用下方「方式 B」从源码安装。

<details>
<summary>使用 npm 直接安装发行版（不经过 install.sh）</summary>

```bash
npm install -g --prefix "$HOME/.local" --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
export PATH="$HOME/.local/bin:$PATH"
```

</details>

### 方式 B：从源码构建并安装（`main` 最新版）

在仓库根目录执行以下命令。流程分为三步：`npm ci` 安装依赖、`npm pack` 自动编译并打成发布压缩包、`npm install -g` 将 `murm` CLI 安装到 `$HOME/.local/bin`：

```bash
git clone https://github.com/LuNa-shi/murm.git && cd murm
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --prefix "$HOME/.local" --ignore-scripts "$pack_dir"/*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

如果要在[独立示例项目](../../examples/README.md)中使用同一份 SDK，请保留生成的候选版 tarball。

## 2. 准备 OpenSandbox 与 Worker

```bash
murm setup
```

已有保存或显式连接时，setup 验证并复用该连接；否则在 `127.0.0.1:8080` 准备本地服务。本地 setup 拉取固定的 Server、Execd、Egress 1.2.1 镜像，准备兼容 Worker，并用受控模型响应完成 Service、模型、文件、导出与删除的有界自检。本地探测成功后会显示 `"ok": true` 和 `"infrastructure": "ready"`。

默认优先使用已发布 Worker。开发候选的 Worker 协议变化时，运行 `MURM_BUILD_WORKER=1 murm setup --mode local`，从安装包配方构建。本树使用 `murm-core-v2`，旧镜像会收到版本不匹配诊断。本地构建需要访问 Node 基础镜像、Debian 源与 npm。显式 `MURM_WORKER_IMAGE` 必须是兼容镜像。

### 连接已有 OpenSandbox

```bash
export OPEN_SANDBOX_API_KEY='<管理员提供的密钥>'
murm setup --mode existing --endpoint https://sandbox.example.net \
  --public-url https://runtime.example.net/murm
murm doctor --smoke
```

existing setup 验证鉴权，将 endpoint、密钥和回调地址保存在仅当前用户可读写的配置中。远端 Controller 需要 Node 与网络访问，服务管理员准备匹配的 Worker 镜像。`doctor` 只读检查配置与 Lifecycle；`doctor --smoke` 创建临时 Sandbox，验证控制端访问 Worker 和 Sandbox 回连 Runtime，最后确认导出与删除。已保存远端连接不可达时，会报告该连接的具体错误。

`connection.publicUrl` 是 Bridge 与模型请求共用的一个回调地址。反向代理应将此前缀转发至 Runtime 的 `bindHost` 与固定 `bindPort`。本地 setup 自动发现可达宿主地址与可用端口。详细说明与旧配置迁移见 [Sandbox](sandbox.md) 和 [宿主网关](gateway.md)。

### 诊断镜像可用性

setup 报告失败镜像引用与重试命令。检查所选 Docker 引擎的 registry 网络，或由管理员预置固定镜像。离线时通过 `docker save` 与 `docker load` 转移镜像，再将 `MURM_WORKER_IMAGE` 设为兼容引用。开发时可使用安装包 Dockerfile。

```bash
docker build -f deploy/worker/Dockerfile -t murm-worker:local .
export MURM_WORKER_IMAGE=murm-worker:local
murm setup --mode local
```

## 3. 运行第一个示例

配置任意兼容 OpenAI Responses 流式协议的模型端点与 API Key（下面以 OpenAI 为例），在新建目录中运行一次内置 `subagents`：

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_ID='gpt-5-mini'
export MURM_MODEL_TOKEN='<your-api-key>'

mkdir -p murm-first-example && cd murm-first-example
printf '# Hello from murm\n' > README.md
murm --harness subagents --prompt 'Read README.md and report its heading.' --output-dir ./runs
```

如需切换其他模型服务商或执行器（如 Codex），请查看 [CLI 参考](reference/cli.md)。

## 4. 在 Trace Viewer 中回放

```bash
murm trace --root ./runs --port 8787 --open
```

通过 SSH 连接远程机器运行时，`murm trace` 会自动打印一条可直接在本机执行的端口转发命令（如使用了 SSH 别名、映射端口或跳板机，沿用相同连接参数即可）。

## 下一步

- [核心概念](concepts.md)：2 分钟看懂 6 个核心组件如何协同。
- [选择 Harness](harnesses/index.md)：对比 5 种内置多智能体协作模式。
- [构建自己的 Swarm Harness](build-your-harness.md)：结合 [TypeScript SDK](reference/api.md) 定制你自己的多智能体编排。
