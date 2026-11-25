---
title: Deployment
description: Preview the murm documentation site locally and publish static builds to GitHub Pages or Cloudflare Pages.
section: REFERENCE
order: 14
---

This documentation site lives in `website/` and builds with Astro into zero-backend static HTML, CSS, bundled fonts, and optimized WebP diagrams.

## 1. Local development

```bash
cd website
npm install
npm run dev
```

Open `http://localhost:4321/` to preview changes live. All documentation Markdown files live under `website/src/content/docs/`.

## 2. Deploy to GitHub Pages

The repository includes a ready-to-use GitHub Actions workflow at [.github/workflows/deploy-website.yml](https://github.com/LuNa-shi/SwarmEnv/blob/main/.github/workflows/deploy-website.yml).

1. Merge the branch containing `website/` into `main`.
2. In your GitHub repository, open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.

Every subsequent push to `main` touching `website/**` automatically builds and deploys the site, detecting the exact `BASE_PATH` and origin via `actions/configure-pages`.

## 3. Deploy to Cloudflare Pages

To host on Cloudflare Pages under a custom domain (for example `murm.dev`), connect the repository with these three settings:

| Setting | Value |
| --- | --- |
| **Root directory** | `website` |
| **Build command** | `BASE_PATH=/ npm run build` |
| **Build output directory** | `dist` |
