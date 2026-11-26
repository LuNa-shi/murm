import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import markdownDocLinks from './src/lib/markdown-doc-links.mjs';

const base = process.env.BASE_PATH || '/';
const site = process.env.SITE_URL || 'https://luna-shi.github.io';

export default defineConfig({
  site,
  base,
  output: 'static',
  markdown: {
    processor: satteri({ mdastPlugins: [markdownDocLinks({ base })] }),
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-dimmed',
      },
      wrap: false,
    },
  },
});
