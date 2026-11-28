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
import { httpClient } from '../src/harness/http.js';

function projectCommand(stage: string, sequence: number, dynamic: boolean) {
  return `python3 - <<'MURM_PROJECT_TEAM'
import hashlib,json,os,pathlib,subprocess
stage=${JSON.stringify(stage)}
sequence=${sequence}
dynamic=${dynamic ? 'True' : 'False'}
def run(*args, data=None):
 result=subprocess.run(args,input=data,capture_output=True,text=True,timeout=20)
 assert result.returncode==0, result.stderr
 return result.stdout.strip()
def cli(service,operation,payload):
 cli.next+=1
 return json.loads(run('swarm',service,operation,'--stdin','--request-id',f'project-{sequence}-{cli.next}',data=json.dumps(payload)))
cli.next=0
branch=os.environ['WORK_BRANCH']
assert os.getcwd()=='/workspace/project'
assert os.access('program.bin',os.X_OK) and pathlib.Path('program.bin').read_bytes()==bytes([0,199,255])
slot=pathlib.Path('.slot').read_text()
assert slot
if not pathlib.Path('.git').exists():
 run('git','init')
 run('git','remote','add','origin',os.environ['RUN_REPOSITORY'])
 run('git','fetch','origin','main')
 run('git','switch','-c',branch)
 run('git','reset','--mixed',os.environ['RUN_INITIAL_COMMIT'])
state=cli('board','read',{})
role=branch.split('-')[0]
def proof(path):
 data=pathlib.Path(path).read_bytes()
 return {'commit':run('git','rev-parse','HEAD'),'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
def add_task(name, agent):
 cli('board','assign',{'helper_id':agent,'text':'Read the project slot and deliver '+name})
 task={'id':name,'title':'Deliver the captured project slot','path':name+'.txt'}
 if dynamic:
  task['assignee_ids']=[agent]
 cli('board','create_subtask',task)
if stage in ['initialize','dynamic-goal']:
 assert role=='lead'
 cli('board','announce',{'text':'Deliver observations from the captured project slot','feedback_ids':[]})
 for name,agent in state['team'].items():
  if name!='lead':
   add_task(name,agent)
 if dynamic:
  cli('manage','profile_register',{'id':'extra','prompt':'Handle the additional project observation.'})
  member=cli('team','spawn_member',{'profile':'extra'})
  assert member['status']=='ready', member
  add_task('extra',member['agentId'])
elif role!='lead':
 name='extra' if role=='checker' else role
 row=next(task for task in state['subtasks'] if task['id']==name)
 if row['state']=='ready':
  claimed=cli('board','claim',{'subtask_id':name,'expected_revision':row['revision']})
  pathlib.Path(row['path']).write_text(slot)
  run('git','add',row['path'])
  run('git','commit','-m','Record project slot')
  run('git','push','origin',branch)
  delivered=cli('board','complete',{'subtask_id':name,'expected_revision':claimed['revision'],
   'direction_id':state['directions'][-1]['seq'],'delivery':proof(row['path'])})
  assert delivered['delivery']['verified']
  cli('board','note',{'subtask_id':name,'text':'Keep the exact slot value in the integrated result.'})
else:
 deliveries=state['subtasks']
 notes=state['notes']
 if deliveries and all(task['state']=='complete' for task in deliveries) and len(notes)>=len(deliveries):
  for task in deliveries:
   run('git','fetch','origin',task['delivery']['branch'])
   run('git','cherry-pick',task['delivery']['commit'])
  content=''.join(pathlib.Path(task['path']).read_text() for task in deliveries)
  pathlib.Path('integrated.txt').write_text(content)
  run('git','add','integrated.txt')
  run('git','commit','-m','Integrate verified project deliveries')
  run('git','push','origin',branch)
  submission=cli('board','submit',{'delivery':proof('integrated.txt'),'feedback_ids':[row['seq'] for row in notes]})
  assert submission['delivery']['verified']
print(json.dumps({'role':role,'stage':stage,'baseline':os.environ['RUN_INITIAL_COMMIT']}))
MURM_PROJECT_TEAM`;
}

test('installed Lead–Worker integrates the project through static and dynamic Boards', {
  skip: process.env.MURM_PROJECT_LEAD_WORKER_TEST !== '1' && 'Requires local OpenSandbox and the cached Gitea fixture image',
  timeout: 300_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const installation = await installNativeNotesExample();
  t.after(installation.close);
  const project = join(installation.directory, 'plain-project');
  await mkdir(project);
  await writeFile(join(project, 'program.bin'), Buffer.from([0, 199, 255]), { mode: 0o755 });
  const directory = await createNativeEvidenceDirectory('project-lead-worker');
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const stack = await createLocalPeerMeshStack({ directory: join(directory, 'facilities'), advertiseHost: host,
    giteaOnly: true, setupMs: 70_000 });
  let allowStackClose = true;
  t.after(async () => {
    if (allowStackClose) assert.equal((await stack.close()).cleanup, 'complete');
  });
  const { gitea } = await stack.start();
  const outcomes = [];
  for (const team of ['static', 'dynamic'] as const) {
    await t.test(team, async t => {
      const dynamic = team === 'dynamic';
      const prompt = `Integrate the file observations for the ${team} pass.`;
      const slot = `A257 ${team} observed project slot\n`;
      await writeFile(join(project, '.slot'), slot);
      let arrivals = 0;
      let failure: unknown;
      const completed: { role: string; stage: string; baseline: string }[] = [];
      const server = createServer(async (req, res) => {
        try {
          const ordinal = ++arrivals;
          assert.ok(ordinal <= 32);
          const request = await new Response(req).json();
          const last = request.input.filter(row => row.role === 'user').at(-1);
          const user = JSON.parse(typeof last.content === 'string' ? last.content : last.content.map(part => part.text).join(''));
          const stage = user.type;
          assert.ok(['initialize', 'helper-initial', 'project-integration', 'dynamic-goal', 'board-updates'].includes(stage));
          assert.ok(user.supplement === undefined && user.user_input_id === undefined);
          if (stage === 'initialize' || stage === 'dynamic-goal') assert.equal(user.goal, prompt);
          const recent = request.input.findLast(row => row.type === 'function_call_output');
          const latest = request.input.indexOf(recent) > request.input.indexOf(last) ? recent : undefined;
          let item;
          if (latest) {
            const proof = JSON.parse(latest.output.trim());
            assert.equal(proof.stage, stage);
            completed.push(proof);
            item = { type: 'message', id: `final_${ordinal}`, role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: 'Board turn complete', annotations: [] }] };
          } else {
            item = { type: 'function_call', id: `tool_${ordinal}`, call_id: `call_${ordinal}`, name: 'bash',
              arguments: JSON.stringify({ command: projectCommand(stage, ordinal, dynamic), timeout: 40 }) };
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(streamResponse('k3', ordinal, item));
        } catch (error) {
          failure = error;
          res.writeHead(400);
          res.end('Unexpected project Board turn');
        }
      }).listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => { server.closeAllConnections(); server.close(); });
      const config = {
        team, gitea, image, workTimeoutMs: 95_000, turnTimeoutMs: 45_000, closeTimeoutMs: 30_000,
        sandbox: {
          lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
          isolation: { network: 'api' },
        },
        connection: { advertiseHost: host, modelGateway: { requestTimeoutMs: 22_000, maxOutputTokens: 512 } },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
          url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {},
        } } },
      };
      const path = join(directory, team + '.mjs');
      await writeFile(path, `const config = ${JSON.stringify(config)};
config.sandbox.apiKey = process.env.MURM_CORE_TEST_API_KEY;
export default config;
`, { mode: 0o600 });
      allowStackClose = false;
      let status = 0;
      const stdout = await execute(process.execPath, ['node_modules/.bin/murm', '--harness', 'lead-worker', '--cwd', project,
        '--prompt', prompt, '--config', path, '--output-dir', join(directory, team)], {
        cwd: installation.directory, env: installation.env, timeout: 148_000, maxBuffer: 4 * 1024 ** 2,
      }).then(value => value.stdout, error => {
        status = error.code ?? 1;
        return error.stdout;
      });
      const { result } = JSON.parse(stdout);
      const runtimeId = result.result?.runtimeId;
      if (result.cleanup.status === 'complete' && (!runtimeId || !(await ownedContainers(runtimeId)).length)) allowStackClose = true;
      assert.ifError(failure);
      assert.equal(status, 0, JSON.stringify(result.result?.businessFailure));
      assert.equal(result.outcome, 'completed');
      assert.equal(result.cleanup.status, 'complete');
      assert.equal(result.acceptance.status, 'not-run');
      const { submitted, harness } = result.result.business;
      assert.equal(submitted.delivery.verified, true);
      assert.equal(submitted.feedbackIds.length, dynamic ? 3 : 2);
      assert.equal(harness.board.userInputs.length, 0);
      assert.equal(result.cleanup.receipt.agents.length, dynamic ? 4 : 3);
      assert.equal(new Set(completed.map(row => row.baseline)).size, 1);
      assert.equal(completed[0].baseline, harness.initialCommit);
      if (dynamic) assert.equal(harness.dynamic.member.status, 'ready');
      const git = httpClient(gitea.origin, `token ${gitea.adminToken}`);
      const root = `/api/v1/repos/${gitea.owner}/lead-worker-${harness.runId}`;
      const file = await git('GET', root + `/contents/integrated.txt?ref=${submitted.delivery.commit}`);
      assert.equal(Buffer.from(file.content, 'base64').toString(), slot.repeat(dynamic ? 3 : 2));
      const main = await git('GET', root + '/branches/main');
      assert.equal(main.commit.id, harness.initialCommit);
      await assert.rejects(readFile(join(project, 'integrated.txt')), { code: 'ENOENT' });
      outcomes.push({ team, runtimeId, digest: result.initial.digest, commit: submitted.delivery.commit, cleanup: 'complete' });
    });
    if (!allowStackClose) break;
  }
  assert.equal(outcomes.length, 2);
  await writeFile(join(directory, 'verification.json'), JSON.stringify({
    package: installation.metadata, image, controlledProvider: true, outcomes,
  }, null, 2), { mode: 0o600 });
});
