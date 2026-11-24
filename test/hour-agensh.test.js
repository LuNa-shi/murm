import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlledHourQuota } from './fixtures/hour-quota-owner.js';
import { transport } from './fixtures/core-bot-service-backend.js';
const hooks=registerHooks({resolve(specifier,context,next){if(specifier==='./pi-opensandbox-backend.js'&&context.parentURL?.endsWith('/src/core/index.js'))return{url:new URL('./fixtures/agensh-team-backend.js',import.meta.url).href,shortCircuit:true};return next(specifier,context);}});
const {runAgenshHour}=await import('../src/environments/endurance/agensh.js');hooks.deregister();
const budgets={setupMs:10000,workMs:3900000,turnMs:1000,cleanupMs:1000,recoveryMs:1000,marginMs:100};
test('hour preflight fails before allocation when trusted owner gates are absent',async()=>{
 transport.reset();await assert.rejects(runAgenshHour({options:{},budgets,workload:{}}),{code:'HOUR_PREFLIGHT_GATE_MISSING'});assert.equal(transport.spawns.size,0);
});
for(const failAtEnd of [false,'exit','fatal']) test(`actual eight-Bot Core/router ${failAtEnd?`rejects a last-wake ${failAtEnd}`:'keeps controlled monotonic evidence'}`,async t=>{
 transport.reset();transport.collectable=true;const outputDir=await mkdtemp(join(tmpdir(),'hour-agensh-'));t.after(()=>rm(outputDir,{recursive:true,force:true}));let now=0,quotaClosed=false,activeInputs=0,peakInputs=0;const stoppedSources=new Set(),polled=[];
 const keys=['a','b','c','d','e','f','g','h'];
 const peers=keys.map(key=>({key,branch:`branch-${key}`,gitea:{username:key,binding:`git-${key}`,accountId:key,token:`PRIVATE-git-${key}`},message:{binding:`mm-${key}`,accountId:key,token:`PRIVATE-mm-${key}`},board:{binding:`board-${key}`,workerId:`worker-${key}`}}));
 const complete=async id=>{transport.next=complete;activeInputs++;peakInputs=Math.max(peakInputs,activeInputs);await new Promise(resolve=>setTimeout(resolve,2));activeInputs--;const row=transport.submissions.get(id);transport.spawns.get(row.botId).onEvent({type:'settled',outcome:'completed',output:'PRIVATE'});};transport.next=complete;
 const report=await runAgenshHour({options:{runId:'hour-controlled',image:'fixture',outputDir,backend:{},
   prepare:async()=>({runId:'hour-controlled',repository:{owner:'owner',name:'repo'},repositoryUrl:'http://172.17.0.1:3000/owner/repo.git',channelId:'channel',boardId:'board',issueNumber:1,endpoints:{gitea:'http://172.17.0.1:3000',message:'http://127.0.0.1:3001',board:'http://127.0.0.1:3002'},peers}),
   router:{readContext:async()=> 'PRIVATE',subscribe:async({facilities})=>({ready:true,stop:async()=>{stoppedSources.add(facilities.peer.key);},poll:async()=>{assert.ok(!stoppedSources.has(facilities.peer.key));polled.push(facilities.peer.key);},snapshot:()=>({ready:true})})}},budgets,
   clock:()=>now,waitForMs:async ms=>{now+=ms;if(failAtEnd&&now>=3600000){const peer=[...transport.spawns.values()].find(row=>row.options.profile==='peer-c');peer.onEvent(failAtEnd==='fatal'?{type:'error',fatal:true,error:{code:'CONTROLLED_FATAL',message:'Controlled fatal',retryable:false}}:{type:'exit',code:1});}},admit:async({runtime,workMs})=>({runtimeId:runtime.id,workDeadlineAtMs:now+workMs+100}),
   quota:(()=>{const owner=controlledHourQuota(budgets);return{...owner,close:async()=>{await owner.close();quotaClosed=true;}};})(),
   workload:{async phase(team,index){const contributions=await Promise.all(keys.map(async key=>{const row=index<0?team.kickoff(key,'PRIVATE'):team.ingest(key,{source:'user',kind:'user',eventId:`stage:${index}:${key}`,targetWorker:`worker-${key}`,text:'PRIVATE'});await team.wait(key,row.batchId,{timeoutMs:1000});return{peerKey:key,batchId:row.batchId,proof:{reference:`artifact:${index}:${key}`,sha256:'a'.repeat(64)}};}));if(index===3){const receipt=await team.stopPeer('a',{timeoutMs:1000});assert.equal(receipt.execution,'stopped');assert.equal(transport.spawns.size,8);await team.poll();assert.deepEqual(polled,keys.slice(1));}return{contributions,...(index===3?{handoff:{kind:'controlled-adoption',reference:'handoff',sha256:'b'.repeat(64)}}:{})};}}});
 if(failAtEnd){assert.equal(report.businessFailure.code,'HOUR_PEER_UNAVAILABLE');assert.equal(report.accepted,false);assert.equal(report.cleanup.cleanup,'complete');assert.equal(report.result,undefined);assert.equal(report.quota.closed,true);assert.equal(report.quota.forwarded,1);return;}
 assert.equal(report.businessFailure,undefined);assert.equal(report.result.state,'controlled');assert.equal(report.accepted,false);assert.equal(report.result.durationMs,3600000);assert.equal(report.cleanup.bots.length,8);assert.equal(quotaClosed,true);assert.equal(peakInputs,2);assert.equal(transport.submissions.size,40);assert.doesNotMatch(JSON.stringify(report.result),/PRIVATE/);
});

for (const corrupt of [false, true]) test(`frozen Agensh hour workload ${corrupt ? 'rejects a wrong adopted value' : 'verifies Git/Board and a targeted post-stop source event'}`, { timeout: 20_000 }, async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { createHash } = await import('node:crypto');
  const { createAgenshArithmeticWorkload } = await import('../src/environments/endurance/agensh-workload.js');
  const { createAgenshEventSubscription } = await import('../src/environments/agensh/event-source.js');
  transport.reset(); transport.collectable = true;
  const outputDir = await mkdtemp(join(tmpdir(), 'hour-agensh-business-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
  const keys = ['a','b','c','d','e','f','g','h'];
  const verifiedPrograms = [];
  const facts = [], pulls = [], comments = [], files = new Map(), heads = new Map(), main = new Map();
  const stopped = new Set(); let now = 0, facilities;
  const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 40);
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const url = new URL(request.url, 'http://fixture'), path = url.pathname;
    let result;
    const merge = /\/pulls\/(\d+)\/merge$/.exec(path), pull = /\/pulls\/(\d+)$/.exec(path);
    if (merge) { const row = pulls.find(row => row.number === Number(merge[1])); assert.equal(body.head_commit_id, row.head.sha); row.merged = true; row.merge_commit_sha = sha(`merge:${row.number}`); for (const [path, bytes] of files.get(row.head.ref)) main.set(path, bytes); result = {}; }
    else if (pull) result = pulls.find(row => row.number === Number(pull[1]));
    else if (path.endsWith('/pulls')) result = pulls.filter(row => !row.merged);
    else if (path.includes('/branches/')) { const branch = decodeURIComponent(path.split('/branches/')[1]); result = { name: branch, commit: { id: branch === 'main' ? sha(`main:${main.size}`) : heads.get(branch) } }; }
    else if (path.includes('/contents/')) { const file = path.split('/contents/')[1], ref = url.searchParams.get('ref'); const branch = [...heads].find(([, value]) => value === ref)?.[0]; const bytes = branch ? files.get(branch).get(file) : main.get(file); assert.ok(bytes); result = { type: 'file', path: file, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }; }
    else if (path.endsWith('/issues/comments')) result = comments;
    else if (path.endsWith('/issues/1/comments')) { assert.ok(stopped.has('a'), 'External trigger follows actual publisher stop'); const row = { id: comments.length + 1, body: body.body, user: { id: 999 } }; comments.push(row); result = row; }
    else if (path.includes('/channels/')) result = { order: [], posts: {} };
    else if (path.endsWith('/grep')) result = { entries: facts };
    else if (path.endsWith('/read')) result = { rendered: 'Controlled Board' };
    else assert.fail(`Unexpected controlled facility route ${path}`);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://172.17.0.1:${server.address().port}`;
  const request = globalThis.fetch;
  // The fixture advertises a non-loopback Bot endpoint, but all controlled
  // facility traffic is redirected to this test's exact local listener.
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, origin); url.hostname = '127.0.0.1';
    return request(url, options);
  });
  const peers = keys.map((key, index) => ({ key, branch: `branch-${key}`,
    gitea: { username: `peer-${key}`, binding: `git-${key}`, accountId: String(index + 1), token: `PRIVATE-git-${key}` },
    message: { binding: `mm-${key}`, accountId: key, token: `PRIVATE-mm-${key}` }, board: { binding: `board-${key}`, workerId: `worker-${key}` } }));
  facilities = { runId: 'hour-business', repository: { owner: 'owner', name: 'repo' }, repositoryUrl: `${origin}/owner/repo.git`,
    channelId: 'channel', boardId: 'board', issueNumber: 1, endpoints: { gitea: origin, message: origin, board: origin }, peers };
  transport.onStop = botId => { stopped.add(transport.spawns.get(botId).options.profile.slice(5)); };
  async function modelTurn(inputId) {
    transport.next = modelTurn;
    const submission = transport.submissions.get(inputId), key = transport.spawns.get(submission.botId).options.profile.slice(5);
    const match = /HOUR_STAGE_(\d)_([a-h])/.exec(submission.input); assert.equal(match[2], key);
    const stage = Number(match[1]), index = keys.indexOf(key), n = 17 * (index + 1) + stage;
    const value = { peer: key, stage, n, square: n * n, programming: { answer: `${index}:${stage}` } };
    if (key === 'b' && stage === 4) { assert.ok(stopped.has('a')); value.adoptedSquare = JSON.parse(main.get('hour-a-4.json')).square; value.sum = value.square + value.adoptedSquare; if (corrupt) value.adoptedSquare++; }
    const peer = peers[index], path = `hour-${key}-${stage}.json`;
    assert.ok(submission.input.includes(`git add -- ${path}`));
    assert.match(submission.input, /Leave program source, stdout and test files untracked for private collection/);
    if (!files.has(peer.branch)) files.set(peer.branch, new Map());
    files.get(peer.branch).set(path, Buffer.from(`${JSON.stringify(value)}\n`)); heads.set(peer.branch, sha(`${key}:${stage}`));
    facts.push({ type: 'FACT', thread_id: peer.board.workerId, content: `HOUR_${key}_${stage}_${n * n}` });
    if (stage === 4) pulls.push({ number: pulls.length + 1, head: { ref: peer.branch, sha: heads.get(peer.branch) }, base: { ref: 'main' }, user: { id: index + 1 }, mergeable: true, merged: false });
    transport.spawns.get(submission.botId).onEvent({ type: 'settled', outcome: 'completed', output: 'PRIVATE' });
  }
  transport.next = modelTurn;
  const report = await runAgenshHour({ options: { runId: 'hour-business', image: 'fixture', outputDir, backend: {},
    prepare: async () => facilities, router: { readContext: async () => 'Controlled Board',
      subscribe: options => createAgenshEventSubscription({ ...options, pollIntervalMs: 60_000, maxPolls: 100 }) } }, budgets,
    quota: controlledHourQuota(budgets), clock: () => now, waitForMs: async ms => { now += ms; },
    admit: async ({ runtime, workMs }) => ({ runtimeId: runtime.id, workDeadlineAtMs: now + workMs + 100 }),
    workload: createAgenshArithmeticWorkload({ getFacilities: () => facilities, adminToken: 'PRIVATE-admin', programming: {
      prompt: ({peer,stage}) => `Controlled private CLI task ${peer}:${stage}`,
      verify: ({peer,stage,submission}) => { assert.equal(submission.answer, `${peer}:${stage}`); verifiedPrograms.push([peer,stage]); return true; },
    } }),
  });
  if (corrupt) { assert.equal(report.businessFailure.code, 'HOUR_AGENSH_ARTIFACT_INVALID'); assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.accepted, false); assert.equal(report.quota.closed,true); assert.equal(report.quota.forwarded,1); return; }
  assert.equal(report.businessFailure, undefined);
  assert.equal(report.result.state, 'controlled'); assert.equal(report.accepted, false);
  assert.equal(report.result.handoff.kind, 'agensh-stopped-publisher-main-adoption');
  assert.equal(verifiedPrograms.length, 32); assert.equal(comments.length, 1); assert.equal(pulls.filter(row => row.merged).length, 8);
  assert.equal(transport.submissions.size, 40); assert.equal(stopped.size, 8); assert.equal(report.cleanup.cleanup, 'complete');
  assert.doesNotMatch(JSON.stringify(report.result), /PRIVATE/);
});
