import { createAgenshTeam } from '../agensh/team.js';
import { createHourWindow, HOUR_MS, WINDOW_MS } from '../shared/hour-window.js';
import { setTimeout as delay } from 'node:timers/promises';
import { validateHourBudgets, createHourQuotaGate, checkHourLifetime } from './policy.js';

const fail = code => Object.assign(new Error(code), { code });
/** Frozen host workload owns upstream business verification; only actual router
 * records can establish input participation. No synthetic receipt is submitted. */
export async function runAgenshHour({ options, workload, admit, quota, budgets, signal, clock, waitForMs }) {
  if (typeof workload?.phase !== 'function' || typeof admit !== 'function' || typeof quota?.receipt !== 'function' || typeof quota?.close !== 'function') throw fail('HOUR_PREFLIGHT_GATE_MISSING');
  budgets = validateHourBudgets(budgets);
  const checkQuota = createHourQuotaGate(quota, budgets);
  const controller=new AbortController();const life=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let team,monitor,cleanup,result,businessFailure;
  const abort=()=>controller.abort();
  const setupTimer=setTimeout(abort,budgets.setupMs);
  const wait = async ms => {
    const end = (clock ? clock() : performance.now()) + Math.max(0, ms);
    while ((clock ? clock() : performance.now()) < end) {
      const remaining = end - (clock ? clock() : performance.now());
      await (waitForMs ? waitForMs(Math.min(30_000, remaining), life) : delay(Math.min(30_000, remaining), undefined, { signal: life }));
      life.throwIfAborted(); checkQuota();
      if (monitor.elapsed() < HOUR_MS) for (const peer of team.currentPeers().peers) {
        // A's explicit final-window stop is retained as a domain handoff.
        if (peer.key === 'a' && peer.router.accepting === false) continue;
        if (!['idle', 'running'].includes((await team.getBot(peer.botId)).status)) throw fail('HOUR_PEER_UNAVAILABLE');
      }
    }
    life.throwIfAborted();
  };
  try {
    checkQuota();
    team=await createAgenshTeam({...options,peerKeys:['a','b','c','d','e','f','g','h'],signal:life,
      router:{...options.router,workTimeoutMs:budgets.setupMs+HOUR_MS+budgets.cleanupMs,maxBatches:64,maxNudges:0,turnTimeoutMs:budgets.turnMs}});
    const peers=team.currentPeers().peers;
    if(peers.length!==8 || peers.some(peer=>!peer.router.ready || !peer.subscription?.ready))throw fail('HOUR_TEAM_NOT_READY');
    monitor=createHourWindow({runtimeId:team.id,mode:'agensh',botIds:peers.map(peer=>peer.botId),clock});
    // getBot uses the actual public Core get. The lifetime admission port reads
    // the exact Runtime's saved creation evidence and provider observations.
    const authority={id:team.id,get:team.getBot};
    const admission=async workMs=>{
      const receipt=await admit({runtime:authority,outputDir:options.outputDir,botIds:peers.map(peer=>peer.botId),workMs,
        cleanupMs:budgets.cleanupMs,recoveryMs:budgets.recoveryMs,marginMs:budgets.marginMs,signal:life});
      return checkHourLifetime(receipt, { runtimeId: team.id, botIds: peers.map(peer => peer.botId),
        workMs, now: clock ? clock() : performance.now(), controlled: clock !== undefined });
    };
    await admission(budgets.workMs);
    async function phase(index) {
      life.throwIfAborted();checkQuota();
      let timer;
      const phaseTimeoutMs=Math.min(WINDOW_MS-1000,budgets.turnMs*8);
      const verified=await Promise.race([Promise.resolve().then(()=>workload.phase(team,index,{signal:life,timeoutMs:budgets.turnMs})),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('HOUR_PHASE_TIMEOUT'));},phaseTimeoutMs);})]).finally(()=>clearTimeout(timer));
      if(!Array.isArray(verified?.contributions) || verified.contributions.length!==8 || new Set(verified.contributions.map(row=>row.peerKey)).size!==8)throw fail('HOUR_BUSINESS_UNCONFIRMED');
      const view=team.currentPeers().peers;
      for(const row of verified.contributions){
        const peer=view.find(peer=>peer.key===row.peerKey),batch=peer?.router.batches.find(batch=>batch.batchId===row.batchId);
        if(!batch || batch.state!=='completed' || batch.settled?.outcome!=='completed')throw fail('HOUR_INPUT_UNCONFIRMED');
        const input={inputId:batch.inputId,receipt:batch.receipt,settled:batch.settled};
        if(index<0)monitor.baseline(peer.botId,input,row.proof);else monitor.progress(peer.botId,input,row.proof);
      }
      checkQuota();return verified;
    }
    await phase(-1);const lifetime=await admission(budgets.workMs);monitor.open();clearTimeout(setupTimer);
    for(let index=0;index<4;index++){
      await wait(index*WINDOW_MS-monitor.elapsed());
      const verified=await phase(index);
      if(index===3)monitor.handoff(verified.handoff);
    }
    await wait(HOUR_MS-monitor.elapsed());monitor.end();result={lifetime,quota:checkQuota()};
  }catch(error){businessFailure={code:error.code ?? 'HOUR_WORK_FAILED'};}
  finally {
    clearTimeout(setupTimer);controller.abort();
    if(team)cleanup=await team.close({timeoutMs:budgets.cleanupMs}).catch(()=>({cleanup:'pending'}));
    try { await quota.close(); } catch { businessFailure ??= { code: 'HOUR_QUOTA_CLOSE_UNKNOWN' }; }
  }
  if(!businessFailure){try{result={...monitor.finish(cleanup),lifetime:result.lifetime,quota:checkQuota({ final: true })};}catch(error){businessFailure={code:error.code ?? 'HOUR_EVIDENCE_FAILED'};}}
  return {mode:'agensh',runtimeId:team?.id,accepted:false,result,businessFailure,cleanup};
}
