import { defineConfig } from 'astro/config';

const base = process.env.BASE_PATH || '/';
const site = process.env.SITE_URL || 'https://luna-shi.github.io';

export default defineConfig({
  site,
  base,
  output: 'static',
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-dimmed',
      },
      wrap: false,
    },
  },
});
