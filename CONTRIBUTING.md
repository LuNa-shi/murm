# Contributing to murm

Thank you for your interest in contributing to **murm**!

## Local development setup

Requires **Node.js 22.19+** (and a Linux host with rootful Docker Engine + Landlock ABI 5+ for native OpenSandbox tests):

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run docs:check
npm test
```

For the full CI-equivalent test command (including offline package installation cache seeding), see [docs/workflows/development.md](docs/workflows/development.md).

## Documentation & architecture checks

- **Bilingual user docs**: English and Chinese guides live in `docs/en/` and `docs/zh/` and are rendered directly by the Astro site in `website/`. Keep routes, navigation (`website/src/lib/nav.ts`), and content synchronized across both locales.
- **Website preview**:
  ```bash
  cd website
  npm ci
  npm run dev
  ```
- **Architecture source map**: Whenever you add, move, or remove production files under `src/`, `scripts/`, `deploy/`, `website/`, or `.github/workflows/`, update `docs/architecture/source-map.json` and run:
  ```bash
  npm run docs:generate
  npm run docs:check
  ```

## Pull request guidelines

1. Keep pull requests focused and include regression tests for behavioral changes.
2. Run `git diff --check` to ensure clean whitespace.
3. Never commit API keys, bearer tokens, raw Run directories, or private prompts (keep local scratch runs in the ignored `experiments/` directory).
4. Update `CHANGELOG.md` and `docs/{en,zh}/changelog.md` for user-visible features or breaking changes.
