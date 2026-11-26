import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('native Worker holds writers through live install and rejects an open proof descriptor', {
  skip: process.env.MURM_CORE_LIVE_INSTALL_TEST !== '1', timeout: 35000,
}, async t => {
  const image = process.env.MURM_TEST_AGENT_IMAGE;
  assert.ok(image);
  const name = `murm-live-install-${randomUUID()}`;
  const run = promisify(execFile);
  t.after(async () => {
    await run('docker', ['rm', '--force', name], { timeout: 5000 }).catch(() => undefined);
    assert.equal((await run('docker', ['ps', '--all', '--quiet', '--filter', `name=^/${name}$`])).stdout.trim(), '');
  });
  const fakePi = `const fs=require('node:fs');let n=0,fd;setInterval(()=>{
    fs.writeFileSync('/workspace/runtime/home/beat',String(++n));
    if(fs.existsSync('/workspace/runtime/home/open')&&!fd){fd=fs.openSync('/workspace/project/proof.lean','r');fs.writeFileSync('/workspace/runtime/home/opened','yes');}
    if(fs.existsSync('/workspace/runtime/home/close')&&fd){fs.closeSync(fd);fd=undefined;fs.unlinkSync('/workspace/runtime/home/open');fs.unlinkSync('/workspace/runtime/home/close');fs.writeFileSync('/workspace/runtime/home/closed','yes');}
  },10);`;
  const probe = `
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
    import {setTimeout as delay} from 'node:timers/promises';
    import {decodeFileSeed} from '/opt/murm/dist/scripts/core-file-seed.js';
    await mkdir('/tmp/live-bin');
    await writeFile('/tmp/live-bin/pi','#!/usr/bin/env node\\n'+${JSON.stringify(fakePi)},{mode:0o755});
    const worker=spawn(process.execPath,['/opt/murm/agent-worker.mjs','--token','live-test'],{stdio:'ignore',env:{...process.env,PATH:'/tmp/live-bin:'+process.env.PATH}});
    const origin='http://127.0.0.1:44100';
    const post=async(path,body)=>{const r=await fetch(origin+path,{method:'POST',headers:{authorization:'Bearer live-test','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});return {status:r.status,...await r.json()};};
    const wait=async(predicate)=>{const until=Date.now()+4000;while(!await predicate()){assert.ok(Date.now()<until,'wait deadline');await delay(10);}};
    const exists=path=>access(path).then(()=>true,()=>false);
    try{
      await wait(()=>fetch(origin+'/health').then(r=>r.ok,()=>false));
      const seed={'proof.lean':{encoding:'utf8',data:'original'}};
      const start=await post('/start',{contract_version:'murm-core-v1',resources:[],command:'pi',args:[],system_prompt:'Controlled file installation probe',system_prompt_path:'/workspace/runtime/profile-prompt.txt',files:seed,writable:true});
      assert.equal(start.status,200);
      await wait(()=>exists('/workspace/runtime/home/beat'));
      const pid=(await fetch(origin+'/health').then(r=>r.json())).pid;
      const snapshot=(await post('/core/files/snapshot',{requestId:'before',paths:['.'],includeGit:false,maxBytes:4096,required:true})).result;
      await writeFile('/workspace/runtime/home/open','yes');
      await wait(()=>exists('/workspace/runtime/home/opened'));
      const files={'proof.lean':{encoding:'utf8',data:'integrated',mode:493},'binary':{encoding:'base64',data:'AP+A'}};
      const input={requestId:'install',version:2,expectedDigest:snapshot.digest,files};
      const busy=await post('/core/files/install',input);
      assert.equal(busy.code,'WORKSPACE_BUSY');
      assert.equal(await readFile('/workspace/project/proof.lean','utf8'),'original');
      await writeFile('/workspace/runtime/home/close','yes');
      await wait(()=>exists('/workspace/runtime/home/closed'));
      const installed=await post('/core/files/install',input);
      assert.equal(installed.status,200);assert.equal(installed.result.phase,'installed');
      const beat=await readFile('/workspace/runtime/home/beat','utf8');await delay(100);
      assert.equal(await readFile('/workspace/runtime/home/beat','utf8'),beat);
      assert.equal(await readFile('/workspace/project/proof.lean','utf8'),'integrated');
      assert.deepEqual(await readFile('/workspace/project/binary'),Buffer.from([0,255,128]));
      const repeat=await post('/core/files/install',input);assert.deepEqual(repeat.result,installed.result);
      const confirmed=await post('/core/files/confirm',{requestId:'install',version:2,digest:decodeFileSeed(files).digest});
      assert.equal(confirmed.status,200);assert.equal(confirmed.result.phase,'committed');
      await wait(async()=>await readFile('/workspace/runtime/home/beat','utf8')!==beat);
      assert.equal((await fetch(origin+'/health').then(r=>r.json())).pid,pid);
      assert.equal((await post('/stop',{})).status,200);
      console.log(JSON.stringify({sameProcess:true,held:true,binary:true,descriptorGuard:true}));
    }finally{worker.kill('SIGKILL');}
  `;
  const result = await run('docker', ['run', '--rm', '--name', name, '--cpus', '1', '--memory', '512m', '--pids-limit', '64', '--network', 'none',
    '--mount', `type=bind,source=${resolve('dist')},target=/opt/murm/dist,readonly`, '--entrypoint', 'node', image, '--input-type=module', '-e', probe],
    { timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { sameProcess: true, held: true, binary: true, descriptorGuard: true });
});
