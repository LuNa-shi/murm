import { runScaleMAS } from '../scalemas/index.js';
import { createHourWindow, HOUR_MS, WINDOW_MS } from '../shared/hour-window.js';
import { setTimeout as delay } from 'node:timers/promises';
import { validateHourBudgets, createHourRunModelGate, checkHourLifetime } from './policy.js';
const fail=code=>Object.assign(new Error(code),{code});

/** Actual Environment entry: host observations come from the owned Core input,
 * substrate and stop callbacks, never caller-constructed Core receipts. */
export async function runScaleMASHour({options,workload,admit,quota,budgets,signal,clock,waitForMs}) {
  if(typeof workload?.cycle!=='function' || typeof admit!=='function' || typeof quota?.receipt!=='function' || typeof quota?.close!=='function')throw fail('HOUR_PREFLIGHT_GATE_MISSING');
  budgets = validateHourBudgets(budgets);
  const { check: checkQuota, maxConcurrentInputs } = createHourRunModelGate(quota, budgets);
  const rounds=workload.rounds??5;
  if(!Number.isInteger(rounds)||rounds<5||rounds>7)throw fail('HOUR_ROUND_LIMIT');
  const life=new AbortController(),combined=signal?AbortSignal.any([signal,life.signal]):life.signal;
  const baseline=Promise.withResolvers(),publisherStopped=Promise.withResolvers(),endCheck=Promise.withResolvers();
  // Barriers retain rejection handlers even if a peer fails before awaiting them.
  baseline.promise.catch(()=>{});publisherStopped.promise.catch(()=>{});endCheck.promise.catch(()=>{});
  let monitor,runtime,peerIds,lifetime,publisherStop,opened=false,ended=false;
  const publications={accepted:[],rejected:[]};
  const started=new Set(), arrivedAtEnd=new Set();let baselineCount=0, fatalEvent=false, publisherClosing=false, unsubscribe;
  const timer=setTimeout(()=>life.abort(),budgets.setupMs);
  const pause = async ms => {
    const end = (clock ? clock() : performance.now()) + Math.max(0, ms);
    while ((clock ? clock() : performance.now()) < end) {
      const remaining = end - (clock ? clock() : performance.now());
      await (waitForMs ? waitForMs(Math.min(30_000, remaining), combined) : delay(Math.min(30_000, remaining), undefined, { signal: combined }));
      combined.throwIfAborted(); checkQuota();
      if (monitor.elapsed() < HOUR_MS) for (const botId of peerIds) {
        if (botId === peerIds[0] && publisherStop?.execution === 'stopped') continue;
        if (!['idle', 'running'].includes((await runtime.get(botId)).status)) throw fail('HOUR_PEER_UNAVAILABLE');
      }
    }
    combined.throwIfAborted();
  };
  const reject=error=>{baseline.reject(error);publisherStopped.reject(error);endCheck.reject(error);life.abort();throw error;};
  const admission=async workMs=>{
    const receipt=await admit({runtime,outputDir:options.outputDir,botIds:peerIds,workMs,cleanupMs:budgets.cleanupMs,recoveryMs:budgets.recoveryMs,marginMs:budgets.marginMs,signal:combined});
    return checkHourLifetime(receipt, { runtimeId: runtime.id, botIds: peerIds, workMs,
      now: clock ? clock() : performance.now(), controlled: clock !== undefined });
  };
  let report, closeFailure;
  try {
    checkQuota();
    report=await runScaleMAS({...options,poolSize:6,maxConcurrentInputs,maxRounds:rounds,question:workload.question??options.question,
      questionForCycle: workload.questionForCycle?.bind(workload),
      workTimeoutMs:budgets.setupMs+HOUR_MS+budgets.cleanupMs,turnTimeoutMs:budgets.turnMs,closeTimeoutMs:budgets.cleanupMs,
      async onReady({runtime:core,peerIds:ids,snapshot}) {try{
        runtime=core;peerIds=ids;if(ids.length!==6)throw fail('HOUR_TEAM_NOT_READY');
        monitor=createHourWindow({runtimeId:runtime.id,mode:'scaleMAS',botIds:ids,clock});
        unsubscribe=core.onEvent(event=>{if(!ended && !(event.botId===peerIds[0]&&publisherClosing) &&
          (event.type==='exit'||(event.type==='error'&&event.fatal))){fatalEvent=true;life.abort();}});
        await admission(budgets.workMs);await workload.ready?.({runtimeId:core.id,peerIds:ids,snapshot});
      }catch(error){reject(error);}},
      async beforeCycle(context) {try{
        checkQuota();if(context.round>0){await baseline.promise;await pause(Math.min(context.round-1,3)*WINDOW_MS-monitor.elapsed());if(monitor.elapsed()>=HOUR_MS)throw fail('HOUR_DISPATCH_CLOSED');}
        await workload.beforeCycle?.({...context,publisherStopped:publisherStopped.promise});
      }catch(error){reject(error);}},
      async onCycle(context) {try{
        const verified=await workload.cycle({...context,publisherStop});
        const identity={botId:context.botId,peer:context.peerIndex,phase:context.round,attempt:context.attempt??0,
          requestId:context.requestId,inputId:context.result.inputId,settledSeq:context.result.settled.seq};
        if(verified.correction){
          const timeoutMs=context.round===0 ? budgets.turnMs : Math.floor(Math.min(context.round,4)*WINDOW_MS-monitor.elapsed());
          publications.rejected.push({...identity,address:verified.rejected.reference,sha256:verified.rejected.sha256,code:verified.rejected.code});
          if(timeoutMs<1)throw fail('HOUR_CORRECTION_WINDOW_CLOSED');
          return {...verified,timeoutMs};
        }
        publications.accepted.push({...identity,address:verified.proof.reference,sha256:verified.proof.sha256});
        if(context.round===0){monitor.baseline(context.botId,context.result,verified.proof);baselineCount++;
          if(baselineCount===6){lifetime=await admission(budgets.workMs);monitor.open();opened=true;clearTimeout(timer);baseline.resolve();}}
        else if(context.round<=4)monitor.progress(context.botId,context.result,verified.proof);
        if(verified.handoff)monitor.handoff(verified.handoff);
        checkQuota();
        if(context.round===rounds-1 && context.peerIndex===0) publisherClosing=true;
        if(context.round===rounds-1 && context.peerIndex!==0){
          started.add(context.botId);await pause(HOUR_MS-monitor.elapsed());arrivedAtEnd.add(context.botId);
          if(arrivedAtEnd.size===5){
            const states=await Promise.all(peerIds.slice(1).map(id=>runtime.get(id)));
            if(fatalEvent||states.some(bot=>!['idle','running'].includes(bot.status)))throw fail('HOUR_PEER_UNAVAILABLE');
            checkQuota();monitor.end();ended=true;endCheck.resolve();
          }
          // No survivor can enter planned stop before all have passed the same
          // terminal liveness check and the work clock has been sealed.
          await endCheck.promise;
        }
      }catch(error){reject(error);}},
      async onPeerStop(context){try{
        if(context.peerIndex===0){if(context.receipt.execution!=='stopped')throw fail('HOUR_PUBLISHER_STOP_UNKNOWN');publisherStop=context.receipt;await workload.publisherStopped?.(context);publisherStopped.resolve(context);}
      }catch(error){reject(error);}},
    },combined);
  }finally{unsubscribe?.();clearTimeout(timer);life.abort();try{await quota.close();}catch{closeFailure={code:'HOUR_QUOTA_CLOSE_UNKNOWN'};}}
  let result,businessFailure=report.businessFailure ?? closeFailure,quotaReceipt;
  try { quotaReceipt=quota.receipt(); } catch { businessFailure ??= {code:'HOUR_QUOTA_RECEIPT_UNKNOWN'}; }
  if(!businessFailure){try{if(!opened||started.size!==5||publications.accepted.length!==6*rounds||
      new Set(publications.accepted.map(row=>`${row.botId}:${row.phase}`)).size!==6*rounds)throw fail('HOUR_WINDOW_INCOMPLETE');result={...monitor.finish(report.cleanup),lifetime,quota:checkQuota({ final: true }),publications};}catch(error){businessFailure={code:error.code??'HOUR_EVIDENCE_FAILED'};}}
  return {mode:'scaleMAS',runtimeId:runtime?.id,accepted:false,result,businessFailure,quota:quotaReceipt,publications,cleanup:report.cleanup,reportSaveFailure:report.reportSaveFailure};
}
