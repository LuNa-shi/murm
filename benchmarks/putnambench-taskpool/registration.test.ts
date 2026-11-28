import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { verifyPutnamRegistration } from './registration.ts';

const execute = promisify(execFile);
const experimentId = 'EXP-20261127-01';
const model = { provider: 'kimi_proxy', model: 'k3' };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'putnam-registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'checkout');
  const privateDirectory = join(root, 'private');
  await Promise.all([mkdir(repository), mkdir(privateDirectory)]);
  const git = async (...args: string[]) => (await execute('git', args, { cwd: repository })).stdout.trim();
  await git('init', '--quiet');
  await writeFile(join(repository, 'input.txt'), 'initial implementation\n');
  await git('add', 'input.txt');
  const commit = () => git('-c', 'user.name=Registration test', '-c', 'user.email=registration@example.invalid',
    'commit', '--quiet', '-m', 'Test implementation');
  await commit();
  const code = await git('rev-parse', 'HEAD');
  const row = (overrides: { issue?: string; status?: string; code?: string; report?: string } = {}) =>
    `| \`${experimentId}\` | [Issue #200](https://github.com/LuNa-shi/murm/issues/${overrides.issue ?? '200'}) | ${overrides.status ?? '**REGISTERED**'} | \`${overrides.code ?? code}\` | [Run](${overrides.report ?? 'run.md'}) |\n`;
  const registryPath = join(privateDirectory, 'INDEX.md');
  const register = (content = row()) => writeFile(registryPath, content);
  const report = (content = 'Model · `kimi_proxy/k3`\n') => writeFile(join(privateDirectory, 'run.md'), content);
  await register();
  await report();
  const options = { registryPath, experimentId, repository, model };
  return { root, repository, privateDirectory, code, git, commit, row, register, report, options };
}

test('Putnam registration reads private sibling reports using absolute or caller-relative paths', async t => {
  const f = await fixture(t);
  const absolute = await verifyPutnamRegistration(f.options);
  assert.equal(absolute.code, f.code);
  assert.equal(absolute.reportPath, join(f.privateDirectory, 'run.md'));
  await f.register(f.row({ code: f.code.slice(0, 8) }));
  const relative = await verifyPutnamRegistration({ ...f.options, registryPath: 'private/INDEX.md', cwd: f.root });
  assert.deepEqual(relative, absolute);
  await f.report('# Approved default K3 run\n');
  assert.equal((await verifyPutnamRegistration(f.options)).code, f.code);
});

test('Putnam registration requires an explicit registry and exactly one registered run', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyPutnamRegistration({ ...f.options, registryPath: undefined }), /MURM_EXPERIMENT_REGISTRY/);
  await f.register('');
  await assert.rejects(verifyPutnamRegistration(f.options), /one entry/);
  await f.register(f.row() + f.row());
  await assert.rejects(verifyPutnamRegistration(f.options), /one entry/);
  for (const content of [f.row({ issue: '201' }), f.row({ status: '**COMPLETE**' }), f.row({ code: 'main' })]) {
    await f.register(content);
    await assert.rejects(verifyPutnamRegistration(f.options), /under #200 and pin its code/);
  }
});

test('Putnam registration rejects escaped report paths and conflicting model selection', async t => {
  const f = await fixture(t);
  await f.register(f.row({ report: '../other.md' }));
  await assert.rejects(verifyPutnamRegistration(f.options), /sibling Markdown report/);
  await f.register();
  for (const body of ['Model · `gpt_proxy/gpt-6.1-sol`\n',
    'Model · `kimi_proxy/k3`\nModel · `gpt_proxy/gpt-6.1-sol`\n']) {
    await f.report(body);
    await assert.rejects(verifyPutnamRegistration(f.options), /model pair/);
  }
  await f.report('# No model declared\n');
  await assert.rejects(verifyPutnamRegistration({ ...f.options, requireModel: true }), /model pair/);
  await f.report('Model · `gpt_proxy/gpt-6.1-sol`\n');
  assert.equal((await verifyPutnamRegistration({ ...f.options, requireModel: true,
    model: { provider: 'gpt_proxy', model: 'gpt-6.1-sol' } })).code, f.code);
});

test('Putnam registration requires the exact clean HEAD, including documentation commits', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, 'input.txt'), 'uncommitted implementation\n');
  await assert.rejects(verifyPutnamRegistration(f.options), /differs from the registered implementation/);
  await f.git('checkout', '--', 'input.txt');
  await mkdir(join(f.repository, 'docs'));
  await writeFile(join(f.repository, 'docs/run.md'), 'documentation change\n');
  await f.git('add', 'docs/run.md');
  await f.commit();
  await assert.rejects(verifyPutnamRegistration(f.options), /differs from the registered implementation/);
  const current = await f.git('rev-parse', 'HEAD');
  await f.register(f.row({ code: current }));
  assert.equal((await verifyPutnamRegistration(f.options)).code, current);
});
