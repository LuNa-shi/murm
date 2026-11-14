import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
const run = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicStore = new MissionWorkspace({ rootDir: join(root, 'repositories') });
  await publicStore.create({ missionId: 'mission:input', workspaceId: 'workspace-input', initialFiles: {
    '.gitignore': 'ignored.txt\n', '.gitattributes': '*.txt text eol=lf\n', 'ignored.txt': 'tracked public input\n',
    'windows.txt': 'exact CRLF\r\n', 'odd\nname.txt': 'newline path input\n', '.environment': 'ordinary allowed file\n', 'binary.bin': Buffer.alloc(2 * 1024 * 1024, 171),
  } });
  const snapshot = await publicStore.exportRevision({ workspaceId: 'workspace-input' });
  const manager = new WorkspaceManager({ rootDir: join(root, 'executions') });
  const options = { executionId: 'execution-input', fencingVersion: 1, task: { task_id: 'task:input', workspace: {} }, publicSnapshot: snapshot };
  return { root, publicStore, snapshot, manager, options };
}

test('initial Execution Git tree exactly matches tracked public bytes despite ignore and conversion attributes', async t => {
  const { manager, options, snapshot } = await fixture(t);
  const workspace = await manager.createWorkspace(options);
  const tree = (await run('git', ['-C', workspace.workspace_ref, 'rev-parse', 'HEAD^{tree}'])).stdout.trim();
  assert.equal(tree, snapshot.git_tree);
  const ignored = await run('git', ['-C', workspace.workspace_ref, 'show', 'HEAD:ignored.txt']);
  assert.equal(ignored.stdout, snapshot.files['ignored.txt']);
  const crlf = await run('git', ['-C', workspace.workspace_ref, 'show', 'HEAD:windows.txt']);
  assert.equal(crlf.stdout, 'exact CRLF\r\n');
  assert.deepEqual(await manager.createWorkspace(options), workspace);
});

test('failed input construction leaves no partial directory and a different retry cannot overlay a published input', async t => {
  const { publicStore, manager, options, snapshot } = await fixture(t);
  const broken = { ...snapshot, files: { ...snapshot.files, 'extra.txt': 'not in manifest' } };
  await assert.rejects(manager.createWorkspace({ ...options, publicSnapshot: broken }), /manifest/);
  const target = manager.workspacePath(options.executionId);
  await assert.rejects(readdir(target), { code: 'ENOENT' });
  assert.equal((await readdir(manager.rootDir)).some(name => name.startsWith('.swarm-prepare-')), false);
  await manager.createWorkspace(options);
  const saved = await publicStore.save({ workspaceId: 'workspace-input', files: { 'replacement.txt': 'new snapshot' } });
  const next = await publicStore.exportRevision({ workspaceId: 'workspace-input', revision: saved.revision });
  await assert.rejects(manager.createWorkspace({ ...options, publicSnapshot: next }), /different input/);
  assert.equal(await readFile(join(target, '.environment'), 'utf8'), snapshot.files['.environment']);
  await assert.rejects(readFile(join(target, 'replacement.txt')), { code: 'ENOENT' });
});

test('OpenSandbox manifest transfer executes exact byte copies including allowed env-prefix names', async t => {
  const { root, manager, options, snapshot } = await fixture(t);
  const workspace = await manager.createWorkspace(options);
  const guest = join(root, 'controlled-guest');
  await mkdir(guest);
  let copies = 0;
  let verifications = 0;
  const provider = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'controlled:input', waitForExecdReady: false,
    fetchImpl: async (url, request) => {
      if (request.method === 'DELETE') return new Response('{}');
      if (url.endsWith('/sandboxes')) return new Response('{"id":"sandbox:input"}');
      if (url.includes('/endpoints/')) return new Response('{"url":"http://execd.test"}');
      if (url.endsWith('/command')) {
        const { argv } = JSON.parse(request.body);
        assert.ok(Buffer.byteLength(argv[2]) < 128 * 1024);
        if (argv[2].includes('sha256sum')) verifications += 1;
        copies += 1;
        await run(argv[0], argv.slice(1).map(value => value.replaceAll('/workspace', guest)));
        return new Response('event: execution_complete\ndata: {"exit_code":0}\n\n');
      }
      throw new Error('unexpected controlled provider request');
    },
  });
  await provider.ensureExecution({ executionId: 'execution-input' });
  t.after(() => provider.stopExecution('execution-input'));
  const copied = await provider.syncWorkspace({ executionId: 'execution-input', workspaceRef: workspace.workspace_ref, manifest: snapshot.manifest });
  assert.equal(copied.file_count, Object.keys(snapshot.files).length);
  assert.ok(copies > copied.file_count);
  assert.equal(verifications, copied.file_count);
  assert.deepEqual((await readdir(guest)).sort(), Object.keys(snapshot.files).sort());
  for (const [path, expected] of Object.entries(snapshot.files)) assert.deepEqual(await readFile(join(guest, path)), Buffer.from(expected));
});
