# 22. Public documentation website

The Astro application in [website/](../../website/) publishes the murm landing page, documentation overview, SDK and architecture guides, five Harness guides, a Quickstart, and API, TypeScript, and deployment references. Its npm package has a separate lockfile. It does not start a Runtime or connect to a Service, model provider, or private Run.

## Build and render

Use Node.js 22.23.4 or later. Run `npm ci` and `npm run dev` in `website/` for a local preview. `npm run build` writes the static output to `website/dist/`. `BASE_PATH` defaults to `/` and selects the URL prefix. For the repository site it is `/murm`. `SITE_URL` defaults to the owner’s GitHub Pages origin. These values are build inputs. Update them and rebuild when deploying under a different host or prefix.

Website CI installs the site's locked dependencies and builds with `/murm` and `https://luna-shi.github.io`. Its build checks local page and asset destinations, heading anchors, matching English/Chinese documentation routes, and both locale landing pages. It reports a build check without uploading or deploying the output. [CI triggers and permissions](07-run-configuration.md#ci-build-and-verification)

The content loader reads the repository's `docs/en/` (English) and `docs/zh/` (Chinese), validating each page's title, description, section, and order. Astro prerenders the English and Chinese landing pages (`/` and `/zh/`) plus one documentation route per content slug under `/docs/` and `/zh/docs/`. The shared layouts use those fields for page metadata, navigation, the current page marker, a top-right language switcher linking each page to its counterpart locale, and active table-of-contents tracking. Copy page writes the title, description, and rendered article text to the clipboard. It excludes the code-copy controls and displays success or failure on the button. The site uses Astro’s Sätteri Markdown processor with a local link plugin. The Markdown files are the shared source for GitHub readers and the site. Authors write relative file links such as `../runtime.md` or `harnesses/index.md`. `markdown-doc-links.mjs` resolves each link from its source file, checks that the destination exists inside the repository, and converts guide links to the matching locale route with `BASE_PATH`. Links to implementation files or manuals become GitHub source links. The transform preserves query strings and fragments. Absolute external URLs and same-page fragments retain their meaning. A missing file fails the build instead of publishing a broken route. The URL helper adds the configured base to generated navigation, search destinations, and the favicon. Astro bundles local font assets and inline SVG landing schematics. The public directory supplies the favicon and verbatim font license notices. Departure Mono’s notice and font come from the [upstream font assets](https://github.com/rektdeckard/departure-mono/tree/75152a3f1e6dacdd248a6c397c97dbf27e33eea0/public/assets). The other notices come from the locked Fontsource packages. Update the included notices when changing the corresponding fonts.

The browser handles the landing page diagrams, Harness selector, theme, and site navigation. Search indexes documentation titles, descriptions and sections for the current locale at build time and orders them by the content order field. Opening search shows up to eight pages. Typing filters the index locally. Search renders results and empty-query feedback as DOM text, uses only built documentation destinations, and sends no queries to a server. Escape or backdrop click closes it and returns focus to the navigation button. The theme preference stays in browser storage. The site writes no server-side session state.

## Publish and recover

Astro copies [the CLI installer](../../website/public/install.sh) verbatim into
the Pages artifact at `/murm/install.sh`. It checks for npm and Node.js 22.19 or
later before querying npm for its global prefix and module root. It checks the
nearest existing parent of the bin directory and package scope for write and
traverse access. If either check fails, it selects `$HOME/.local`. npm installs
the latest GitHub Release tarball into the selected prefix with lifecycle
scripts disabled and remote URLs allowed for the top-level package. Install
errors keep npm's exit status. After a successful install the script checks
which `murm` resolves on PATH and prints instructions if the selected binary
is outside the active PATH or shadowed by an older installation. Host setup is
a separate `murm setup` command.
Website CI verifies that the built file matches the source and parses as POSIX sh.

The [Pages workflow](../../.github/workflows/deploy-website.yml) starts after a push to `main` that changes `website/`, `docs/en/`, `docs/zh/` or its workflow, or from manual dispatch for a selected ref. GitHub Pages uses the GitHub Actions source. The `github-pages` environment applies its configured branch policy to each deployment. The workflow reads the site origin and base path from Pages, runs a locked Node 24 build, then uploads `website/dist/` as a Pages artifact. The deploy job runs only after the build succeeds and publishes that artifact using the repository Pages permission and an OIDC token. Each successful deployment replaces the entire published site at the same URL. A deployed artifact must include both locale trees to serve both locales. Deployments share a concurrency group. No npm package publish or sandbox setup runs in this workflow.

Installation, build or environment errors surface in the corresponding Actions job. A successful deploy job records the public URL. A failed build leaves the previously published site available. After fixing a failed deployment, dispatch the workflow on `main` and verify both landing pages, a nested documentation route in each locale, and a static asset under the configured base. The package and local build output are independent of the live deployment history.

## Content maintenance and rendered-link checks

The [documentation index](../INDEX.md) is the repository reading map. Public guide Markdown lives only under `docs/en/` and `docs/zh/`; `website/` owns navigation, layouts, landing components and rendering. The [Runtime](../en/runtime.md), [Services](../en/services.md), and [Swarm Harness](../en/build-your-harness.md) guides document the public interface alongside [SDK & API Reference](../en/reference/api.md), while architecture remains the deeper implementation manual. Add a corresponding page in both languages and update `website/src/lib/nav.ts` when adding a guide. Keep SDK signatures tied to the package exports and executable examples.

After Astro generates the site, `scripts/check-links.mjs` walks every HTML page, resolves same-origin `href` and `src` values under the configured base, checks destination files and HTML anchors, and compares documentation route sets across locales. Both landing pages must exist. A missing base prefix, output file, anchor or counterpart page fails the build and therefore both Website CI and the Pages build. External link reachability and browser interaction are outside this offline check.

For a repository-prefix build, use `BASE_PATH=/murm SITE_URL=https://luna-shi.github.io npm --prefix website run build`. For a root-path preview, build without a base override. Editing user guide content also participates in `npm run docs:check`, which validates repository-relative file links and anchors before publication.


The first SDK Harness documentation links the version 1 download route. The Markdown link processor maps the example's tracked source links to the deployment base, while GitHub continues to render those same links as repository paths. Astro emits the TypeScript files and compiler config directly from the executable example, so the two locales serve identical bytes and the link check covers each download.

The first Harness download route serves the published launcher and turn helper at `downloads/first-harness/v1/` and the candidate definition and Session client at `downloads/first-harness/v2/`. The Markdown link transformer maps the corresponding source links to these static files. The shared Service, configuration and compiler files are available from the source links in either guide.
