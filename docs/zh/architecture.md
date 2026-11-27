---
title: 系统架构
description: 公开 SDK 边界、宿主控制面、OpenSandbox 执行、Service 与模型调用路径，以及 Run 的资源所有权。
section: 系统架构
order: 3
---

murm 应用在可信宿主上运行 Harness。Harness 为一次 Run 创建 Runtime，选择 OpenSandbox 后端，并注册 Agent 可以使用的 Services。每个 Agent 在 Sandbox 中执行；Service 与模型请求经过宿主网关，由网关验证身份并记录执行情况。

默认 Provider 让 Linux Controller 通过 API 连接本地或远端 OpenSandbox，Pi 和 Codex 共用经过鉴权的 Worker 传输。显式选择严格同机 Docker 策略时，会增加本地网络规则、工作区配额和共享挂载。其他 Provider 可从 SDK 根入口接入。

## 组件边界

<div class="doc-diagram" role="region" aria-label="murm trust boundaries between Trusted Host and Isolated Sandbox">
  <div class="dd-zone dd-host">
    <div class="dd-zone-head">
      <span class="dd-zone-title">TRUSTED HOST</span>
      <span class="dd-zone-sub">Node.js process · owns secrets, Services, and authoritative logs</span>
    </div>
    <div class="dd-row-3">
      <div class="dd-box dd-yellow">
        <div class="dd-box-title">Your Harness</div>
        <ul class="dd-list">
          <li>Control loop &amp; rules</li>
          <li>Role Profiles</li>
          <li>Custom Services</li>
        </ul>
      </div>
      <div class="dd-arrow-h" aria-hidden="true">──►</div>
      <div class="dd-box dd-indigo">
        <div class="dd-box-title">Core Runtime</div>
        <ul class="dd-list">
          <li>Agent registry &amp; slots</li>
          <li>Input &amp; file ledgers</li>
          <li>Lifecycle event stream</li>
        </ul>
      </div>
      <div class="dd-arrow-h" aria-hidden="true">──►</div>
      <div class="dd-box dd-amber">
        <div class="dd-box-title">outputDir/&lt;runtimeId&gt;/</div>
        <ul class="dd-list">
          <li>runtime.json</li>
          <li>evidence.jsonl</li>
          <li>service-calls.jsonl &amp; model-trace/</li>
        </ul>
      </div>
    </div>
    <div class="dd-inner-link">
      <div class="dd-pipe">
        <span class="dd-pipe-line" aria-hidden="true">▲</span>
        <span class="dd-pipe-meta"><span>validated Service dispatch</span></span>
      </div>
      <div class="dd-pipe">
        <span class="dd-pipe-line" aria-hidden="true">▲</span>
        <span class="dd-pipe-meta"><span>model traces &amp; lease gate</span></span>
      </div>
    </div>
    <div class="dd-row-2">
      <div class="dd-box dd-service">
        <div class="dd-box-title">Service Bridge (HTTP)</div>
        <ul class="dd-list">
          <li>Bearer auth → real agentId</li>
          <li>Profile.services ACL check</li>
          <li>Ajv draft-07 schema validation</li>
        </ul>
      </div>
      <div class="dd-box dd-indigo">
        <div class="dd-box-title">Model Gateway (/v1/responses)</div>
        <ul class="dd-list">
          <li>Per-agent revocable token</li>
          <li>Injects upstream API keys on host</li>
          <li>Optional modelAccessPolicy gate</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="dd-pipes">
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">▲<br/>│</span>
      <span class="dd-pipe-meta"><strong>MURM_BRIDGE_URL</strong><span>firewall-allowed IPv4</span></span>
    </div>
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">▲<br/>│</span>
      <span class="dd-pipe-meta"><strong>Gateway origin</strong><span>firewall-allowed IPv4</span></span>
    </div>
  </div>

  <div class="dd-zone dd-sandbox">
    <div class="dd-zone-head">
      <span class="dd-zone-title">ISOLATED SANDBOX</span>
      <span class="dd-zone-sub">Linux Sandbox per Agent · authenticated control plane</span>
    </div>
    <div class="dd-row-2-arrow">
      <div class="dd-box dd-teal">
        <div class="dd-box-title">Root Worker Supervisor</div>
        <ul class="dd-list">
          <li>Stages frozen profile prompt</li>
          <li>Pauses writers for snapshot / install</li>
          <li>Stops executor &amp; streams archives</li>
        </ul>
      </div>
      <div class="dd-arrow-h" aria-hidden="true">── manages ──►</div>
      <div class="dd-box">
        <div class="dd-box-title">Pi or Codex executor</div>
        <ul class="dd-list">
          <li>Local file and shell tools</li>
          <li>Runs swarm &lt;service&gt; &lt;operation&gt;</li>
          <li>Bounded /workspace/project quota</li>
        </ul>
      </div>
    </div>
  </div>
</div>


| 层次 | 负责内容 | 公开入口 |
| --- | --- | --- |
| Harness | 角色、协作规则、Service 状态、工作截止时间和业务验收 | 你的应用代码 |
| Core Runtime | Agent 身份与容量、输入回执、运行观察、文件操作和清理 | `@luna-shi/murm` |
| Service 接入 | Manifest 校验、adapter 与操作注册 | `@luna-shi/murm` |
| OpenSandbox 后端 | 执行器选择、Sandbox 配置与执行能力 | `@luna-shi/murm` |
| 外部设施 | 独立数据库、HTTP 服务、Git/聊天服务及其部署 | 应用或设施维护方 |

使用 `createSandbox` 捕获 OpenSandbox 配置。Runtime 决定使用 Pi 或 Codex，并拥有运行时的宿主连接与模型配置。

## Runtime 创建时建立宿主控制面

`createRuntime()` 首先校验参数，保存 Profiles 与 Service registry 的快照，并解析模型别名。它会加入内置 `agent` Service，提供 `spawn`、`get`、`send`、`stop`。Profile 必须明确获准调用相应操作，并指定可以创建的子 Profile。

随后 Runtime 创建私有 Run 目录、Model Gateways、Service Bridge 和后端资源。未知模型别名、Service 操作或不受支持的上下文分叉权限，会在创建 Agent Sandbox 之前被拒绝。初始化失败时，Core 尝试回滚并报告尚未完成的清理。

之后的 `spawn()` 才准备 Agent 的 Sandbox、文件、权限、凭证和执行器会话。Agent 状态、输入接纳、实际执行与资源清理可以分别观察。具体使用方式见 [SDK 指南](sdk.md) 和 [Run 生命周期](run-lifecycle.md)。

## Worker 与执行器各自负责什么

每个 Sandbox 内由 root 权限的 Worker 监督非特权执行器。执行器负责模型推理和工具使用；Worker 提供输入、中断、文件操作、会话导出和关闭等管理接口。因此，执行器停止后，可信管理操作仍可继续完成。

Pi 以 RPC 模式运行，提供 `read`、`write`、`edit`、`bash`，启动配置禁用项目扩展、skills、提示词模板和上下文文件。Codex 使用自己的 app-server 接入和原生工具。两者都经过宿主 Model Gateway，并使用相同的 Runtime 和 Service 接口。

| 能力 | Pi | Codex |
| --- | --- | --- |
| 运行中 steering、follow-up、条件输入 | 支持 | 支持 |
| 取消排队输入 | 支持 | 支持 |
| 上下文分叉 | 支持 | 不支持 |
| Steering 模式 | `all`、`one-at-a-time` | `all` |
| 模型请求授权与原始请求追踪 | 支持 | 支持 |

通过 `getExecutorCapabilities(executor)` 查询所选执行器的能力。Harness 应据此启用可选行为，而不应假设两种执行器的会话能力完全相同。

Worker 用同一个 `FileTree` 安装初始文件、捕获快照和替换私有目录。 `files.replace` 按完整摘要校验，成功后可开放写入，保留 Agent 和 Session。

## 一次 Service 调用如何经过 Bridge

Agent 可以运行：

```bash
swarm service list
swarm service view messages --json
swarm messages get --key review --request-id read-review
```

CLI 使用 Sandbox 中的 Bridge URL 和限定作用域的 bearer token。收到调用后，Bridge 依次：

1. 验证令牌，确定真实 Runtime、Agent、Profile 和可选 bindings。
2. 检查调用者是否仍有效，以及 Profile 是否允许这个 Service 操作。
3. 按 manifest 中严格的 JSON Schema draft-07 契约校验输入。
4. 将 `input`、`envelope`、`caller`、`signal` 和 `assertAuthorized` 交给 adapter。
5. 校验返回值，记录调用，并把结果返回给调用者。

Bridge 对每次收到的请求调用一次操作，业务幂等性由 Service 实现。写入的响应丢失时，状态可能已经提交，应保留 `envelope.operation_id` 并使用同一标识核对结果。进程内 handler 在受保护的状态变更前调用 `assertAuthorized()`，避免调用者被撤销权限后仍凭旧授权提交。

进程内 adapter 执行宿主代码。HTTP JSON adapter 把 `{ input, envelope, caller }` 发送到注册端点，携带 `Idempotency-Key`，并在配置了 bearer token 时发送该凭证。远端 Service 必须先认证这条宿主连接，再信任转发的 `caller`；JSON 中的调用者字段本身不构成身份认证。外部端点保持独立的所有权，注册操作不会替你部署或销毁它。已有 Git、聊天等协议可以封装为自定义 adapter，也可以在明确授予网络规则和独立凭证后允许 Agent 直接访问。

## 模型请求经过独立网关

每个模型别名有对应的宿主网关和 attempt 记录。Agent 持有可撤销的网关令牌，网关在转发 `/v1/responses` 时添加真正的上游请求头，并保存接收与转发的请求、流式响应和 attempt 元数据。

默认请求超时是 120 秒。Pi 默认采用 32,768 token 的宿主输出上限；Codex 默认 `maxOutputTokens: null`，保留执行器的输出参数而不施加宿主上限。Harness 可以显式配置这些值。

采用租约的 Harness 可以提供 `modelAccessPolicy`，实现同步的 `authorize` 与 `withCommit`。网关据此拒绝或中断租约、截止时间已经失效的模型工作。选工、租约规则和续约仍由 Harness 与 Services 负责。

## 隔离与凭证所有权

本地 provider 在启动执行器前准备文件系统配额和默认拒绝的网络规则。Sandbox 可访问 Service Bridge、Model Gateway，以及明确允许的非 loopback IPv4 地址。工作区默认私有，共享需要 Harness 明确请求。

上游模型密钥、生命周期凭证和 HTTP adapter 凭证保留在宿主。Harness 也可以通过 `spawn.secretEnv` 明确提供某个 Agent 专用的凭证，让它直接访问获准的外部服务；这种凭证属于已授权的 Sandbox 环境。

Core 对已注册凭证做日志脱敏，但这不会移除私有任务内容、源文件和对话，所以 Run 目录仍需私有保存。

## 导出、验收与资源所有权

`stop()` 停止执行器工作，先导出原生会话与声明的产物，再删除 Sandbox。必需导出失败时会保留资源。`close()` 关闭新工作的接纳，协调在途操作，停止 Agents，在 adapter 提供导出能力时保存 Service 状态，并报告清理是 complete 还是 pending。

应用根据 `runtime.close()` 的回执检查导出产物，然后清理自己拥有的设施。

| Run 路径 | 内容 |
| --- | --- |
| `runtime.json` | 生效配置、生命周期摘要与清理回执 |
| `evidence.jsonl` | 有序的宿主执行证据 |
| `service-calls.jsonl` | Service 输入、结果与错误 |
| `service-state.<serviceId>.json` | Service adapter 可选导出的状态 |
| `model-access/` 与 `model-trace/` | Attempt 记录与请求/响应轨迹 |
| `<agentId>/session/` | 导出的原生执行器会话 |
| `<agentId>/artifacts/` | 收集的文件与 manifest |
| `handoff-report.json` | 公开 SDK 的应用收尾报告 |
| `harness-report.json` | 现有仓库 Harness 封装生成的报告 |

实现细节见 [Core Runtime](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/15-core-runtime.md)、[OpenSandbox 后端](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/16-pi-opensandbox-backend.md) 和 [提示词组合](https://github.com/LuNa-shi/murm/blob/main/docs/architecture/08-prompts.md)。编写应用可以继续阅读 [构建你自己的 Harness](build-your-harness.md)。
