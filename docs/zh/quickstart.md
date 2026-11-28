---
title: 快速上手
description: 在 Linux 上安装 murm，验证 OpenSandbox，并运行第一个 Subagents 示例。
section: GET STARTED
order: 1
---

murm 的 CLI 和 SDK 由同一个包提供。Agent 在 OpenSandbox 中运行。你可以用本机 Docker Engine 启动 OpenSandbox，也可以接入团队已有的服务。

## 1. 安装 murm

在 Linux 上准备 [Node.js 22.19 或更新版本及 npm](https://nodejs.org/en/download) 和 Git。安装前先运行 `node --version`。Ubuntu 24.04、Debian 13 等发行版的软件源默认提供的 Node.js 版本偏旧，可以从 Node.js 下载页安装当前的 LTS 版本。

如果要在本机启动 OpenSandbox，还需要 [Docker Engine](https://docs.docker.com/engine/install/)。Ubuntu 或 Debian 用户可以一并安装发行版提供的 Docker、Git 和 curl：

```bash
sudo apt-get update
sudo apt-get install -y docker.io git curl ca-certificates
sudo systemctl enable --now docker.service
```

使用本机 OpenSandbox 时，用实际运行 murm 的用户执行 `docker info`。如果系统 Docker socket 拒绝访问，请让管理员授权。用户组变更后需要重新登录。[`docker` 用户组具有等同于 root 的权限](https://docs.docker.com/engine/install/linux-postinstall/)。如果本机已装 Docker，或要接入已有的 OpenSandbox 服务，Ubuntu 和 Debian 用户可以运行 `sudo apt-get update && sudo apt-get install -y git curl ca-certificates` 补齐客户端工具。

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

安装器优先使用可写的 npm 全局目录，否则安装到 `$HOME/.local`。如果安装器打印了 `PATH` 命令，请在当前 shell 执行后再运行 `murm`。也可以直接用 npm 安装到自己的目录：

```bash
npm install -g --prefix "$HOME/.local" --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
export PATH="$HOME/.local/bin:$PATH"
```

公开安装器下载最新的 GitHub Release。**v0.2.0** 另外要求本机 rootful Docker、Landlock ABI 5+、宿主工具和非交互式 sudo 规则。使用该发行版时，请在第 2 步前按 [v0.2.0 宿主配置指南](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/zh/quickstart.md) 准备环境。Ubuntu 24.04 默认的 6.8 内核实测未达到该版本的 Landlock 要求。当前源码默认使用 OpenSandbox API 模式，按上面的依赖准备即可。

<details>
<summary>从 murm 源码安装尚未发布的候选版</summary>

在源码仓库根目录运行：

```bash
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --prefix "$HOME/.local" --ignore-scripts "$pack_dir"/*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

</details>

如果要在[独立示例项目](../../examples/README.md)中使用同一份 SDK，请保留生成的候选版 tarball。

## 2. 验证 OpenSandbox

```bash
murm setup
```

按当前源码默认配置，这个命令会在 `127.0.0.1:8080` 启动托管 OpenSandbox，准备所选 Worker，创建一个真实的临时沙箱，验证 Bridge、模型网关、文件导出和沙箱删除。等到报告出现 `"infrastructure": "ready"` 和 `"ok": true` 再继续。这个探针使用本地测试响应，无需模型 API key。在新机器上，setup 会获取固定版本的 OpenSandbox 镜像，并在本机直接构建所选 Worker。这可能需要几分钟。如果失败，处理报告里的问题后重试同一个命令。

<details>
<summary>接入已有的 OpenSandbox 服务</summary>

请使用当前源码构建的 CLI，或支持 `murm setup --mode existing` 的发行版。在 shell 中通过 `MURM_LIFECYCLE_TOKEN` 提供服务管理员给你的 Lifecycle API key。控制端需要能访问 Lifecycle 和 Worker 端点，Worker 也要能访问控制端的 Bridge 和模型网关。如果服务端无法拉取兼容的 Worker 镜像，请让管理员在该服务使用的引擎上准备镜像。

```bash
export MURM_LIFECYCLE_URL='https://sandbox.example.net/v1'
export MURM_ADVERTISE_HOST='controller.internal.example.net'
murm setup --mode existing
```

代理路由和 HTTPS 回调见 [Sandbox 隔离沙箱](sandbox.md) 和 [宿主网关](gateway.md)。

</details>

<details>
<summary>镜像拉取失败怎么办</summary>

- **OpenSandbox server 或 Execd。** 当前源码的本机 setup 会报告失败的镜像及完整 digest。在同一个 Docker context 中重试报告给出的 `docker pull`。网络受限时，可以配置 [Docker daemon 代理](https://docs.docker.com/engine/daemon/proxy/)，或请管理员提供相同的固定镜像引用。也可以接入已有的 OpenSandbox 服务。murm Worker 的 Dockerfile 只构建 Worker。
- **murm Worker。** 本机 setup 先复用兼容缓存，缺失时直接从安装包自带的 `deploy/worker/Dockerfile` 构建所选执行器。构建需要 Node 基础镜像、Debian 软件包和 npm 依赖。检查这些来源后重试 setup，或运行报告里的构建命令排查错误。显式配置的 registry 镜像在缓存缺失时仍可拉取。
- **从另一台机器导入 Worker。** 在网络可用的机器上拉取或构建兼容且与目标 Docker Engine CPU 架构一致的 Worker，用 `docker save -o worker.tar IMAGE` 导出。将文件传到目标机器，在目标 Docker context 中执行 `docker load -i worker.tar`。如果导入的标签和默认标签不同，先设置 `MURM_WORKER_IMAGE=IMAGE`，并在运行示例时保留该环境变量。接入已有服务时，Worker 镜像需在服务端的引擎上可用。

如果可信镜像站提供同一个 Node 基础镜像，可以在安装候选版后用它构建默认的 Pi Worker。将示例中的 registry 换成你的镜像站：

```bash
(
  cd "$(dirname "$(readlink -f "$(command -v murm)")")/../.." &&
    docker build -f deploy/worker/Dockerfile -t murm-worker:local \
      --build-arg WORKER_EXECUTOR=pi \
      --build-arg NODE_IMAGE=registry.example.net/library/node:22.19.0-bookworm-slim .
) &&
  export MURM_WORKER_IMAGE=murm-worker:local &&
  murm setup
```

</details>

以后可用 `murm doctor` 快速检查 Lifecycle；要重跑完整基础设施探针，用 `murm doctor --smoke`。

## 3. 运行第一个示例

下面用 OpenAI Responses 跑一个读取文件的任务。请在 shell 中把有权访问所选模型的 API key 设置为 `MURM_MODEL_TOKEN`，再执行：

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_ID='gpt-5-mini'

mkdir -p murm-first-example
cd murm-first-example
printf '# Hello from murm\n' > README.md
murm --harness subagents --prompt 'Read README.md and report its heading.' --output-dir ./runs
```

在终端查看结果，再用 Trace Viewer 打开这次运行：

```bash
murm trace --root ./runs --port 8787 --open
```

通过 SSH 运行时，Trace Viewer 会打印一条在你电脑上运行的端口转发命令。如果你使用 SSH 别名、映射端口或跳板机连接，请在转发命令中沿用相同的连接配置。

如果使用其他模型提供方，请把 `MURM_MODEL_URL` 换成其流式 Responses URL，并选择你的 key 有权访问的模型。执行器和其他配置见 [CLI 参考](reference/cli.md)。

## 下一步

- [选择 Harness](harnesses/index.md)，体验不同的协作方式。
- 用 [TypeScript SDK](reference/api.md) [构建自己的 Swarm Harness](build-your-harness.md)。
