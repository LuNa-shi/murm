---
title: Deployment
description: Preview the murm documentation site locally and publish static builds to GitHub Pages or Cloudflare Pages.
section: REFERENCE
order: 14
---

This documentation site lives in `website/` and builds with Astro into zero-backend static HTML, CSS, bundled fonts, and optimized WebP diagrams.

## 1. Local development

Use Node.js 22.23.4 or later.

```bash
cd website
npm ci
npm run dev
```

Open `http://localhost:4321/` to preview changes live. All documentation Markdown files live under `website/src/content/docs/`.

## 2. Deploy to GitHub Pages

The repository includes a ready-to-use GitHub Actions workflow at [.github/workflows/deploy-website.yml](https://github.com/LuNa-shi/murm/blob/main/.github/workflows/deploy-website.yml).

1. In your GitHub repository, open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
2. Merge the site into `main` or dispatch the workflow from `main`.

Every subsequent push to `main` touching `website/**` automatically builds and deploys the site, detecting the exact `BASE_PATH` and origin via `actions/configure-pages`.

## 3. Deploy to Cloudflare Pages

To host on Cloudflare Pages under a custom domain (for example `murm.dev`), connect the repository with these settings:

| Setting | Value |
| --- | --- |
| **Build environment** | Node.js 24 |
| **Root directory** | `website` |
| **Build command** | `BASE_PATH=/ npm run build` |
| **Build output directory** | `dist` |


## Font licenses

The site ships the [Departure Mono](../../../licenses/departure-mono.txt), [Inter](../../../licenses/inter.txt), [JetBrains Mono](../../../licenses/jetbrains-mono.txt), [Space Grotesk](../../../licenses/space-grotesk.txt) and [Caveat](../../../licenses/caveat.txt) licenses with each build.
