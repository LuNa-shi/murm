import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createNativeEvidenceDirectory, execute, installNativeNotesExample } from './fixtures/notes-installed-package.js';
import { createLocalPeerMeshStack } from './fixtures/peermesh-local-stack.js';

function peerCommand(id: number, prompt: string) {
  return `python3 - <<'MURM_PROJECT_PEER'
import json,os,pathlib,subprocess,time
def git(*args):
 return subprocess.check_output(['git',*args],stderr=subprocess.PIPE,text=True,timeout=15).strip()
repo={'owner':os.environ['RUN_OWNER'],'repo':os.environ['RUN_REPO']}
board={'board_id':os.environ['RUN_BOARD']}
def cli(service,operation,payload):
 cli.next+=1
 return json.loads(subprocess.check_output(['swarm',service,operation,'--stdin','--request-id',f'project-${id}-{cli.next}'],input=json.dumps(payload),stderr=subprocess.PIPE,text=True,timeout=22))
cli.next=0
assert os.getcwd()=='/workspace/project' and os.access('sample.bin',os.X_OK)
assert pathlib.Path('sample.bin').read_bytes()==bytes([255,0,7])
slot=pathlib.Path('.value').read_text().strip()
assert slot
issue=cli('gitea','issue_read',{**repo,'index':int(os.environ['RUN_ISSUE']),'method':'get'})
assert issue['body']==${JSON.stringify(prompt)}
branch=os.environ['WORK_BRANCH']
role=branch.rsplit('-',1)[1]
assert role in ['a','b']
git('init')
git('remote','add','origin',os.environ['RUN_REPOSITORY'])
git('fetch','origin','main')
git('switch','-c',branch)
git('reset','--mixed',os.environ['RUN_INITIAL_COMMIT'])
if role=='a':
 fact=cli('peermesh-context','board_write',{**board,'type':'FACT','content':'Project observation: '+slot})
 assert fact['status']=='admitted'
 path='producer.txt'
 content=slot
else:
 for unused in range(15):
  state=cli('peermesh-context','board_read',board)
  git('fetch','origin','main')
  if 'producer.txt' in git('ls-tree','--name-only','origin/main') and slot in state['rendered']:
   break
  time.sleep(0.6)
 else:
  raise AssertionError('Missing published fact or adopted main')
 git('merge','--ff-only','origin/main')
 content=pathlib.Path('producer.txt').read_text().strip()
 assert content==slot
 path='adopted.txt'
pathlib.Path(path).write_text(content+'\\n')
git('add',path)
git('commit','-m','Record project evidence')
git('push','origin',branch)
head=git('rev-parse','HEAD')
pr=cli('gitea','pull_request_write',{**repo,'method':'create','title':'Record '+path,'head':branch,'base':'main'})
assert pr['head']['sha']==head
receipt=cli('gitea','pull_request_merge',{**repo,'index':pr['number'],'head_sha':head})
assert receipt['headSha']==head
print(json.dumps({'role':role,'path':path,'merge':receipt['mergeSha'],'initial':os.environ['RUN_INITIAL_COMMIT']}))
MURM_PROJECT_PEER`;
}

test('installed PeerMesh uses the captured project for peer coordination and merged delivery', {
  skip: process.env.MURM_PROJECT_PEERMESH_TEST !== '1' && 'Requires local OpenSandbox and the cached PeerMesh facilities',
  timeout: 290_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const installation = await installNativeNotesExample();
  t.after(installation.close);
  const directory = await createNativeEvidenceDirectory('project-peermesh');
  const project = join(installation.directory, 'plain-project');
  await mkdir(project);
  const value = 'peer observation from the captured value file';
  await writeFile(join(project, '.value'), value + '\n');
  await writeFile(join(project, 'sample.bin'), Buffer.from([255, 0, 7]), { mode: 0o755 });
  const prompt = 'Coordinate an observation from the project value file and publish its adoption on main.';
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const stack = await createLocalPeerMeshStack({ directory: join(directory, 'facilities'), advertiseHost: host, setupMs: 130_000 });
  let allowStackClose = true;
  t.after(async () => {
    if (allowStackClose) assert.equal((await stack.close()).cleanup, 'complete');
  });
  const { gitea, mattermost, startBoard } = await stack.start();
  const evidence = new Map();
  const calls = new Map();
  let sequence = 0;
  let failure: unknown;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      const input = await new Response(req).json();
      if (req.url === '/start-board') {
        const board = await startBoard({ ...input, own: () => {}, signal: AbortSignal.timeout(60_000) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(board));
        return;
      }
      assert.equal(req.url, '/v1/responses');
      const ordinal = ++sequence;
      assert.ok(ordinal <= 40);
      const assistant = { type: 'message', id: `message_${ordinal}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Project observation recorded', annotations: [] }] };
      const users = input.input.filter(row => row.role === 'user').map(row => typeof row.content === 'string'
        ? row.content : row.content.map(part => part.text).join(''));
      const firstBatch = users.map(text => {
        try { return JSON.parse(text.slice(text.indexOf('\n') + 1)); } catch { return null; }
      }).find(row => row?.source === 'kickoff');
      const isInitial = firstBatch && firstBatch.text === prompt;
      let item;
      if (isInitial && !calls.has(firstBatch.batchId)) {
        const callId = `project_${ordinal}`;
        calls.set(firstBatch.batchId, callId);
        item = { type: 'function_call', id: `work_${ordinal}`, call_id: callId, name: 'bash',
          arguments: JSON.stringify({ command: peerCommand(ordinal, prompt), timeout: 45 }) };
      } else {
        const result = firstBatch && input.input.find(row => row.type === 'function_call_output' && row.call_id === calls.get(firstBatch.batchId));
        if (result && !evidence.has(firstBatch.batchId)) {
          const proof = JSON.parse(result.output.trim());
          assert.ok(proof.role === 'a' || proof.role === 'b');
          assert.match(proof.merge, /^[a-f0-9]{40}$/);
          evidence.set(firstBatch.batchId, proof);
        }
        item = assistant;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(streamResponse('k3', ordinal, item));
    } catch (error) {
      failure = error;
      res.writeHead(400);
      res.end('Unexpected project peer operation');
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = {
    image, durationMs: 34_000, closeTimeoutMs: 30_000, gitea, mattermost,
    sandbox: {
      egressMode: process.env.MURM_CORE_TEST_EGRESS_MODE,
      lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      isolation: { network: 'api' },
    },
    connection: { advertiseHost: host, modelGateway: { requestTimeoutMs: 25_000, maxOutputTokens: 512 } },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: base + '/v1/responses', headers: {} } } },
  };
  const path = join(directory, 'peermesh.mjs');
  await writeFile(path, `const config = ${JSON.stringify(config)};
config.sandbox.apiKey = process.env.MURM_CORE_TEST_API_KEY;
config.startBoard = async ({boardId, workerId, workerIds, signal}) => {
  const reply = await fetch(${JSON.stringify(base + '/start-board')}, {
    method: 'POST', body: JSON.stringify({boardId, workerId, workerIds}), signal
  });
  if (!reply.ok) throw new Error('Could not start the local Board');
  return reply.json();
};
export default config;
`, { mode: 0o600 });
  allowStackClose = false;
  let status = 0;
  const stdout = await execute(process.execPath, ['node_modules/.bin/murm', '--harness', 'peermesh', '--cwd', project,
    '--prompt', prompt, '--config', path, '--output-dir', join(directory, 'output')], {
    cwd: installation.directory, env: installation.env, timeout: 150_000, maxBuffer: 4 * 1024 ** 2,
  }).then(value => value.stdout, error => {
    status = error.code ?? 1;
    return error.stdout;
  });
  const { result } = JSON.parse(stdout);
  const runtimeId = result.result?.runtimeId;
  if (result.cleanup.status === 'complete' && (!runtimeId || !(await ownedContainers(runtimeId)).length)) allowStackClose = true;
  assert.ifError(failure);
  assert.equal(status, 0, JSON.stringify(result.result?.businessFailure));
  assert.equal(result.reason, 'deadline');
  assert.equal(result.cleanup.status, 'complete');
  assert.equal(result.export.status, 'complete');
  assert.equal(result.cleanup.receipt.agents.length, 2);
  const peers = [...evidence.values()].sort((a, b) => a.role.localeCompare(b.role));
  assert.deepEqual(peers.map(row => row.role), ['a', 'b']);
  assert.equal(peers[0].initial, peers[1].initial);
  assert.equal(peers[1].merge, result.export.receipt.commit);
  const archive = result.export.receipt.archive;
  const { stdout: archivePaths } = await execute('tar', ['-tzf', archive]);
  for (const path of ['producer.txt', 'adopted.txt']) {
    const entries = archivePaths.trim().split('\n').filter(name => name === path || name.endsWith('/' + path));
    assert.equal(entries.length, 1);
    const { stdout: bytes } = await execute('tar', ['-xOzf', archive, '--', entries[0]]);
    assert.equal(bytes, value + '\n');
  }
  await assert.rejects(readFile(join(project, 'adopted.txt')), { code: 'ENOENT' });
  await writeFile(join(directory, 'verification.json'), JSON.stringify({
    package: installation.metadata, image, controlledProvider: true, runtimeId, projectDigest: result.initial.digest,
    commit: result.export.receipt.commit, peers, cleanup: 'complete',
  }, null, 2), { mode: 0o600 });
});
