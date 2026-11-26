---
title: 站点部署指南
description: 在本地预览 murm 中英双语文档站，并将静态产物发布至 GitHub Pages 或 Cloudflare Pages。
section: 参考手册
order: 14
---

文档站位于仓库的 `website/` 目录，基于 Astro 构建为零后端静态 HTML、CSS、本地字体包与交互式 SVG 架构图，并原生支持中英文双语路由（`/` 与 `/zh/`）。

## 1. 本地开发预览

需要 **Node.js `>= 22.23.4`**：

```bash
cd website
npm ci
npm run dev
```

打开 `http://localhost:4321/`（英文）或 `http://localhost:4321/zh/`（中文）实时预览。英文文档位于 `website/src/content/docs/`，中文文档位于 `website/src/content/docs-zh/`。

如需按 GitHub Pages 子路径测试生产构建：

```bash
BASE_PATH=/murm SITE_URL=https://luna-shi.github.io npm run build
BASE_PATH=/murm npm run preview
```

## 2. 发布到 GitHub Pages

仓库内置了 GitHub Actions 发布流水线 [.github/workflows/deploy-website.yml](https://github.com/LuNa-shi/murm/blob/main/.github/workflows/deploy-website.yml)：

1. 在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**；
2. 将改动合入 `main`（或通过 `workflow_dispatch` 手动触发）。

此后每次向 `main` 推送触及 `website/**` 的提交，都会自动以锁定依赖构建并发布 `website/dist/`，同时由 `actions/configure-pages` 自动识别最新的 `BASE_PATH`（当前为 `/murm`）和站点源地址。

## 3. 发布到 Cloudflare Pages

若挂载到独立根域名（例如 `murm.dev`），在 Cloudflare Pages 中连接仓库并按以下配置构建：

| 配置项 | 值 |
| --- | --- |
| **构建环境** | Node.js 24 |
| **根目录** | `website` |
| **构建命令** | `BASE_PATH=/ npm run build` |
| **输出目录** | `dist` |

## 字体许可声明

本站随构建分发完整字体许可文件，位于 `website/public/licenses/`：[Departure Mono](../../../../licenses/departure-mono.txt)、[Inter](../../../../licenses/inter.txt)、[JetBrains Mono](../../../../licenses/jetbrains-mono.txt)、[Space Grotesk](../../../../licenses/space-grotesk.txt) 与 [Caveat](../../../../licenses/caveat.txt)。
