---
title: murm 如何工作
description: 沿着一次真实交接，理解 Harness、Runtime、Agent、Profile、Service、Sandbox 与 Run。
section: 快速开始
order: 2
---

Harness 是决定 Agent 如何协作的程序。它通过 SDK 创建 Runtime，给每个 Agent 设置角色与权限，并决定产生结果后下一步做什么。Runtime 执行这些决定，同时记录实际发生的行为。

[Messages 交接示例](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts) 展示了这个关系：一个 Agent 发布信息，另一个 Agent 使用信息，最后由宿主验证产物。

## 沿着一次交接理解运行过程

创建 Agent 之前，Harness 先注册一个提供 `put` 和 `get` 的 Messages Service。writer Profile 只获准调用 `put`，reader Profile 只获准调用 `get`。Profile 还指定模型别名、Worker 镜像、工作区写权限和需要收集的文件。

`createRuntime()` 保存这些配置的快照，启动宿主侧网关并创建 Run 记录。随后 `runtime.spawn()` 分配 Sandbox、启动持久化执行器会话。返回的 Agent 最初处于 idle；创建 Agent 本身不会向模型提交任务。

Harness 在发送输入之前调用 `runtime.observe()` 建立观察，再通过 `runtime.send()` 和稳定的 `requestId` 投递工作。输入回执告诉调用方这次输入是否被接纳，实际执行情况则需要继续观察。

writer 在 Sandbox 中发现自己有权使用的 Service 操作，通过本地 shell 工具执行 `swarm messages put`。宿主 Bridge 验证调用者身份、检查权限、校验输入，再调用注册的实现。信息由此进入 Service 状态，reader 可以通过 `swarm messages get` 读取它。

Harness 确认预期 Service 操作与 Agent 执行都已完成，再推进下一步。最后，`finalizeRun()` 关闭 Runtime，让应用检查导出的产物，并分别记录业务结果、产物校验与资源清理状态。Messages 示例会把 reader 导出的字节与最初提供的值比较，因此成功判断有实际产物作为依据。

## 各个概念分别负责什么

<div class="doc-diagram" role="region" aria-label="murm 各组件的关系">
  <div class="dd-row-2-arrow">
    <div class="dd-box dd-yellow">
      <div class="dd-box-title">HARNESS</div>
      <ul class="dd-list">
        <li>你的控制循环与协作规则</li>
        <li>角色 Profile 与结束条件</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">◄── spawn · send · observe ──►</div>
    <div class="dd-box dd-indigo">
      <div class="dd-box-title">RUNTIME</div>
      <div class="dd-sandbox-stack">
        <div class="dd-sandbox-pill"><strong>SANDBOX A</strong> · Agent（执行器与工作区）</div>
        <div class="dd-sandbox-pill"><strong>SANDBOX B</strong> · Agent（执行器与工作区）</div>
        <div class="dd-sandbox-pill"><strong>SANDBOX C</strong> · Agent（执行器与工作区）</div>
      </div>
    </div>
  </div>

  <div class="dd-pipes">
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">│<br/>▼</span>
      <span class="dd-pipe-meta"><strong>registers</strong><span>v2 manifests &amp; adapters</span></span>
    </div>
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">│<br/>▼</span>
      <span class="dd-pipe-meta"><strong>swarm CLI · /v1/responses</strong><span>authenticated over host bridge</span></span>
    </div>
  </div>

  <div class="dd-row-3">
    <div class="dd-box dd-service">
      <div class="dd-box-title">SHARED SERVICES</div>
      <ul class="dd-list">
        <li>自定义的共享业务状态</li>
        <li>任务板、任务池、Git 与验证器</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">◄──</div>
    <div class="dd-box dd-teal">
      <div class="dd-box-title">HOST GATEWAY</div>
      <ul class="dd-list">
        <li>Service Bridge (auth + schema)</li>
        <li>Model Gateway (host API keys)</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">──►</div>
    <div class="dd-box dd-amber">
      <div class="dd-box-title">RUN TRACES</div>
      <ul class="dd-list">
        <li>outputDir/&lt;runtimeId&gt;/</li>
        <li>会话、调用与产物</li>
      </ul>
    </div>
  </div>
</div>


| 概念 | 含义 | 谁决定规则 |
| --- | --- | --- |
| **Harness** | 组合角色、Services、调度和验收检查的应用程序 | 你的应用 |
| **Runtime** | 管理 Agent、输入投递、观察、文件和清理的一次运行控制实例 | Core |
| **Profile** | 命名的角色配置，包含提示词、模型别名、权限和收集策略 | Harness 定义，Core 与后端执行约束 |
| **Agent** | 具有身份与工作区的持久化执行器会话 | Runtime 管生命周期，Harness 决定工作 |
| **Sandbox** | Agent 运行的隔离环境 | OpenSandbox 后端及其本地隔离 provider |
| **Service** | 有 manifest、schema 与具体实现的共享操作 | Harness 或外部服务的维护方 |
| **Run** | 由 `runtime.id` 标识的具体运行，记录位于 `outputDir/<runtimeId>/` | Core 记录执行，Harness 定义结果 |

## 一次执行结束后，会话仍然保留

执行收束时，Agent 保留会话和文件，通常回到 `idle`，仍然占用一个并发槽位。之后的 `send()` 可以在同一个 Agent 上开始新一轮工作；`interrupt()` 可以中断当前工作并保留 Agent；`stop()` 则开始永久关闭这个 Agent。

因此，Harness 可以实现评审循环、追问和长驻 Worker，也需要决定空闲 Agent 应该继续使用还是被停止。Core 不会自动把某个 Agent 的回答理解为全局任务已经完成。

`settled` 描述的是一次执行结束。多个输入排队时，它并不能证明这次执行具体处理了哪些输入。输入回执、执行状态和业务证据需要分别看待，详见 [Run 生命周期](run-lifecycle.md)。

## Profile 同时提供指令和权限

`Profile.prompt` 向模型描述角色，`Profile.services` 决定这个角色可以调用哪些共享操作。工作区、网络、子 Agent 创建和产物收集设置，则约束相应的 Runtime 或后端行为。

Runtime 创建时会保存 Profiles 和注册 Service manifests 的快照。之后修改原始配置对象，或继续在原 registry 上注册 Service，都不会重新配置这个 Runtime。Service 的共享业务状态仍可变化，例如任务池可以持续创建和认领 Task，而它对外提供的操作契约保持不变。

每个 Runtime 通过 backend 选择一个执行器。OpenSandbox 后端支持 Pi 和 Codex。Harness 依赖特定能力时，应查询 `getOpenSandboxBackendCapabilities()`：Pi 支持上下文分叉和两种 steering 模式；Codex 当前支持 `all` 模式，不支持上下文分叉。

## Services 定义具体协作机制

Service 可以直接运行在 Harness 进程中，也可以通过 HTTP adapter 接入。两种情况下，Agent 都使用相同的 `swarm` CLI 发现和调用获准的操作。Bridge 根据 Agent 凭证注入调用者身份，请求 payload 不能自行声明成另一个 Agent。

操作的业务含义由你决定。TaskPool 的认领是排他的、带租约的；PeerMesh 的 Board 认领是一种协作信号；Substrate 的发布会让成果可被搜索和引用。这些区别由 Services 与 Harness 的规则实现，Runtime 的输入投递和清理能力则可以共用。

注册 Service 不要求为它创建独立容器。宿主代码可以采用进程内 adapter，独立端点可以采用 HTTP adapter，已有原生协议也可以封装成 adapter。应用负责决定是否拥有外部服务的生命周期。

## 文件与运行记录解决不同问题

Agent 默认拥有私有工作区。Harness 可以明确请求共享工作区、在 spawn 时提供初始文件，或通过受控文件操作准备、快照和安装 revision。文件共享本身不定义所有权或合入规则，这些仍由 Harness 和 Services 决定。

Run 记录生命周期、Service、模型和原生会话证据。必需的产物会在 Sandbox 删除之前导出；无法确认必需导出或清理完成时，回执保留 pending 状态和资源标识，供后续处理。日志解释发生了什么，业务验证器判断产物是否有用、是否正确。

接下来可以阅读 [使用 SDK](sdk.md) 了解公开接口，或阅读 [系统架构](architecture.md) 理解宿主、backend、Worker 与网关之间的实现边界。
