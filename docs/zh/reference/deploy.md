---
title: 文档站点部署
description: 构建和预览共用的文档源文件，再发布静态网站。
section: 参考手册
order: 14
---

`website/` 中的网站使用 Astro 构建，产物包含静态 HTML、CSS、打包字体、首页交互示意图、`/latest/` 与 `/zh/latest/` 快捷跳转页，以及公开 CLI 安装脚本 `website/public/install.sh`（`https://luna-shi.github.io/murm/install.sh`）。公开 Markdown 指南位于 **`docs/en/` 与 `docs/zh/`**。GitHub 与网站使用同一份源文件，更新接口说明时只需修改这一处内容。

## 本地预览

网站需要 **Node.js 22.23.4 或更新版本**。这个要求与 SDK 的最低 Node.js 版本分别维护。

```bash
cd website
npm ci
npm run dev
```

英文页面位于 `http://localhost:4321/`，中文页面位于 `http://localhost:4321/zh/`。导航定义在 `website/src/lib/nav.ts`，内容集合配置位于 `website/src/content.config.ts`。源文件中的相对 `.md` 链接会在网站渲染时转换为文档路由。

使用 GitHub Pages 路径前缀检查生产构建：

```bash
BASE_PATH=/murm SITE_URL=https://luna-shi.github.io npm run build
BASE_PATH=/murm npm run preview
```

## 发布到 GitHub Pages

仓库已提供 [`.github/workflows/deploy-website.yml`](https://github.com/LuNa-shi/murm/blob/main/.github/workflows/deploy-website.yml)。

1. 在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。
2. 将文档或网站变更合入 `main`，或手动触发 workflow。

Workflow 监听网站、中英文共用指南和它自身的配置，安装锁定的网站依赖，从 `actions/configure-pages` 获取 `BASE_PATH` 与 `SITE_URL`，完成构建后发布 `website/dist/`。

## 发布到 Cloudflare Pages

需要托管在根域名时，连接仓库并使用以下设置：

| 配置 | 值 |
| --- | --- |
| 构建环境 | Node.js 24 |
| 根目录 | `website` |
| 构建命令 | `BASE_PATH=/ npm run build` |
| 构建输出目录 | `dist` |

构建必须保留完整仓库 checkout，因为 Astro 会读取 `../docs/en` 和 `../docs/zh`。使用自定义域名时，将 `SITE_URL` 设置为实际生产 origin。

## 同步维护内容与导航

新增页面时，在中英文目录中创建相同相对路径的文件，提供 title、description、section、order frontmatter，并加入两份导航。跨文档链接使用相对于文件的 `.md` 路径。发布前检查两种语言以及非根路径的 `BASE_PATH`。

字体许可证位于 [`website/public/licenses/`](https://github.com/LuNa-shi/murm/tree/main/website/public/licenses)，包含 Departure Mono、Inter、JetBrains Mono、Space Grotesk 和 Caveat。
