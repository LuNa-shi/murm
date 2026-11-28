---
title: 搭建你的第一个 SDK Harness
description: 安装固定版本的 murm，运行双 Agent 交接，在终端回复问题，并验证文件与清理回执。
section: GET STARTED
order: 4
---

发布 Agent 从工作区读取发布编号，然后询问发布渠道。你在终端选择渠道，交付 Agent 通过 Service 领取编号并生成交付文件。先准备[快速上手中的 Linux 依赖](quickstart.md#前置要求)。Node.js 需为 22.19 或更高版本并带 npm。v0.2.0 路径需要本机 rootful Docker。模型端点需支持流式响应与工具调用。

## 1. 选择 SDK 归档

### 已发布的 v0.2.0

完成 [v0.2.0 宿主要求](latest.md#宿主机要求)，包括 Landlock ABI 5+、本机 rootful Docker 和文档中的免交互 sudo 设置。Ubuntu 24.04 默认内核缺少 ABI 5。

```bash
mkdir -p "$HOME/murm-first-harness" && cd "$HOME/murm-first-harness"
curl -fLO https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
curl -fLO https://github.com/LuNa-shi/murm/releases/download/v0.2.0/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
export MURM_LEGACY_020=1
export MURM_ADVERTISE_HOST="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
export MURM_WORKER_IMAGE=ghcr.io/luna-shi/murm-worker:0.2.0
export MURM_SDK_ARCHIVE="$PWD/luna-shi-murm-0.2.0.tgz"
```

setup 和示例使用同一个 Docker context。该归档使用显式的本机严格 Sandbox 配置。它早于 `murm --version`，使用 npm 查询版本。

### 使用与本文配套的候选包

从候选包提供方获取固定 tarball 和校验和。将 `MURM_SDK_ARCHIVE` 设为 tarball 的绝对路径，核对校验和，在一个空目录里执行后续步骤。保留 `MURM_LEGACY_020` 为未设置状态。开发中的候选包可能沿用上个包版本，请同时记录归档的 SHA-256。若手上是源码，参考[源码安装路径](quickstart.md)自行打包。

## 2. 安装并连接

全局 CLI 和项目依赖使用同一个归档。

```bash
npm install -g --prefix "$HOME/.local" --ignore-scripts "$MURM_SDK_ARCHIVE"
export PATH="$HOME/.local/bin:$PATH"
command -v murm
if [ "${MURM_LEGACY_020:-}" = 1 ]; then
  npm ls --global --prefix "$HOME/.local" @luna-shi/murm --depth=0
else
  murm --version
fi
set -o pipefail
murm setup | tee setup.json
```

等待 `"infrastructure": "ready"` 和 `"ok": true`。运行 Harness 时使用同一环境。候选版 `setup.json` 的 `connection` 给出 Lifecycle、回调地址和 Worker 标签。示例在同一环境调用 `resolveSandboxConnection()`，读取本机私有密钥或已有服务的环境凭据。使用自定义 Worker 时，在两个命令中都保留 `MURM_WORKER_IMAGE`。使用自定义本地端口时，设置 `MURM_LIFECYCLE_URL` 并执行 `murm setup --mode local`。

宿主连到 Lifecycle 并启动真实 Worker。Worker 经通告地址连接 Bridge 和 Model Gateway。**宿主**访问你后面设置的实际模型上游。setup 的冒烟检查使用受控上游，通过时会报告基础设施检查和临时 Sandbox 删除结果。

### 从错误的 Lifecycle 地址恢复

候选版可执行以下只读预检，再用原环境重试。第一行的赋值只对当前命令生效。

```bash
MURM_LIFECYCLE_URL=http://127.0.0.1:1/v1 murm doctor
murm doctor
```

第一次应在 `provider.health` 报错并指出配置入口。第二次应通过。用 `murm doctor --smoke` 重跑 Worker 和回调检查。镜像和 Docker 故障见[快速上手](quickstart.md)。

## 3. 搭建项目

将这五个文件保存到项目目录。应用只从 SDK 包根入口导入。

- [main.ts](../../examples/first-harness/main.ts) 运行两个回合、显示问题、校验文件并报告清理。
- [handoff.ts](../../examples/first-harness/handoff.ts) 注册 `publish`、`take`。一次 `take` 返回发布编号和问题。交付 Agent 可直接执行 `swarm service invoke handoff take --request-id take-release`。
- [turn.ts](../../examples/first-harness/turn.ts) 提供可复用的第 1 版回合 helper。
- [config.ts](../../examples/first-harness/config.ts) 为已安装的归档选择 Sandbox 和模型配置。
- [tsconfig.json](../../examples/first-harness/tsconfig.json) 配置编译。

```bash
npm init -y
npm pkg set type=module
npm install --ignore-scripts "$MURM_SDK_ARCHIVE"
npm install --save-dev typescript @types/node
./node_modules/.bin/tsc
```

设置模型端点、模型 ID 和凭据。上游无需凭据时可省略 token。候选包的 Pi Worker 可设 `MURM_MODEL_PROTOCOL=chat-completions` 使用流式 `/v1/chat/completions`。v0.2.0 需要流式 `/v1/responses`。

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_ID='gpt-5-mini'
read -rsp 'Model API token: ' MURM_MODEL_TOKEN && export MURM_MODEL_TOKEN && printf '\n'
node dist/main.js
```

等发布 Agent 提问后，再输入渠道名，例如 `beta-east`。成功需要校验过的 `delivery.txt`、SHA-256、`business.ok: true` 和 `cleanup.status: "complete"`。交接回执给出双方的 Agent ID 和 Service 请求 ID。按摘要的文件路径计算 `sha256sum`，并核查 `channel=` 行确实使用了你的终端输入。每次运行随机生成新发布编号。

## 4. 排错与扩展

- 在 Agent 内运行 `swarm service invoke handoff publish --help`，查看授权操作的 Schema。候选版还会显示必填字段，并在可以推导合法示例时生成调用命令。先输入数字编号，再改成 12 字符编号。收到 `SERVICE_INPUT_INVALID` 和 `request_outcome: not_executed` 时，适配器尚未执行。结果未知时，用相同请求 ID 和参数查询或重试。修正参数后用新的请求 ID。参见 [Service](services.md)。
- 在可写工作区内写文件。临时文件可放工作区的临时子目录，收集前删除。镜像可能限制 `/tmp`。大输入先提供短摘要、选定文件或行范围。已知上游实际上下文限制时，设置 `MURM_CONTEXT_WINDOW`。运行摘要给出上游报告的输入、输出 token 数和配置的限制，缺失时显示 `unknown`。上下文问题可用模型请求 ID 和状态定位对应结果记录。
- 运行 `murm trace --root ./runs` 并选中 Runtime ID。在失败摘要取角色、阶段、错误码、Agent 和请求 ID，用 ID 查该运行目录的 `evidence.jsonl` 和 `service-calls.jsonl`。回合结束后仍需检查业务产物。遇到 pending 或 unknown 清理状态时，先查看关闭回执，再处置运行目录。
- 每个 Runtime 建一个回合 runner，应用负责向该空闲 Agent 发送输入。不同 Agent 可以并行。helper 先订阅再发送，要求受理且回合成功，在结束、出错、取消或超时后释放订阅。受理或执行状态不明时，通过 `runtime.get` 检查，关闭 Runtime 或明确核对原请求后再复用 Agent。取消等待不会取消 Worker 执行。参见 [Runtime](runtime.md) 的 `interrupt` 和 `close`。

可继续阅读[基于源码的并行 Swarm 教程](build-your-harness.md)，加入并行研究和汇总。
