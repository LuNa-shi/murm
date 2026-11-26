import { statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const github = 'https://github.com/LuNa-shi/murm';

// Keep Markdown file links readable in GitHub and resolve them to the matching
// locale and deployment base when the same source is rendered by Astro.
export default function markdownDocLinks({ base = '/' } = {}) {
  const prefix = base.replace(/^\/+|\/+$/g, '');
  function rewrite(node, context) {
    const url = node.url;
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return;
    if (!context.fileURL) throw new Error(`A source file is required to resolve documentation link: ${url}`);
    const source = fileURLToPath(context.fileURL);
    const split = url.search(/[?#]/);
    const path = split < 0 ? url : url.slice(0, split);
    const suffix = split < 0 ? '' : url.slice(split);
    const target = resolve(dirname(source), decodeURIComponent(path));
    const repoPath = relative(repositoryRoot, target).split(sep).join('/');
    if (repoPath === '..' || repoPath.startsWith('../')) {
      throw new Error(`${source}: documentation link leaves the repository: ${url}`);
    }
    let targetStat;
    try { targetStat = statSync(target); }
    catch { throw new Error(`${source}: documentation link has no source file: ${url}`); }
    const doc = /^docs\/(en|zh)\/(.+)\.md$/.exec(repoPath);
    let destination;
    if (doc) {
      const slug = doc[2].replace(/\/index$/, '');
      destination = '/' + [prefix, doc[1] === 'zh' ? 'zh' : '', 'docs', slug]
        .filter(Boolean).join('/') + '/' + suffix;
    } else {
      const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
      const imageDefinition = node.type === 'definition'
        && /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i.test(repoPath);
      destination = node.type === 'image' || imageDefinition
        ? `https://raw.githubusercontent.com/LuNa-shi/murm/main/${encoded}${suffix}`
        : `${github}/${targetStat.isDirectory() ? 'tree' : 'blob'}/main/${encoded}${suffix}`;
    }
    context.setField(node, 'url', destination);
  }
  return { name: 'murm-doc-links', link: rewrite, image: rewrite, definition: rewrite };
}
