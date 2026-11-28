---
title: Sandbox 隔离沙箱
description: 了解 murm 如何通过 OpenSandbox 或自定义 Sandbox Provider 隔离每个 Agent，以及如何配置 createSandbox() 与可选严格本地策略。
section: 核心构件与实战
order: 3
---

每个 Agent 在 OpenSandbox 环境中拥有独立的 `/workspace/project`。root Worker 监督 Pi、Codex 或镜像内安装的执行器，验证文件传输，并在确认停止后导出会话与成果。

## 本地运行

```sh
murm setup --mode local
murm doctor --smoke
```

setup 准备固定的 OpenSandbox 1.2.1 组件与兼容 Worker 镜像，随后保存连接。默认优先使用已发布镜像。开发时可设置 `MURM_BUILD_WORKER=1` 从源码构建。Worker 握手版本为 `murm-core-v2`，旧镜像会收到明确的版本不匹配错误。

## 连接已有服务

```sh
export OPEN_SANDBOX_API_KEY='<管理员提供的密钥>'
murm setup --mode existing --endpoint https://sandbox.example.net \
  --public-url https://runtime.example.net/murm
murm doctor --smoke
```

existing 模式验证管理鉴权后保存连接。显式 smoke 创建并清理一个临时资源，检查控制端访问 Worker、Sandbox 回连、文件导出和删除。远端管理员准备 Worker 镜像，Controller 需要 Node 与网络访问。跨不可信网络传输凭据时使用 TLS。

## SDK 配置

```ts
import { createSandbox } from '@luna-shi/murm';

const sandbox = createSandbox(); // 使用 setup 保存的连接
const remote = createSandbox({
  endpoint: 'https://sandbox.example.net',
  apiKey: process.env.OPEN_SANDBOX_API_KEY,
  resourceLimits: { cpu: '2', memory: '2Gi' },
  timeoutSeconds: 3600,
});
```

优先级为显式 SDK/CLI 配置、进程环境、保存的连接、本地默认值。连接保存在仅当前用户可读写的配置中。工厂捕获配置，`runtime.spawn()` 才分配资源。

Runtime 使用 `connection: { publicUrl: 'https://runtime.example.net/murm' }` 声明一个 Sandbox 可达的回调地址。高级监听参数为 `bindHost` 与 `bindPort`。反向代理路径前缀会保留。doctor 报告会显示所配置的回调源地址。如果 Sandbox 无法回连 Runtime，smoke 检查会提示核对回调地址、监听端口和代理路由。OpenSandbox 应发布控制端可达的 endpoint 及所需 headers。

## 资源与旧配置迁移

| 配置或能力 | 当前处理 |
| --- | --- |
| CPU、memory | 经官方 SDK 设置，并检查实际 guest cgroup。 |
| `timeoutSeconds` | 初始生命周期默认 3600 秒。活跃 Runtime 自动续租运行、idle 与保留资源。 |
| 必需导出失败 | 保留 Sandbox 与 Slot，报告实际 `expiresAt`。关闭前尝试确认至少五分钟窗口，未确认则报告 `retain-at-risk`。再次 stop 可重试导出与清理。 |
| `lifecycleBaseUrl` | `endpoint` 的迁移别名，冲突即拒绝。计划在下一次 breaking release 移除。 |
| `isolation.network: 'api'` | 过渡期冗余选择，计划在下一次 breaking release 移除。 |
| `local-docker`、精确 Workspace bytes/inodes | 分配前拒绝并给迁移说明。可选择具有所需已验证存储合同的受信 Provider。 |
| 文件 `maxBytes` / `maxEntries` | 由 `filePolicy` 独立配置的传输与内存预算。 |
| live shared workspace | 内置 Provider 在创建前拒绝。使用文件或 Service 显式交接，或实现已验证共享权限的自定义 Provider。 |
| `endpointHost` | 拒绝。请在 OpenSandbox 修正 endpoint 发布配置。 |
| `useServerProxy` | 为已有部署保留的显式兼容，沿用上游维护状态。新部署应发布可达 endpoint。 |
| 两个回调 URL 与 `{port}` 模板 | 迁移到一个 `connection.publicUrl`，需要时设置固定 `bindPort`。相同旧 URL 暂时兼容，计划下一次 breaking release 移除。 |

可选 `egressMode: 'dns+nft'` 声明管理员已准备包级网络策略。Profile 的 IPv4 HTTP(S) origins 编译为精确 IP/TCP 端口规则，并加入 Runtime 回调目标。部署未声明能力时拒绝分配。Agent 启动前，Runtime 检查 sidecar 实际报告的 dns+nft 模式与请求的允许列表。实际包级拒绝需要部署测试，平台 deny 仍可能阻止业务目标。

## Worker 镜像

`workerImageFor(executor)` 返回对应执行器镜像，`DEFAULT_WORKER_IMAGE` 选择组合镜像。需要额外工具链时扩展镜像并设置 `Profile.image`。包版本、Worker 协议与执行器版本必须兼容。

自定义集成使用 `createSandbox({ provider, timeoutSeconds })`，遵循公开 `SandboxProvider` 合同。管理员配方与版本 pin 见部署指南。

[Runtime](runtime.md) · [宿主网关](gateway.md) · [部署](../../deploy/README.md)

## Kubernetes 部署

一个 Runtime 使用一个 OpenSandbox 集群入口和固定回调地址，由 Kubernetes 调度 Sandbox Pod。持久化归属支持独占 writer 下的同主机、同 boot 恢复；当前没有跨节点自动接管。在两台 worker VM 上已运行 2 和 8 档的真实 Sandbox 工作负载。32、128 和 1,024 档通过本机 mock Agent API 的 Sandbox 生命周期检查。参见 [Runtime](runtime.md) · [Deployment](../../deploy/opensandbox-kubernetes/README.md)
