import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('native Worker rejects retired SSE while RPC joins in-flight input and queries delayed evidence', {
  skip: process.env.MURM_CORE_WORKER_RPC_TEST !== '1' && 'Native Worker container probe requires independent review and explicit opt-in',
  timeout: 35_000,
}, async t => {
  const image = process.env.MURM_TEST_AGENT_IMAGE;
  assert.ok(image);
  const probeId = randomUUID();
  const name = `murm-core-rpc-${probeId}`;
  const run = promisify(execFile);
  t.after(async () => {
    await run('docker', ['rm', '--force', name], { timeout: 5000 }).catch(() => undefined);
    const remaining = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=murm.core-input-probe=${probeId}`], { timeout: 5000 });
    assert.equal(remaining.stdout.trim(), '', 'Native Worker probe must leave no owned container');
  });
  const fakePi = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    let count = 0;
    process.stdout.write(JSON.stringify({type:'process_ready'})+'\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line); count++;
      fs.appendFileSync('/workspace/runtime/home/received-inputs.txt', message.id + '\\n');
      process.stdout.write(JSON.stringify({type:'input_seen', count})+'\\n');
      const gateDeadline = Date.now() + 5000;
      const timer = setInterval(() => {
        const released = fs.existsSync('/workspace/runtime/home/release-response');
        if (!released && Date.now() < gateDeadline) return;
        clearInterval(timer);
        process.stdout.write(JSON.stringify({type:'response', id:message.id,
          command:message.type, success:released, data:{disposition:'started'}})+'\\n');
      }, 10);
    });
  `;
  const probe = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const input = JSON.parse(process.argv[1]);
    const origin = 'http://127.0.0.1:44100';
    // A controlled executable occupies the Core command seam; no model is used.
    await mkdir('/tmp/rpc-bin', {mode:0o755});
    await writeFile('/tmp/rpc-bin/pi', '#!/usr/bin/env node'+String.fromCharCode(10)+${JSON.stringify(fakePi)}, {mode:0o755});
    const worker = spawn(process.execPath, ['/opt/murm/agent-worker.mjs','--token','controlled-rpc-test'],
      {stdio:'ignore',env:{...process.env,PATH:'/tmp/rpc-bin:'+process.env.PATH}});
    const post = async (path, body) => {
      const response = await fetch(origin+path,{method:'POST',headers:{authorization:'Bearer controlled-rpc-test','content-type':'application/json'},
        body:JSON.stringify(body), signal:AbortSignal.timeout(3000)});
      return {status:response.status, body:await response.json()};
    };
    try {
      const deadline=Date.now()+5000;
      while (!(await fetch(origin+'/health').then(r=>r.ok,()=>false))) { assert.ok(Date.now()<deadline); await delay(20); }
      const retiredEvents=await fetch(origin+'/events?since=0', {
        headers:{authorization:'Bearer controlled-rpc-test'}, signal:AbortSignal.timeout(3000),
      });
      try {
        assert.equal(retiredEvents.status,404,'Authenticated Worker SSE endpoint is retired');
        assert.deepEqual(await retiredEvents.json(),{ok:false,error:'unknown worker route'});
      } finally { await retiredEvents.body?.cancel().catch(()=>undefined); }
      const start=await post('/start',input); assert.equal(start.status,200);
      const readyDeadline=Date.now()+2000;
      while (!(await post('/rpc',{type:'get_state',since:0})).body.result.records.some(r=>r.type==='process_ready')) {
        assert.ok(Date.now()<readyDeadline); await delay(10);
      }
      const message={type:'prompt',id:'original-input',message:'fixed',streamingBehavior:'steer'};
      const first=post('/rpc',{message,timeout_ms:15,since:0});
      const seenDeadline=Date.now()+2000;
      while (!(await post('/rpc',{type:'get_state',since:0})).body.result.records.some(r=>r.type==='input_seen')) {
        assert.ok(Date.now()<seenDeadline); await delay(10);
      }
      const repeated=post('/rpc',{message,timeout_ms:15,since:0});
      const conflict=await post('/rpc',{message:{...message,message:'changed'},timeout_ms:15});
      assert.equal(conflict.body.code,'CONFLICT');
      const firstResult=(await first).body.result;
      assert.equal(firstResult.state,'pending');
      assert.equal(firstResult.records[0].type,'process_ready');
      assert.equal((await repeated).body.result.state,'pending');
      await writeFile('/workspace/runtime/home/release-response','release');
      let queried;
      const responseDeadline=Date.now()+2000;
      do {
        queried=await post('/rpc',{type:'get_rpc_result',id:message.id,since:0});
        if (queried.body.result.state==='complete') break;
        assert.ok(Date.now()<responseDeadline); await delay(10);
      } while (true);
      assert.equal(queried.body.result.state,'complete');
      assert.equal(queried.body.result.response.success,true);
      assert.equal(queried.body.result.response.id,message.id);
      assert.equal(queried.body.result.response.data.disposition,'started');
      assert.equal(queried.body.result.records.filter(r=>r.type==='input_seen').length,1);
      assert.equal(await readFile('/workspace/runtime/home/received-inputs.txt','utf8'),'original-input\\n');
      const replay=await post('/rpc',{message,timeout_ms:15});
      assert.equal(replay.body.result.state,'complete');
      assert.equal(await readFile('/workspace/runtime/home/received-inputs.txt','utf8'),'original-input\\n');
      assert.equal((await post('/stop',{})).status,200);
      console.log(JSON.stringify({receivedInputs:1,sideEffects:1,queryState:'complete',conflict:true,retiredEventsStatus:retiredEvents.status}));
    } finally { worker.kill('SIGKILL'); }
  `;
  const input = { contract_version: 'murm-core-v2', resources: [],
    system_prompt: 'Controlled Worker RPC receipt probe', system_prompt_path: '/workspace/runtime/profile-prompt.txt',
    command: 'pi', args: ['--mode', 'rpc', '--system-prompt', '/workspace/runtime/profile-prompt.txt'] };
  const result = await run('docker', ['run', '--rm', '--name', name, '--label', `murm.core-input-probe=${probeId}`,
    '--cpus', '1', '--memory', '512m', '--pids-limit', '64', '--network', 'none', '--entrypoint', 'node', image,
    '--input-type=module', '-e', probe, JSON.stringify(input)], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { receivedInputs: 1, sideEffects: 1, queryState: 'complete', conflict: true, retiredEventsStatus: 404 });
});
