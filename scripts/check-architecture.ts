#!/usr/bin/env node
// Documentation-only verification. No network, provider, benchmark or private run data.
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.argv.length !== 2) throw new Error('Usage: node dist/scripts/check-architecture.js');
for (const script of ['generate-architecture-prompts.js', 'generate-architecture-api.js', 'generate-architecture-coverage.js']) {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, script), '--check'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function markdownFiles(directory: string): Promise<string[]>  {
  const files: any[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}
function withoutFences(text: string) {
  const lines = text.split('\n');
  let active: string | null = null;
  return lines.map(line => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!active) { active = match[1]; return ''; }
      if (match[1][0] === active[0] && match[1].length >= active.length) { active = null; return ''; }
    }
    return active ? '' : line;
  }).join('\n');
}
function anchors(text: string) {
  const ids = new Set();
  const repeats = new Map<any, any>();
  const rendered = withoutFences(text);
  for (const line of rendered.split('\n')) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
    if (!heading) continue;
    const base = heading[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = repeats.get(base) ?? 0;
    repeats.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  }
  for (const match of rendered.matchAll(/<(?:a|span)\s+[^>]*(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}
const files = [
  ...['AGENTS.md', 'README.md', 'GLOSSARY.md'].map((path: string) => resolve(root, path)),
  ...await markdownFiles(resolve(root, 'docs')),
  ...await markdownFiles(resolve(root, 'services')),
  ...await markdownFiles(resolve(root, '.codex/skills')).catch((error: any) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  }),
];
const contents = new Map<any, any>(await Promise.all(files.map(async (path: string) => [path, await readFile(path, 'utf8')] as const)));
const failures: any[] = [];
let checked = 0;
for (const [source, text] of contents) {
  const body = withoutFences(text);
  const destinations = [...body.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\s*\)/g)].map((match: any) => match[1]);
  destinations.push(...[...body.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)].map((match: any) => match[1]));
  for (let target of destinations) {
    target = target.replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const hashIndex = target.indexOf('#');
    const pathPart = (hashIndex < 0 ? target : target.slice(0, hashIndex)).split('?')[0];
    const anchor = hashIndex < 0 ? '' : decodeURIComponent(target.slice(hashIndex + 1));
    const destination = pathPart ? resolve(dirname(source), decodeURIComponent(pathPart)) : source;
    if (!await stat(destination).catch(() => null)) { failures.push(`${relative(root, source)}: missing ${target}`); continue; }
    if (anchor && destination.endsWith('.md')) {
      const destinationText = contents.get(destination) ?? await readFile(destination, 'utf8');
      if (!anchors(destinationText).has(anchor)) failures.push(`${relative(root, source)}: missing anchor ${target}`);
    }
    checked++;
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${checked} local documentation links/anchors across ${files.length} maintained Markdown files.`);
