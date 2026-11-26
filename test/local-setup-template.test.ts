import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { prepareSubagentsProject } from '../scripts/local-setup-template.js';

const execute = promisify(execFile);

test('generated Subagents installs a real archive outside the checkout and retains user edits on repeat', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, image: 'sha256:fixture-worker', lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
    endpointHost: '127.0.0.1', advertiseHost: '172.17.0.1' };
  const env = { ...process.env };
  delete env.NODE_PATH;
  for (const key of Object.keys(env)) if (key.startsWith('MURM_SUBAGENTS_')) delete env[key];
  const cli = fileURLToPath(new URL('../scripts/murm.js', import.meta.url));
  const initialized = await execute(process.execPath, [cli, 'init', '--template', 'subagents', '--dir', directory], {
    cwd: tmpdir(),
    env: { ...env, DOCKER_HOST: `unix://${join(directory, 'missing.sock')}`, MURM_SUBAGENTS_IMAGE: options.image,
      MURM_SUBAGENTS_LIFECYCLE_URL: options.lifecycleBaseUrl, MURM_SUBAGENTS_ADVERTISE_HOST: options.advertiseHost },
  });
  const { project: first } = JSON.parse(initialized.stdout);
  assert.equal(first.installed, true);
  assert.match(await readFile(join(directory, '.env'), 'utf8'), /MURM_SUBAGENTS_IMAGE="sha256:fixture-worker"/);
  assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).scripts.start, 'murm');
  const help = await execute(process.execPath, ['main.js', '--help'], { cwd: directory, env });
  assert.match(help.stdout, /Usage: node main.js/);
  const config = (await readFile(join(directory, 'config.js'), 'utf8')).replace('maxAgents: Number(process.env.MURM_SUBAGENTS_MAX_AGENTS ?? 4)', 'maxAgents: 2');
  await writeFile(join(directory, 'config.js'), config);
  await writeFile(join(directory, '.env'), 'MURM_SUBAGENTS_MODEL_URL=http://127.0.0.1:9999/v1/responses\nMURM_SUBAGENTS_MODEL_TOKEN=fixture-only\n');
  const read = await execute(process.execPath, ['--input-type=module', '-e',
    'import config from "./config.js"; console.log(JSON.stringify({maxAgents:config.maxAgents,url:config.backend.models.default.upstream.url,token:config.backend.models.default.upstream.headers.authorization}));'],
  { cwd: directory, env });
  assert.deepEqual(JSON.parse(read.stdout), { maxAgents: 2, url: 'http://127.0.0.1:9999/v1/responses', token: 'Bearer fixture-only' });
  const repeated = await execute(join(directory, 'node_modules/.bin/murm'), ['init', '--template', 'subagents', '--dir', '.'], {
    cwd: directory, env: { ...env, DOCKER_HOST: `unix://${join(directory, 'missing.sock')}` },
  });
  const { project: second } = JSON.parse(repeated.stdout);
  assert.equal(second.installed, false);
  assert.equal(second.archiveSha256, first.archiveSha256);
  assert.ok(second.preservedFiles.includes('config.js'));
  assert.ok(second.preservedFiles.includes('.env'));
  assert.equal(await readFile(join(directory, 'config.js'), 'utf8'), config);
  assert.match(await readFile(join(directory, '.env'), 'utf8'), /MODEL_TOKEN=fixture-only/);
  await assert.rejects(access(join(directory, '.murm-setup.lock')), { code: 'ENOENT' });
});

test('an already aborted init creates no project resources', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'murm-project-abort-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'project');
  await assert.rejects(prepareSubagentsProject({ directory, image: 'unused', lifecycleBaseUrl: 'unused', endpointHost: 'unused',
    advertiseHost: 'unused', signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('failed package preparation releases its lock and preserves existing project edits', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'invalid.tgz');
  await writeFile(archive, 'invalid archive');
  await writeFile(join(directory, 'config.js'), 'export default { userEdited: true };\n');
  await writeFile(join(directory, '.env'), 'MURM_SUBAGENTS_MODEL_TOKEN=retained-fixture\n');
  await assert.rejects(prepareSubagentsProject({ directory, image: 'unused', lifecycleBaseUrl: 'unused', endpointHost: 'unused',
    advertiseHost: 'unused', packageArchive: archive }), { code: 'PACKAGE_ARCHIVE_INVALID' });
  assert.equal(await readFile(join(directory, 'config.js'), 'utf8'), 'export default { userEdited: true };\n');
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), 'MURM_SUBAGENTS_MODEL_TOKEN=retained-fixture\n');
  await assert.rejects(access(join(directory, '.murm-setup.lock')), { code: 'ENOENT' });
});
