---
title: Sandbox 隔离沙箱
description: 了解 murm 如何通过 OpenSandbox 或自定义 Sandbox Provider 隔离每个 Agent，以及如何配置 createSandbox() 与可选严格本地策略。
section: 核心构件与实战
order: 3
---

在多智能体系统里，每个 Agent 都需要运行代码、修改文件、执行 Shell 命令。**Sandbox**（隔离沙箱）确保每个 Agent 都在自己的隔离容器与私有工作区里运行，既不会误改宿主机文件，也不会在未经授权的情况下互相覆盖工作区。

`murm` 默认依托开源容器沙箱运行时 **OpenSandbox** 来创建和回收容器（运行 `murm setup --mode local` 即可在本机一键部署，也可连接已有远程 OpenSandbox 服务），同时支持通过 `SandboxProvider` 接入自建沙箱后端。

## 每个沙箱里有什么？

调用 `runtime.spawn()` 时，`murm` 会通过 **OpenSandbox API** 或自定义 **Sandbox Provider** 为该 Agent 分配独立容器：

- **独立私有工作区**：每个 Agent 拥有自己的 `/workspace/project` 目录，按配置的 CPU、内存上限与生命周期超时运行。
- **Worker 监督进程**：容器内由轻量监督进程托管选定的执行器（Pi、Codex 或镜像内安装的外部执行器），负责准备启动提示词、在文件快照/替换前暂停写入，以及在关闭前流式导出会话和产物。
- **默认 OpenSandbox API 策略**：通过 OpenSandbox 鉴权 API 管理容器并校验 CPU/内存上限，兼顾本机一键部署与远程服务接入。

## 用 `createSandbox()` 配置沙箱

```ts
import { createSandbox } from '@luna-shi/murm';

// 创建不可变、可复用的沙箱配置（默认使用 OpenSandbox API 策略）
const sandbox = createSandbox({
  // OpenSandbox Lifecycle API 地址（`murm setup --mode local` 默认监听本机 8080 端口）
  lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',

  // 连接开启鉴权的 OpenSandbox 服务时传入（`murm setup --mode local` 也会自动生成本机密钥）
  apiKey: process.env.MURM_LIFECYCLE_TOKEN,

  // 可选：单容器 CPU、内存上限与最大存活时间（默认 3600 秒）
  resourceLimits: { cpu: '2', memory: '2Gi' },
  timeoutSeconds: 3600,
});
```

### 常见进阶用法

- **复用 CLI 的默认连接解析**：在可信宿主脚本中可直接调用 `resolveSandboxConnection()`，按与 `murm` CLI 相同的优先级读取 `MURM_LIFECYCLE_URL`、本机自动生成的 `MURM_LIFECYCLE_TOKEN` 与默认镜像。
- **连接远程或代理后的 OpenSandbox**：可在 `createSandbox()` 中设置 `endpointHost`（覆盖返回的 Worker 主机地址）或 `useServerProxy: true`（走 OpenSandbox 服务端代理，二者选其一）。
- **接入自定义 Sandbox Provider**：如果你有自建沙箱平台，可直接传 `createSandbox({ provider, timeoutSeconds })` 替换默认 OpenSandbox 后端，无需修改 Runtime 或 Harness 逻辑。
- **可选严格本机隔离**：若需要**计量工作区 `tmpfs` 配额、实时共享挂载或本机 UID 网络白名单**，可显式传入 `isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } }`（需同机 rootful Docker 与 Landlock ABI 5+）。

### Worker 镜像

- **`workerImageFor(executor)`**：获取与所选执行器匹配的精简单执行器镜像。
- **`DEFAULT_WORKER_IMAGE`**：内置 Pi 与 Codex 的通用双执行器镜像。
- 如果某个角色需要额外工具链（例如 Lean 或特定编译器），可基于官方镜像构建自定义 Dockerfile 并在对应 [Agent Profile](agents.md) 中单独指定 `image`。

---

**下一步**：把沙箱句柄交给 **[Runtime 运行控制面](runtime.md)**，学会如何配置模型、监控事件、同步文件与安全收尾。
