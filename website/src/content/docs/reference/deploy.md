---
title: Deployment
description: Preview the murm documentation site locally and publish static builds to GitHub Pages or Cloudflare Pages.
section: REFERENCE
order: 14
---

This documentation site lives in `website/` and builds with Astro into static HTML, CSS, bundled fonts, and interactive homepage schematics with zero server runtime.

## 1. Local development

Use **Node.js `>= 22.23.4`**:

```bash
cd website
npm ci
npm run dev
```

Open `http://localhost:4321/` to preview changes live. All documentation Markdown files live under `website/src/content/docs/`.

To test a production build with a custom path prefix (matching GitHub Pages):

```bash
BASE_PATH=/murm SITE_URL=https://luna-shi.github.io npm run build
npm run preview
```

## 2. Deploy to GitHub Pages

The repository includes a GitHub Actions workflow at [.github/workflows/deploy-website.yml](https://github.com/LuNa-shi/murm/blob/main/.github/workflows/deploy-website.yml):

1. Open repository **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
2. Merge changes into `main` (or trigger the workflow via `workflow_dispatch`).

Every push to `main` touching `website/**` builds the site with locked dependencies and publishes `website/dist/`, automatically detecting `BASE_PATH` and `SITE_URL` via `actions/configure-pages`.

## 3. Deploy to Cloudflare Pages

To host under a root custom domain (such as `murm.dev`), connect the repository with these settings:

| Setting | Value |
| --- | --- |
| **Build environment** | Node.js 24 |
| **Root directory** | `website` |
| **Build command** | `BASE_PATH=/ npm run build` |
| **Build output directory** | `dist` |

## Font licenses

The site ships verbatim license notices under `website/public/licenses/`: [Departure Mono](../../../licenses/departure-mono.txt), [Inter](../../../licenses/inter.txt), [JetBrains Mono](../../../licenses/jetbrains-mono.txt), [Space Grotesk](../../../licenses/space-grotesk.txt), and [Caveat](../../../licenses/caveat.txt).
