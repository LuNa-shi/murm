---
title: 发布站点与本地可视化
description: 在本地预览 murm 文档站、一键在浏览器中可视化检查任意本地 Run 目录，以及将站点发布到 GitHub Pages 或 Cloudflare Pages。
section: 参考与部署
order: 14
---

本文档站与内置的 **Multi-Agent Trace Viewer** 位于仓库的 `website/` 目录，基于 Astro 编译为纯静态产物（零后端依赖），既可以托管在 GitHub Pages / Cloudflare Pages 供外部访问，也可以在本地一键查看任意一次运行的轨迹目录。

## 1. 本地预览文档与实时编辑

```bash
cd website
npm install
npm run dev
```

打开 `http://localhost:4321/` 即可预览。所有文档 Markdown 均位于 `website/src/content/docs/`，修改后浏览器自动热更新。

## 2. 一键可视化检查本地 Run 目录

每次 SwarmEnv / `murm` 运行结束后，都会在 `outputDir/<runtimeId>/` 下写出 `runtime.json`、`evidence.jsonl`、`service-calls.jsonl`、`environment-report.json` 与各 Agent 的 Session 归档。

你有两种方式把真实本地运行载入 Trace Viewer：

### 方式一：终端一键打开（推荐）

```bash
cd website
npm run build
npm run view -- /path/to/your/runs/<runtimeId>
```

脚本会在 `http://127.0.0.1:4329/trace-viewer/?local=1` 启动一个仅绑定本机回环地址的只读静态服务器，自动汇总该 Run 目录下的结构化记录并在浏览器中直接渲染多泳道时间轴。

### 方式二：在静态网页中直接选择目录

打开已发布的在线版 [Multi-Agent Trace Viewer](../../../trace-viewer/)，点击右上角 **Load Run Dir** 选择本地的 `outputDir/<runtimeId>/` 目录。解析逻辑完全运行在浏览器本地内存中，你的私有代码、日志与对话记录不会上传到任何远端服务器。

## 3. 发布到 GitHub Pages

仓库中已经预置了完整的 GitHub Actions 工作流 [.github/workflows/deploy-website.yml](https://github.com/LuNa-shi/SwarmEnv/blob/main/.github/workflows/deploy-website.yml)。启用只需两步：

1. 将包含 `website/` 的分支合入 `main`；
2. 在 GitHub 仓库打开 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。

此后每当 `website/**` 有新提交合入 `main`，GitHub Actions 会自动构建静态产物并发布到 `https://<owner>.github.io/SwarmEnv/`。如果你绑定了独立域名（如 `murm.dev`），把 workflow 中的 `BASE_PATH` 环境变量改为 `/` 即可。

## 4. 发布到 Cloudflare Pages

如果希望托管在 Cloudflare Pages 并挂载到自己的子域名（例如 `murm.your-domain.com`），在 Cloudflare Pages 控制台连接该仓库并填入三项构建配置即可：

| 配置项 | 填写值 |
| --- | --- |
| **Root directory** | `website` |
| **Build command** | `BASE_PATH=/ npm run build` |
| **Build output directory** | `dist` |

编译产物是完全静态的 HTML、CSS、JS 与优化后的图片资源，天然享受边缘 CDN 加速，且访客打开站点即可直接交互体验 Multi-Agent Trace Viewer。
