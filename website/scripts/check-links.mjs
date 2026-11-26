import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const base = '/' + (process.env.BASE_PATH || '/').replace(/^\/+|\/+$/g, '');
const prefix = base === '/' ? '' : base;
const origin = new URL(process.env.SITE_URL || 'https://luna-shi.github.io').origin;
const html = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && path.endsWith('.html')) html.push(path);
  }
}
walk(root);
const ids = new Map();
const errors = new Set();
let checked = 0;
function anchors(path) {
  if (!ids.has(path)) ids.set(path, new Set([...readFileSync(path, 'utf8')
    .matchAll(/\b(?:id|name)=["']([^"']+)["']/g)].map(match => match[1])));
  return ids.get(path);
}
for (const page of html) {
  const pagePath = relative(root, page).split(sep).join('/').replace(/index\.html$/, '');
  const current = new URL(`${prefix}/${pagePath}`, origin);
  for (const match of readFileSync(page, 'utf8').matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
    const value = match[1].replace(/&amp;/g, '&');
    if (/^(?:data|mailto|tel|javascript|blob):/i.test(value)) continue;
    const url = new URL(value, current);
    if (url.origin !== origin) continue;
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      errors.add(`${pagePath}: URL omits BASE_PATH: ${value}`);
      continue;
    }
    let target = resolve(root, '.' + decodeURIComponent(url.pathname.slice(prefix.length) || '/'));
    if (target !== root && !target.startsWith(root + sep)) {
      errors.add(`${pagePath}: URL leaves the output directory: ${value}`);
      continue;
    }
    if (existsSync(target) && statSync(target).isDirectory()) target = resolve(target, 'index.html');
    if (!existsSync(target)) errors.add(`${pagePath}: missing output for ${value}`);
    else if (url.hash && target.endsWith('.html') && !anchors(target).has(decodeURIComponent(url.hash.slice(1)))) {
      errors.add(`${pagePath}: missing anchor for ${value}`);
    }
    checked++;
  }
}
const slugs = lang => html.map(path => relative(resolve(root, lang === 'zh' ? 'zh/docs' : 'docs'), path))
  .filter(path => !path.startsWith('..')).sort();
if (JSON.stringify(slugs('en')) !== JSON.stringify(slugs('zh'))) errors.add('English and Chinese documentation routes differ.');
if (!existsSync(resolve(root, 'index.html')) || !existsSync(resolve(root, 'zh/index.html'))) {
  errors.add('Both locale landing pages are required.');
}
if (errors.size) {
  console.error([...errors].join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${checked} local links, assets and anchors across ${html.length} pages; both documentation locales match.`);
}
