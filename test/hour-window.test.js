import assert from 'node:assert/strict';
import test from 'node:test';
import { createHourWindow, HOUR_MS, WINDOW_MS } from '../src/environments/shared/hour-window.js';
const peers = ['a','b','c','d'];
const input = (id,n=0) => ({ inputId:`input:${id}:${n}`, receipt:{inputId:`input:${id}:${n}`,status:'accepted',disposition:'started'}, settled:{botId:id,seq:n+1,outcome:'completed'} });
const proof = id => ({ reference:`artifact:${id}`,sha256:'a'.repeat(64) });
function fixture() { let at=0; const monitor=createHourWindow({runtimeId:'runtime',mode:'flat',botIds:peers,clock:()=>at}); return {monitor,set:value=>{at=value;}}; }
function start(f) { for(const id of peers) f.monitor.baseline(id,input(id),proof(id)); f.monitor.open(); }
const cleanup={cleanup:'complete',bots:peers.map(botId=>({botId,execution:'stopped',cleanup:'complete'})),pending:[]};
test('controlled four-window receipts remain preparation evidence even after a synthetic hour',()=>{
 const f=fixture();start(f);
 for(let phase=0;phase<4;phase++){ f.set(phase*WINDOW_MS+1); for(const id of peers) f.monitor.progress(id,input(id,phase+1),{...proof(id),reference:`phase:${phase}:${id}`}); }
 f.monitor.handoff({kind:'fixed-revision-adoption',reference:'handoff',sha256:'b'.repeat(64)});
 f.set(HOUR_MS);f.monitor.end();const report=f.monitor.finish(cleanup);
 assert.equal(report.durationMs,HOUR_MS);assert.equal(report.state,'controlled');assert.equal(report.accepted,false);assert.deepEqual(report.windows.map(x=>x.botIds.length),[4,4,4,4]);
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
});
test('short work, empty windows and early handoffs never satisfy the hour contract',()=>{
 const f=fixture();start(f);assert.throws(()=>f.monitor.handoff({kind:'fixed-revision-adoption',...proof('x')}),{code:'HOUR_HANDOFF_WINDOW'});
 f.set(HOUR_MS-1);assert.throws(()=>f.monitor.finish(cleanup),{code:'HOUR_TOO_SHORT'});
 f.set(HOUR_MS);f.monitor.end();assert.throws(()=>f.monitor.finish(cleanup),{code:'HOUR_WINDOW_INCOMPLETE'});
});
test('queued receipts, reused identity, foreign Bot and pending owner cleanup fail closed',()=>{
 const f=fixture();const queued=input('a');queued.receipt.disposition='queued';assert.throws(()=>f.monitor.baseline('a',queued,proof('a')),{code:'HOUR_INPUT_UNCONFIRMED'});
 start(f);f.set(1);f.monitor.progress('a',input('a',1),{...proof('a'),reference:'new:a'});assert.throws(()=>f.monitor.progress('a',input('a',1),proof('a')),{code:'HOUR_RECEIPT_REUSED'});
 assert.throws(()=>f.monitor.progress('foreign',input('foreign'),proof('foreign')),{code:'HOUR_FOREIGN_BOT'});
 for(let phase=0;phase<4;phase++){f.set(phase*WINDOW_MS+2);for(const id of peers)f.monitor.progress(id,{...input(id),inputId:`${id}:${phase}`,receipt:{...input(id).receipt,inputId:`${id}:${phase}`},settled:{...input(id).settled,seq:phase+3}},{...proof(id),reference:`${id}:${phase}`});}
 f.monitor.handoff({kind:'fixed-revision-adoption',...proof('x')});f.set(HOUR_MS);f.monitor.end();assert.throws(()=>f.monitor.finish({...cleanup,bots:cleanup.bots.slice(1)}),{code:'HOUR_CLEANUP_PENDING'});
});

test('cleanup time cannot fill an incomplete work hour or inflate its sealed duration', () => {
  const f = fixture(); start(f);
  for (let phase = 0; phase < 4; phase++) { f.set(phase * WINDOW_MS + 1); for (const id of peers) f.monitor.progress(id, input(id, phase + 1), { ...proof(id), reference: `seal:${phase}:${id}` }); }
  f.monitor.handoff({ kind: 'fixed-revision-adoption', ...proof('handoff') });
  f.set(HOUR_MS - 1); assert.throws(() => f.monitor.end(), { code: 'HOUR_TOO_SHORT' });
  f.set(HOUR_MS); f.monitor.end(); f.set(HOUR_MS + 600_000);
  assert.equal(f.monitor.finish(cleanup).durationMs, HOUR_MS);
});
