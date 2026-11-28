import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const isLinux = process.platform === 'linux';

test('an installed murm executable operates a foreground Run in a real Linux terminal', {
  skip: !isLinux && 'Linux PTY acceptance',
  timeout: 240_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-installed-tui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  let archive = env.MURM_TEST_PACKAGE_ARCHIVE;
  if (!archive) {
    const pack = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
      { cwd: root, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    archive = join(directory, JSON.parse(pack.stdout)[0].filename);
  }
  assert.ok(isAbsolute(archive), 'use the exact candidate tarball');
  const installation = join(directory, 'consumer');
  await mkdir(installation);
  await writeFile(join(installation, 'package.json'), '{"name":"foreground-terminal-acceptance","private":true}\n');
  await run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', archive],
    { cwd: installation, env, timeout: 60_000 });
  env.PATH = join(installation, 'node_modules', '.bin') + delimiter + env.PATH;
  const fixture = fileURLToPath(new URL('./fixtures/murm-tui-installed.py', import.meta.url));
  await run('python3', [fixture, installation], { env, timeout: 110_000, maxBuffer: 1024 * 1024 });
});
