---
title: Host Gateway 宿主机网关
description: 理解沙箱与宿主机之间的信任边界：Service Bridge 如何核验身份与 Schema，Model Gateway 如何把 API 密钥严格留在宿主机。
section: 核心构件与实战
order: 6
---

每个 Agent 都运行在隔离容器里，不持有上游模型密钥或宿主机 Service 的内部凭据。**Host Gateway**（宿主机网关）是沙箱与模型、共享服务交互的统一可信入口，由 **Service Bridge** 与 **Model Gateway** 两部分组成（如上图所示）。

## 1. Service Bridge：给跨沙箱调用验明正身

当容器里的 Agent 通过 `swarm <service> <operation>` 调用共享服务时，请求会先经过宿主机的 **Service Bridge**，完成四道把关后再转发给你的 Service 并把结果返回给沙箱：

1. **绑定真实调用者身份**：每个 Agent 启动时都会分配独立的临时 Bearer Token，Bridge 据此解析出真实的 `caller.agentId`、`caller.profile` 和可选的 `caller.binding`——Agent 绝无法在参数里伪造队友身份。
2. **校验角色权限白名单**：检查该 Agent 当前是否获准调用这个操作（结合 `Profile.services` 与运行期动态授权）。
3. **严格 JSON Schema 校验**：用 Ajv（draft-07，不做隐式类型转换）双向校验入参与返回值，格式不对的调用在触碰业务状态前即被拦截。
4. **全程自动记账**：每次调用的入参、耗时、返回值与错误自动写入 `service-calls.jsonl`，并在 [Trace Viewer](trace-viewer.md) 中还原成跨 Agent 协作交接记录。

## 2. Model Gateway：让模型密钥永不进入容器

Agent 发起推理时，容器内的执行器只向宿主机本地的 **Model Gateway** 发送请求，并携带该 Agent 专属的可即时吊销令牌：

- **上游密钥留在宿主机**：你的 OpenAI / Anthropic / 自定义兼容端点 API Key 只配置在宿主机 `createRuntime({ models })` 中，容器内环境变量完全看不到真实密钥。
- **支持随时断流**：一旦 Agent 被 `stop()`、意外退出或发生致命错误，宿主机立刻吊销该 Agent 的令牌并中止在途请求。
- **可选租约门控（`modelAccessPolicy`）**：高级场景（如 [TaskPool](harnesses/taskpool.md)）可以在每次模型请求前执行同步检查，一旦任务租约过期立刻中止推理，防止过期成员继续消耗算力。
- **原始请求自动归档**：经网关转发的 Responses 或 Chat Completions 请求与流式响应（以及自定义可信 `ModelTransport`）都会写入 `model-trace/`，方便事后审计 token 消耗和排查模型决策依据。
- **远程与反向代理回调**：若使用远程 OpenSandbox 且 Worker 需经域名或 HTTPS 反向代理回连宿主机，可通过 `connection.bridge.publicUrl` 与 `connection.modelGateway.publicUrl` 声明含 `{port}` 的地址模板。

## 3. 精细控制容器出站网络（严格本地策略）

启用严格本地隔离策略（`isolation.network: 'local-docker'`）时，宿主机防火墙默认仅放行 Service Bridge 与 Model Gateway。如果你的场景需要 Agent 在容器内直接使用原生工具访问本地 Git 服务器（例如 [PeerMesh](harnesses/peermesh.md) 中的本地 Gitea），可以在该角色的 Profile 中显式配置两项：

- `network: { allow: ['172.17.0.1:3000'] }`：由宿主防火墙仅为该容器放行指定非 loopback IPv4 地址。
- `spawn({ secretEnv: { GITEA_TOKEN: '...' } })`：只把该成员专属的最小权限凭证注入容器，管理员密钥仍严格留在宿主机 Service 中。

---

**下一步**：学习如何设计并接入你自己的共享协作服务——**[Services 与权限](services.md)**。
