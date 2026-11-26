---
title: Documentation Site Deployment
description: Build and preview the shared documentation sources, then publish the static website.
section: REFERENCE
order: 14
---

The site in `website/` builds with Astro into static HTML, CSS, bundled fonts, and interactive homepage schematics. The public Markdown guides live in **`docs/en/` and `docs/zh/`**. GitHub and the website use those same files; edit the source once when updating a contract.

## Preview locally

Use Node.js **22.23.4 or newer** for the website. This requirement is separate from the SDK's Node.js minimum.

```bash
cd website
npm ci
npm run dev
```

Open `http://localhost:4321/` for English or `http://localhost:4321/zh/` for Chinese. Navigation is defined in `website/src/lib/nav.ts`, and content collections are configured in `website/src/content.config.ts`. Relative `.md` links in the source become documentation routes in the rendered site.

Test the production build with the GitHub Pages path prefix:

```bash
BASE_PATH=/murm SITE_URL=https://luna-shi.github.io npm run build
BASE_PATH=/murm npm run preview
```

## Publish to GitHub Pages

The repository includes [`.github/workflows/deploy-website.yml`](https://github.com/LuNa-shi/murm/blob/main/.github/workflows/deploy-website.yml).

1. In repository **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
2. Merge the documentation or website change into `main`, or manually dispatch the workflow.

The workflow watches the website, shared English and Chinese guides, and its own configuration. It installs locked website dependencies, obtains `BASE_PATH` and `SITE_URL` from `actions/configure-pages`, builds, and publishes `website/dist/`.

## Publish to Cloudflare Pages

For hosting at a root domain, connect the repository with these settings:

| Setting | Value |
| --- | --- |
| Build environment | Node.js 24 |
| Root directory | `website` |
| Build command | `BASE_PATH=/ npm run build` |
| Build output directory | `dist` |

Keep the full repository checkout available to the build because Astro reads `../docs/en` and `../docs/zh`. Set `SITE_URL` to the production origin when building for a custom domain.

## Update content and navigation together

When adding a page, create the English and Chinese files with the same relative path, include the title/description/section/order frontmatter, and add its route to both navigation lists. Use file-relative `.md` links for other documentation pages. Verify both languages and a non-root `BASE_PATH` before publishing.

Font license notices are kept under [`website/public/licenses/`](https://github.com/LuNa-shi/murm/tree/main/website/public/licenses) for Departure Mono, Inter, JetBrains Mono, Space Grotesk, and Caveat.
