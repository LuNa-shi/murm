import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execute, installNotesExample } from './fixtures/notes-installed-package.js';

const fixture = new URL('./fixtures/notes-installed-package.js', import.meta.url).href;
test('frozen archive requires an explicit SHA-256 and rejects changed bytes before any npm consumption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notes-frozen-guard-')); t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'candidate.tgz'); await writeFile(archive, 'changed candidate');
  const script = `import assert from 'node:assert/strict'; import {installNotesExample} from ${JSON.stringify(fixture)};
    for (const options of [ {archive:${JSON.stringify(archive)}}, {expectedSha256:'a'.repeat(64)}, {archive:${JSON.stringify(archive)},expectedSha256:'invalid'} ]) {
      await assert.rejects(installNotesExample(options), {code:'INVALID_FROZEN_PACKAGE'});
    }
    await assert.rejects(installNotesExample({archive:${JSON.stringify(archive)},expectedSha256:'a'.repeat(64)}), error => {
      assert.equal(error.code,'FROZEN_PACKAGE_DIGEST_MISMATCH');
      assert.equal(error.message,'Frozen package digest does not match'); return true;
    });`;
  await execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: '' }, timeout: 5000 });
});

test('explicit installation parents must be existing owned private directories before npm runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notes-parent-guard-')); t.after(() => rm(root, { recursive: true, force: true }));
  const publicDirectory = join(root, 'public'); await mkdir(publicDirectory, { mode: 0o755 }); await chmod(publicDirectory, 0o755);
  const file = join(root, 'file'); await writeFile(file, 'not a directory');
  const link = join(root, 'link'); await symlink(root, link);
  for (const parentDirectory of ['', join(root, 'missing'), publicDirectory, file, link]) {
    await assert.rejects(installNotesExample({}, { parentDirectory }), { code: 'INVALID_INSTALL_PARENT' });
  }
  const script = `import assert from 'node:assert/strict';import {stat} from 'node:fs/promises';
    import {createNativeEvidenceDirectory} from ${JSON.stringify(fixture)};
    const a=await createNativeEvidenceDirectory('native-test'),b=await createNativeEvidenceDirectory('native-test');
    assert.notEqual(a,b);for(const directory of [a,b]) {assert.ok(directory.startsWith(process.cwd()+'/experiments/native-test-'));assert.equal((await stat(directory)).mode & 0o777,0o700);}`;
  await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: root, timeout: 5000 });
});

test('checkout TMPDIR cannot make an external frozen consumer inherit checkout dependencies', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'external-consumer-')); t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'); await mkdir(join(checkout, '.git'), { recursive: true });
  const temp = join(checkout, 'temporary'); await mkdir(temp, { mode: 0o700 });
  const dependency = `checkout-only-${Date.now()}`;
  const poison = join(checkout, 'node_modules', dependency); await mkdir(poison, { recursive: true });
  await writeFile(join(poison, 'package.json'), JSON.stringify({ name: dependency, type: 'module', exports: './index.js' }));
  await writeFile(join(poison, 'index.js'), 'export default true;');
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'examples/notes-environment'), { recursive: true });
  await mkdir(join(packageRoot, 'src/environments/shared'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@swarmenv/core', version: '0.0.0-external', type: 'module', exports: './examples/notes-environment/main.mjs' }));
  await writeFile(join(packageRoot, 'examples/notes-environment/main.mjs'), `import value from '${dependency}';export default value;`);
  for (const name of ['run-input', 'run-report', 'read-result']) await writeFile(join(packageRoot, `src/environments/shared/${name}.js`), '');
  const archive = join(root, 'candidate.tgz'); await execute('tar', ['-czf', archive, 'package'], { cwd: root, timeout: 5000 });
  const expectedSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const script = `import assert from 'node:assert/strict';import {realpath,writeFile,readFile} from 'node:fs/promises';import {dirname,join} from 'node:path';
    import {installNotesExample,installNativeNotesExample,createNativeEvidenceDirectory,execute} from ${JSON.stringify(fixture)};
    const checkout=${JSON.stringify(checkout)},temp=${JSON.stringify(temp)};
    await assert.rejects(installNotesExample(undefined,{parentDirectory:temp}),{code:'INSTALL_PARENT_IN_CHECKOUT'});
    const originalHome=process.env.HOME;process.env.HOME=checkout;
    try {await assert.rejects(installNativeNotesExample(),{code:'INSTALL_HOME_IN_CHECKOUT'});}finally{if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;}
    const probe=join(temp,'probe.mjs');await writeFile(probe,${JSON.stringify("import value from '" + dependency + "';if(!value)throw new Error();")});
    await execute(process.execPath,[probe],{cwd:temp});
    const evidence=await createNativeEvidenceDirectory('separation');
    for (const install of [()=>installNotesExample(),()=>installNativeNotesExample()]) {
      const installed=await install();try {
        assert.equal((await realpath(installed.directory)).startsWith(checkout+'/'),false);
        assert.notEqual(dirname(installed.directory),temp);
        await assert.rejects(execute(process.execPath,['--input-type=module','-e',"await import('@swarmenv/core')"],{cwd:installed.directory,env:installed.env}),error=>/ERR_MODULE_NOT_FOUND/.test(error.stderr));
        const output=join(evidence,'synthetic-result.json');await writeFile(output,JSON.stringify({installation:installed.directory}));
        assert.equal(JSON.parse(await readFile(output)).installation,installed.directory);
      }finally{await installed.close();}
    }`;
  await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout, env: { ...process.env, TMPDIR: temp,
    SWARMENV_TEST_PACKAGE_ARCHIVE: archive, SWARMENV_TEST_PACKAGE_SHA256: expectedSha256 }, timeout: 25_000 });
  // Linked worktrees use a .git file; a symlinked TMPDIR must be checked by its real ancestry too.
  await rm(join(checkout, '.git'), { recursive: true }); await writeFile(join(checkout, '.git'), 'gitdir: private-worktree-metadata');
  const linkedTemp = join(root, 'linked-temp'); await symlink(temp, linkedTemp);
  await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout, env: { ...process.env, TMPDIR: linkedTemp,
    SWARMENV_TEST_PACKAGE_ARCHIVE: archive, SWARMENV_TEST_PACKAGE_SHA256: expectedSha256 }, timeout: 25_000 });
});

test('all external install gates honor the host frozen archive selection without packing a fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'package-frozen-selection-')); t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'candidate.tgz'); await writeFile(archive, 'changed candidate');
  const script = `import assert from 'node:assert/strict'; import {installNotesExample,installNativeNotesExample} from ${JSON.stringify(fixture)};
    await assert.rejects(installNotesExample(), {code:'FROZEN_PACKAGE_DIGEST_MISMATCH'});
    await assert.rejects(installNativeNotesExample(), {code:'FROZEN_PACKAGE_DIGEST_MISMATCH'});
    delete process.env.SWARMENV_TEST_PACKAGE_SHA256;
    await assert.rejects(installNotesExample(), {code:'INVALID_FROZEN_PACKAGE'});
    await assert.rejects(installNativeNotesExample(), {code:'INVALID_FROZEN_PACKAGE'});
    process.env.SWARMENV_TEST_PACKAGE_SHA256='a'.repeat(64);
    delete process.env.SWARMENV_TEST_PACKAGE_ARCHIVE;
    await assert.rejects(installNotesExample(), {code:'INVALID_FROZEN_PACKAGE'});
    await assert.rejects(installNativeNotesExample(), {code:'INVALID_FROZEN_PACKAGE'});`;
  await execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: '',
    SWARMENV_TEST_PACKAGE_ARCHIVE: archive, SWARMENV_TEST_PACKAGE_SHA256: 'a'.repeat(64) }, timeout: 5000 });
});

test('matching frozen archive installs its exact bytes outside checkout without attributing current Git provenance', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'notes-frozen-install-')); t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'examples/notes-environment'), { recursive: true });
  await mkdir(join(packageRoot, 'src/environments/shared'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@swarmenv/core', version: '0.0.0-frozen-fixture', type: 'module', exports: './examples/notes-environment/main.mjs' }));
  await writeFile(join(packageRoot, 'examples/notes-environment/main.mjs'), "export const marker = 'frozen-candidate';\n");
  for (const name of ['run-input', 'run-report', 'read-result']) await writeFile(join(packageRoot, `src/environments/shared/${name}.js`), `export const name = '${name}';\n`);
  const archive = join(root, 'candidate.tgz');
  await execute('tar', ['-czf', archive, 'package'], { cwd: root, timeout: 5000 });
  const bytes = await readFile(archive), expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  const installed = await installNotesExample({ archive, expectedSha256 }); t.after(() => installed.close());
  assert.deepEqual(installed.metadata, { name: '@swarmenv/core', version: '0.0.0-frozen-fixture', sourceCommit: null, sourceDirty: null, sha256: expectedSha256 });
  // The platform temporary directory can itself have checkout ancestry.
  let ancestor = await realpath(installed.directory);
  for (;;) {
    await assert.rejects(lstat(join(ancestor, '.git')), { code: 'ENOENT' });
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  assert.equal((await stat(installed.directory)).mode & 0o777, 0o700);
  assert.deepEqual(await readFile(join(installed.directory, 'frozen-package.tgz')), bytes);
  const result = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { marker } from '@swarmenv/core';
    import { name as input } from './run-input.mjs';
    import { name as reader } from './read-result.mjs';
    assert.equal(marker, 'frozen-candidate');
    assert.equal(input, 'run-input');
    assert.equal(reader, 'read-result');
  `], { cwd: installed.directory, env: installed.env, timeout: 5000 });
  assert.equal(result.stderr, '');
  const nativeParent = await mkdtemp(join(dirname(installed.directory), 'notes-native-parent-'));
  t.after(() => rm(nativeParent, { recursive: true, force: true }));
  const selected = await execute(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict'; import {installNativeNotesExample,execute} from ${JSON.stringify(fixture)};
const installed=await installNativeNotesExample({parentDirectory:${JSON.stringify(nativeParent)}});
try {
  assert.equal((await import('node:path')).dirname(installed.directory),${JSON.stringify(nativeParent)});
  assert.equal((await (await import('node:fs/promises')).stat(installed.directory)).mode & 0o777,0o700);
  assert.equal(installed.metadata.sha256,process.env.SWARMENV_TEST_PACKAGE_SHA256);
  assert.equal(installed.metadata.sourceCommit,null); assert.equal(installed.metadata.sourceDirty,null);
  const result=await execute(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict'; import {marker} from '@swarmenv/core'; assert.equal(marker,'frozen-candidate');"],{cwd:installed.directory,env:installed.env,timeout:5000});
  assert.equal(result.stderr,'');
} finally {await installed.close();}
`], { env: { ...process.env, SWARMENV_TEST_PACKAGE_ARCHIVE: archive,
    SWARMENV_TEST_PACKAGE_SHA256: expectedSha256 }, timeout: 15_000 });
  assert.equal(selected.stderr, '');
  assert.deepEqual(await readFile(archive), bytes);
});

test('native package gate rejects a dirty checkout before npm and removes its install directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-package-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands = join(root, 'commands'); await mkdir(commands);
  const git = join(commands, 'git');
  await writeFile(git, "#!/bin/sh\ncase \"$1\" in rev-parse) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; status) printf '%s\\n' ' M changed.js';; *) exit 1;; esac\n");
  await chmod(git, 0o700);
  const env = { ...process.env, PATH: commands, TMPDIR: root };
  delete env.SWARMENV_TEST_PACKAGE_ARCHIVE; delete env.SWARMENV_TEST_PACKAGE_SHA256;
  const script = `import assert from 'node:assert/strict'; import {installNativeNotesExample} from ${JSON.stringify(fixture)};
    await assert.rejects(installNativeNotesExample(), {code:'DIRTY_PACKAGE_SOURCE'});`;
  await execute(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 5000 });
  assert.deepEqual(await readdir(root), ['commands']);
});

test('npm pack excludes private experiment and report trees before traversing unreadable facility data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'package-private-evidence-'));
  const volumes = ['experiments/run/private-mysql', 'reports/local-run/private-output'].map(path => join(root, path));
  t.after(async () => {
    await Promise.all(volumes.map(volume => chmod(volume, 0o700).catch(() => {})));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(volumes.map(volume => mkdir(volume, { recursive: true })));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'private-evidence-boundary', version: '1.0.0' }));
  await writeFile(join(root, 'index.js'), 'export const included = true;\n');
  await writeFile(join(root, '.gitignore'), await readFile(new URL('../.gitignore', import.meta.url)));
  for (const volume of volumes) {
    await writeFile(join(volume, 'private.bin'), 'PRIVATE_PACKAGE_PROBE\n');
    await chmod(volume, 0);
  }
  const result = await execute('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, timeout: 15_000 });
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
  assert.ok(files.includes('index.js'));
  assert.ok(files.includes('package.json'));
  assert.equal(files.some(path => /^(experiments|reports)\//.test(path)), false);
});

test('candidate package admits only declared distribution roots and retains executable resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'package-declared-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), await readFile(new URL('../package.json', import.meta.url)));
  await writeFile(join(root, '.gitignore'), await readFile(new URL('../.gitignore', import.meta.url)));
  const resources = [
    'src/core/index.js', 'src/core/index.d.ts', 'src/core/services.js', 'src/core/services.d.ts',
    'src/core/backends/pi-opensandbox.js', 'src/core/backends/pi-opensandbox.d.ts',
    'scripts/swarm.mjs', 'scripts/opensandbox-agent-worker.mjs',
    'services/opensandbox-agent/pi-models.json', 'src/environments/shared/run-report.js',
    'examples/scalemas-environment/main.mjs', 'examples/scalemas-environment/config.mjs',
    'examples/notes-environment/main.mjs', 'examples/subagents-environment/controller.mjs',
    'examples/agensh-environment/config.mjs', 'examples/agensh-environment/README.md',
    'docs/architecture/source-map.json', 'test/fixtures/foreground-host-configuration.mjs',
  ];
  const privatePaths = ['.env.production', 'local-credentials.json', 'runtime.json', 'notes-runs/run/secret.txt',
    'local-artifacts/run/private.bin', 'experiments/run/private.bin', 'reports/run/private.bin', '.worktree/other/private.txt',
    ...['notes', 'subagents', 'lead-helper', 'scalemas', 'agensh'].map(mode => `examples/${mode}-environment/${mode}-runs/run/runtime.json`)];
  for (const path of [...resources, ...privatePaths]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), resources.includes(path) ? 'distribution fixture\n' : 'PRIVATE_PACKAGE_PROBE\n');
  }
  for (const mode of ['notes', 'subagents', 'lead-helper', 'scalemas', 'agensh']) {
    const path = `examples/${mode}-environment/.npmignore`;
    await writeFile(join(root, path), await readFile(new URL(`../${path}`, import.meta.url)));
  }
  const packed = await execute('npm', ['pack', '--json', '--ignore-scripts'], { cwd: root, timeout: 15_000 });
  const manifest = JSON.parse(packed.stdout)[0];
  const files = manifest.files.map(file => file.path);
  for (const path of resources) assert.ok(files.includes(path), `Missing distribution resource: ${path}`);
  for (const path of privatePaths) assert.equal(files.includes(path), false, `Undeclared private path admitted: ${path}`);
  const archive = join(root, manifest.filename);
  const contents = await execute('tar', ['-xOf', archive], { timeout: 15_000 });
  assert.ok(!contents.stdout.includes('PRIVATE_PACKAGE_PROBE'));
});
