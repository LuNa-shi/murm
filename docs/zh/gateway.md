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
3. **先校入参、后校输出（JSON Schema）**：用 Ajv（draft-07，不做隐式类型转换）在调用前严格校验入参——格式不合法的请求在触碰业务状态前即被拦截；Adapter 执行返回后再校验 `output_schema`（注意：若写操作在返回阶段触发 `SERVICE_OUTPUT_INVALID`，业务副作用可能已生效，重试前应先核查 Service 状态）。
4. **全程自动记账**：每次调用的入参、耗时、返回值与错误自动写入 `service-calls.jsonl`，并在 [Trace Viewer](trace-viewer.md) 中还原成跨 Agent 协作交接记录。

## 2. Model Gateway：让模型密钥永不进入容器

Agent 发起推理时，容器内的执行器只向宿主机本地的 **Model Gateway** 发送请求，并携带该 Agent 专属的可即时吊销令牌：

- **上游密钥留在宿主机**：你的 OpenAI / Anthropic / 自定义兼容端点 API Key 只配置在宿主机 `createRuntime({ models })` 中，容器内环境变量完全看不到真实密钥。
- **支持随时断流**：一旦 Agent 被 `stop()`、意外退出或发生致命错误，宿主机立刻吊销该 Agent 的令牌并中止在途请求。
- **可选租约门控（`modelAccessPolicy`）**：高级场景（如 [TaskPool](harnesses/taskpool.md)）可以在每次模型请求前执行同步检查，一旦任务租约过期立刻中止推理，防止过期成员继续消耗算力。
- **原始请求自动归档**：经网关转发的 Responses 或 Chat Completions 请求与流式响应（以及自定义可信 `ModelTransport`）都会写入 `model-trace/`，方便事后审计 token 消耗和排查模型决策依据。
- **一个回调地址**。`connection.publicUrl` 指定 Sandbox 可达的 HTTP(S) 地址，可以包含反向代理路径前缀。Runtime 在同一 listener 路由 `/bridge` 和 `/model/<alias hash>`。Bridge 与模型 token、权限和预算分别校验，模型响应继续流式转发。

## 3. 网络策略

管理员可准备 OpenSandbox `dns+nft` egress，并在连接中声明 `egressMode: 'dns+nft'`。Profile 随后可请求精确的非回环 IPv4 HTTP(S) origins。Runtime 创建 Sandbox 前将共同回调加入许可目标。

```ts
network: { allow: ['http://172.17.0.1:3000'] }
```

同 IP 的其他 TCP 端口仍在规则范围外。域名与端口组合的限制在分配前拒绝。DNS-only 部署无法满足该能力。管理接口鉴权与未授权网络目标分别验证。成员级应用凭据可经 `runtime.spawn({ secretEnv })` 传入。

---

**下一步**：学习如何设计并接入你自己的共享协作服务——**[Services 与权限](services.md)**。
