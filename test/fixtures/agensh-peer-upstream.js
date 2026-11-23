import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export const peerInputs = ['FIXED_AGENSH_PEER_FIRST', 'FIXED_AGENSH_PEER_SECOND'];

export function peerCommand(turn, deniedOrigin) {
  const setup = `import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync,unlinkSync} from 'node:fs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
const cli=(service,operation,input)=>{writeFileSync('.service-input.json',JSON.stringify(input));try{return JSON.parse(execFileSync('swarm',[service,operation,'--input','.service-input.json','--request-id',operation+'-fixed'],{encoding:'utf8',timeout:12000,stdio:['ignore','pipe','pipe']}));}finally{unlinkSync('.service-input.json');}};
const repo={owner:process.env.RUN_OWNER,repo:process.env.RUN_REPO};
const board={board_id:process.env.RUN_BOARD};`;
  const first = `
git('clone',process.env.RUN_REPOSITORY,'.');git('switch','-c',process.env.WORK_BRANCH);
assert.equal(readFileSync('acceptance.txt','utf8'),'INITIAL\\n');
const issue=cli('gitea','issue_read',{...repo,method:'get',index:Number(process.env.RUN_ISSUE)});assert.equal(issue.number,Number(process.env.RUN_ISSUE));
const updated=cli('gitea','issue_write',{...repo,method:'update',index:issue.number,title:'Fixed peer evidence',body:'Verified single peer'});assert.equal(updated.title,'Fixed peer evidence');
cli('agensh-context','board_read',board);
const note=cli('agensh-context','board_write',{...board,type:'FACT',content:'T13 fixed fact',detail:'T13 fixed detail'});assert.equal(note.status,'admitted');assert.ok(note.label);
const grep=cli('agensh-context','board_grep',{...board,words:'T13 fixed fact'});assert.ok(grep.total>=1);
const unfolded=cli('agensh-context','board_unfold',{...board,labels:[note.label]});assert.ok(unfolded.rendered.includes('T13 fixed detail'));
const message=cli('message','post_message',{channel_id:process.env.RUN_CHANNEL,message:'T13 fixed peer message'});assert.ok(message.id);
assert.notEqual(spawnSync('curl',['--silent','--max-time','2',${JSON.stringify(deniedOrigin)}],{timeout:3000}).status,0);
writeFileSync('acceptance.txt','LANDED\\n');assert.equal(readFileSync('acceptance.txt','utf8'),'LANDED\\n');
git('add','acceptance.txt');git('commit','-m','Fixed peer acceptance');const pushedCommit=git('rev-parse','HEAD');git('push','-u','origin',process.env.WORK_BRANCH);
const pr=cli('gitea','pull_request_write',{...repo,method:'create',head:process.env.WORK_BRANCH,base:'main',title:'Fixed peer acceptance'});assert.equal(pr.head.sha,pushedCommit);
const state={turn:1,cwd:process.cwd(),pushedCommit,prNumber:pr.number,messageId:message.id,boardLabel:note.label,networkDenied:true};writeFileSync('.peer-state.json',JSON.stringify(state));console.log(JSON.stringify(state));`;
  const second = `
const before=JSON.parse(readFileSync('.peer-state.json','utf8'));assert.equal(before.cwd,process.cwd());assert.equal(git('rev-parse','HEAD'),before.pushedCommit);assert.equal(git('branch','--show-current'),process.env.WORK_BRANCH);
assert.equal(readFileSync('acceptance.txt','utf8'),'LANDED\\n');
writeFileSync('private.txt','PRIVATE_COMMIT\\n');git('add','private.txt');git('commit','-m','Unpushed private checkpoint');const privateCommit=git('rev-parse','HEAD');assert.notEqual(privateCommit,before.pushedCommit);
writeFileSync('acceptance.txt','DIRTY_PRIVATE\\n');writeFileSync('untracked.bin',Buffer.from([0,255,65,10]));
console.log(JSON.stringify({turn:2,cwd:process.cwd(),privateCommit,pushedCommit:before.pushedCommit,continued:true,untrackedBase64:readFileSync('untracked.bin').toString('base64')}));`;
  return `node --input-type=module <<'PEER_CHECK'\n${setup}\n${turn === 1 ? first : second}\nPEER_CHECK`;
}

export async function createPeerUpstream({ deniedOrigin, onFailure = () => {} }) {
  let arrivals = 0; let accepted = 0; let failure; let failureDetail; const evidence = [];
  let deadlineAt; let deadlineReached = false; let finished = false;
  const server = createServer(async (request, response) => {
    arrivals++;
    const arrival = arrivals; const turn = arrival <= 2 ? 1 : 2; let stage = 'bounds';
    try {
      if (finished || failure) throw new Error();
      if (!deadlineAt || Date.now() >= deadlineAt) { deadlineReached = true; throw new Error(); }
      if (arrivals > 4 || request.method !== 'POST' || request.url !== '/v1/responses') throw new Error();
      stage = 'request'; const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) throw new Error(); chunks.push(chunk); }
      stage = 'body'; const body = JSON.parse(Buffer.concat(chunks).toString());
      stage = 'identity';
      if (body.model !== 'k3' || !Array.isArray(body.input) || !JSON.stringify(body.input).includes(peerInputs[turn - 1])) throw new Error();
      let item;
      if (arrivals % 2) item = { type: 'function_call', id: `fc_peer_${turn}`, call_id: `call_peer_${turn}`, name: 'bash', arguments: JSON.stringify({ command: peerCommand(turn, deniedOrigin), timeout: turn === 1 ? 60 : 20 }) };
      else {
        stage = 'tool-output'; const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === `call_peer_${turn}`);
        if (typeof result?.output !== 'string') throw new Error();
        stage = 'tool-json'; const observed = JSON.parse(result.output.trim());
        stage = 'evidence';
        if (observed.turn !== turn || !/^[a-f0-9]{40}$/.test(observed.pushedCommit)) throw new Error();
        if (turn === 1 && (!observed.networkDenied || !Number.isSafeInteger(observed.prNumber) || !observed.messageId || !observed.boardLabel)) throw new Error();
        if (turn === 2 && (!observed.continued || !/^[a-f0-9]{40}$/.test(observed.privateCommit) || observed.pushedCommit !== evidence[0].pushedCommit || observed.cwd !== evidence[0].cwd || observed.untrackedBase64 !== 'AP9BCg==')) throw new Error();
        evidence.push(observed);
        item = { type: 'message', id: `msg_peer_${turn}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `PEER_${turn}_OK`, annotations: [] }] };
      }
      accepted++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', arrivals, item));
    } catch {
      const firstFailure = !failure; failure = 'FIXED_PEER_PROTOCOL_FAILED';
      failureDetail ??= { code: failure, stage, turn, arrival };
      // Native Pi consumes this correlated terminal failure once. Never return
      // HTTP rejection (retry amplification) or fake a successful settled turn.
      const terminal = { type: 'response.failed', response: { id: `failed_peer_${arrival}`, object: 'response', model: 'k3', status: 'failed', output: [],
        error: { code: failure, message: failure }, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`);
      if (firstFailure) onFailure({ ...failureDetail });
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, start: () => { if (deadlineAt) throw new Error('Already started'); deadlineAt = Date.now() + 120_000; },
    finish: () => { deadlineReached ||= Boolean(deadlineAt && Date.now() >= deadlineAt); finished = true; },
    receipt: () => ({ arrivals, accepted, failure, failureDetail, deadlineReached: deadlineReached || Boolean(!finished && deadlineAt && Date.now() >= deadlineAt), evidence }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
