import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';
export const teamFact = 'T15_FACT_BASE_VALUE=7';
export const teamClaim = 'T15_SHARED_COMPONENT';
export const teamInputs = ['T15_KICK_A', 'T15_KICK_B', 'T15_NEGOTIATE', 'T15_CONFIRM', 'T15_USER'];

export function teamCommand(stage, batch, peerNames) {
  const setup = `import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
const event=${JSON.stringify({ batchId: batch.batchId, source: batch.source, eventId: batch.eventId, text: batch.text })};
const stage=${JSON.stringify(stage)},fact=${JSON.stringify(teamFact)},claim=${JSON.stringify(teamClaim)};
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
let serial=0;const cli=(service,operation,input)=>{writeFileSync('.team-input.json',JSON.stringify(input));try{return JSON.parse(execFileSync('swarm',[service,operation,'--input','.team-input.json','--request-id',stage+'-'+operation+'-'+(++serial)],{encoding:'utf8',timeout:12000,stdio:['ignore','pipe','pipe']}));}finally{unlinkSync('.team-input.json');}};
const repo={owner:process.env.RUN_OWNER,repo:process.env.RUN_REPO},board={board_id:process.env.RUN_BOARD};
const proc=()=>{let pid=process.pid;for(let i=0;i<12&&pid>1;i++){const raw=readFileSync('/proc/'+pid+'/stat','utf8');const name=raw.slice(raw.indexOf('(')+1,raw.lastIndexOf(')'));const fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');if(['pi','pi-rpc'].includes(name))return {pid,start:fields[19]};pid=Number(fields[1]);}throw Error('native Pi ancestor missing');};
const identity={cwd:process.cwd(),pi:proc(),branch:process.env.WORK_BRANCH};
`;
  const initial = `git('clone',process.env.RUN_REPOSITORY,'.');git('switch','-c',process.env.WORK_BRANCH);
const note=cli('agensh-context','board_write',{...board,type:'CLAIM',content:claim});assert.equal(note.status,'admitted');
let factLabel;
${stage === 'a-initial' ? "const published=cli('agensh-context','board_write',{...board,type:'FACT',content:fact,detail:'Shared input required by the right contribution'});assert.equal(published.status,'admitted');factLabel=published.label;" : `const message=cli('message','post_message',{channel_id:process.env.RUN_CHANNEL,message:'@${peerNames.a} T15_NEGOTIATE I also claimed the component. I will take right.txt, please take left.txt.'});assert.ok(message.id);`}
const result={stage,event,...identity,claimLabel:note.label,...(factLabel?{factLabel}:{})};writeFileSync('.team-state.json',JSON.stringify(result));console.log(JSON.stringify(result));`;
  const contribution = `const before=JSON.parse(readFileSync('.team-state.json','utf8'));assert.deepEqual(identity.pi,before.pi);assert.equal(identity.cwd,before.cwd);
const context=cli('agensh-context','board_read',board);assert.ok(context.rendered.includes(fact));
const claims=cli('agensh-context','board_grep',{...board,words:claim,types:'CLAIM',limit:10});assert.ok(claims.total>=2);
const file=${JSON.stringify(stage === 'a-contribution' ? 'left.txt' : 'right.txt')};const adoptedFact=context.rendered.match(/T15_FACT_BASE_VALUE=[0-9]+/)?.[0];assert.equal(adoptedFact,fact);const content=${stage === 'a-contribution' ? JSON.stringify('T15_LEFT_ACCEPTED\n') : "'T15_RIGHT_ADOPTED '+adoptedFact+'\\n'"};
writeFileSync(file,content);assert.equal(readFileSync(file,'utf8'),content);git('add',file);git('commit','-m','Peer checked contribution '+file);const head=git('rev-parse','HEAD');git('push','-u','origin',process.env.WORK_BRANCH);
const pr=cli('gitea','pull_request_write',{...repo,method:'create',title:'T15 '+file,head:process.env.WORK_BRANCH,base:'main'});assert.equal(pr.head.sha,head);
const summary=cli('agensh-context','board_write',{...board,type:'PATCH_SUMMARY',content:'files='+file+' | idea=agreed split contribution | evidence=verified exact file bytes; PR '+pr.number+' head '+head});assert.equal(summary.status,'admitted');
${stage === 'a-contribution' ? `const message=cli('message','post_message',{channel_id:process.env.RUN_CHANNEL,message:'@${peerNames.b} T15_CONFIRM Agreed. left.txt is mine, right.txt is yours. Use the published FACT.'});assert.ok(message.id);` : ''}
const result={stage,event,...identity,head,prNumber:pr.number,file,content,claimCount:claims.total,adopted:context.rendered.includes(fact)};writeFileSync('contribution.json',JSON.stringify(result));console.log(JSON.stringify(result));`;
  const user = `const before=JSON.parse(readFileSync('.team-state.json','utf8'));assert.deepEqual(identity.pi,before.pi);assert.equal(identity.cwd,before.cwd);const publicHead=git('rev-parse','HEAD');
writeFileSync('private.txt','T15_UNPUSHED\\n');git('add','private.txt');git('commit','-m','Private unpushed checkpoint');const privateHead=git('rev-parse','HEAD');assert.notEqual(publicHead,privateHead);writeFileSync('left.txt','T15_DIRTY_PRIVATE\\n');writeFileSync('untracked.bin',Buffer.from([0,255,65,10]));
const result={stage,event,...identity,publicHead,privateHead,binary:readFileSync('untracked.bin').toString('base64')};writeFileSync('user-event.json',JSON.stringify(result));console.log(JSON.stringify(result));`;
  return `node --input-type=module <<'TEAM_CHECK'\n${setup}\n${stage.endsWith('initial') ? initial : stage.endsWith('contribution') ? contribution : user}\nTEAM_CHECK`;
}

export async function createTeamUpstream({ deadlineAt, peerNames, onFailure = () => {} }) {
  const stages = new Map(); const evidence = []; let arrivals = 0, accepted = 0, failure;
  const server = createServer(async (request, response) => {
    const arrival = ++arrivals; let step = 'bounds';
    try {
      assert.ok(!failure && arrival <= 10 && Date.now() < deadlineAt); assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      step = 'batch'; const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.model, 'k3'); assert.ok(body.max_output_tokens > 0 && body.max_output_tokens <= 128);
      const current = body.input.filter(row => row.role === 'user').at(-1); const text = typeof current?.content === 'string' ? current.content : current.content.map(part => part.text ?? '').join('');
      const batch = JSON.parse(text.slice(text.indexOf('\n') + 1));
      const names = ['a-initial', 'b-initial', 'a-contribution', 'b-contribution', 'a-user'];
      const indices = teamInputs.map((marker, index) => batch.text.includes(marker) ? index : -1).filter(index => index >= 0); assert.equal(indices.length, 1);
      const index = indices[0], stage = names[index];
      assert.equal(batch.source, index < 2 ? 'kickoff' : index === 4 ? 'gitea' : 'mattermost');
      if (index > 1) assert.ok(batch.context.includes(teamFact));
      const prior = stages.get(stage); const callId = `team_${stage}`; let item;
      if (!prior) {
        stages.set(stage, { batchId: batch.batchId, eventId: batch.eventId });
        item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'bash', arguments: JSON.stringify({ command: teamCommand(stage, batch, peerNames), timeout: 70 }) };
      } else {
        assert.equal(prior.batchId, batch.batchId); assert.equal(prior.eventId, batch.eventId); assert.equal(prior.completed, undefined);
        step = 'tool-result'; const results = body.input.filter(row => row.type === 'function_call_output' && row.call_id === callId); assert.equal(results.length, 1);
        const result = JSON.parse(results[0].output.trim()); assert.equal(result.stage, stage); assert.equal(result.event.batchId, batch.batchId); assert.equal(result.event.eventId, batch.eventId);
        assert.ok(result.pi.pid > 0 && typeof result.pi.start === 'string');
        if (stage.endsWith('contribution')) { assert.match(result.head, /^[a-f0-9]{40}$/); assert.ok(result.prNumber > 0 && result.claimCount >= 2 && result.adopted); }
        if (stage === 'a-user') { assert.equal(result.binary, 'AP9BCg=='); assert.notEqual(result.privateHead, result.publicHead); }
        prior.completed = true; evidence.push(result);
        item = { type: 'message', id: `msg_${callId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `${stage}_OK`, annotations: [] }] };
      }
      assert.ok(Date.now() < deadlineAt); accepted++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', arrival, item));
    } catch {
      const first = !failure; failure ??= { code: 'T15_FIXTURE_FAILED', step, arrival };
      const terminal = { type: 'response.failed', response: { id: `failed_team_${arrival}`, object: 'response', model: 'k3', status: 'failed', output: [], error: { code: failure.code, message: failure.code }, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`); if (first) onFailure();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, accepted, failure, evidence: structuredClone(evidence) }), close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
