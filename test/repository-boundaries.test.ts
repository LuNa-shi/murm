import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceFiles = new Set<string>();
async function discover(directory: string) {
  for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory() && ['node_modules', 'dist', '.murm'].includes(item.name)) continue;
    if (item.isDirectory()) await discover(path);
    else if (/\.(?:ts|[cm]?js)$/.test(path)) sourceFiles.add(path);
  }
}
await Promise.all(['src', 'scripts', 'examples', 'benchmarks/fate', 'benchmarks/lead-worker-orders'].map(discover));

const execute = promisify(execFile);
const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));

async function assertBoundary(entries: string[], forbidden: (path: string) => boolean) {
  assert.ok(entries.length, 'The protected source entrypoints exist');
  const directory = await mkdtemp(join(tmpdir(), 'murm-dependencies-'));
  try {
    const project = join(directory, 'tsconfig.json');
    await writeFile(project, JSON.stringify({
      extends: resolve(root, 'tsconfig.json'),
      compilerOptions: { typeRoots: [resolve(root, 'node_modules/@types')] },
      include: entries.map(path => resolve(root, path)),
    }));
    // Use the compiler's resolver, including type-only imports, dynamic literal
    // imports and package self-references. TypeScript 7 does not expose the old
    // JavaScript compiler AST API; this needs no second parser dependency.
    const { stdout } = await execute(process.execPath, [compiler, '--project', project, '--listFilesOnly'],
      { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 ** 2 });
    for (const file of stdout.trim().split('\n')) {
      const path = relative(root, file.trim());
      assert.ok(!forbidden(path), `Dependency crosses its ownership boundary: ${entries[0]} -> ${path}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Core cannot load example implementations or TaskPool domain services', async () => {
  await assertBoundary([...sourceFiles].filter(path => path.startsWith('src/core/')), path =>
    path.startsWith('examples/') || /^src\/(?:task|context|judge|storage|replay|sdk)\//.test(path) ||
    /^src\/agent\/(?:agent-contract|capability-profile|services-bridge)\.ts$/.test(path));
});

test('the common Harness host does not dispatch concrete examples', async () => {
  await assertBoundary([...sourceFiles].filter(path => path.startsWith('src/harness/')), path => path.startsWith('examples/'));
});

test('a collaboration example does not import another collaboration implementation', async () => {
  const harnesses = ['subagents', 'taskpool', 'peermesh', 'substrate', 'lead-worker'];
  for (const harness of harnesses) {
    await assertBoundary([...sourceFiles].filter(path => path.startsWith(`examples/${harness}/`)), path =>
      harnesses.some(other => other !== harness && path.startsWith(`examples/${other}/`)));
  }
});

test('runtime source prompts and messages use English', async () => {
  for (const path of sourceFiles) {
    // Unicode fixtures use escapes so their runtime payloads stay unchanged.
    const content = await readFile(resolve(root, path), 'utf8');
    assert.ok(!/\p{Script=Han}/u.test(content), `Unexpected Han text in runtime source: ${path}`);
  }
});
