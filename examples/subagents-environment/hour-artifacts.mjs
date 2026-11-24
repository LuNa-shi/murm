import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { readSubagentsStageResult } from './stages.mjs';
const invalid = () => Object.assign(new Error('SUBAGENTS_ARCHIVE_INVALID'), { code: 'SUBAGENTS_ARCHIVE_INVALID' });
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,127}$/.test(value);
async function read(path, maxBytes) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw invalid();
    return await file.readFile();
  } finally { await file.close(); }
}

/** Verify actual child inputs and parent forwarding inputs as separate facts. */
export async function verifySubagentsInputs({ outputDir, runtimeId, parentId, childIds, stages }) {
  const fail = () => Object.assign(new Error('SUBAGENTS_INPUT_EVIDENCE_INVALID'), { code: 'SUBAGENTS_INPUT_EVIDENCE_INVALID' });
  function one(rows) {
    if (rows.length !== 1) throw fail();
    return rows[0];
  }
  try {
    if (!identity(runtimeId) || !identity(parentId) || childIds.length !== 3 || !childIds.every(identity) ||
        new Set([parentId, ...childIds]).size !== 4 || stages.length !== 4) throw fail();
    const directory = join(outputDir, runtimeId);
    if (!(await lstat(directory)).isDirectory()) throw fail();
    const bytes = await read(join(directory, 'evidence.jsonl'), 16 * 1024 ** 2);
    const rows = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    if (rows.some((row, index) => row.runtimeId !== runtimeId || row.seq !== index + 1)) throw fail();
    const inputs = rows.filter(row => row.type === 'input');
    const settled = rows.filter(row => row.type === 'event' && row.event?.type === 'settled' && row.event.outcome === 'completed');
    const completed = (botId, seq) => one(settled.filter(row => row.botId === botId && row.event.seq === seq));
    const hostDispatch = (inputId, requestId) => one(inputs.filter(row => row.inputId === inputId && row.requestId === requestId &&
      row.botId === parentId && row.source === 'host' && row.mode === 'followUp' && row.state === 'dispatched'));
    const accepted = dispatch => one(inputs.filter(row => row.state === 'accepted' && row.seq > dispatch.seq &&
      row.inputId === dispatch.inputId && row.requestId === dispatch.requestId && row.botId === dispatch.botId &&
      row.source === dispatch.source && row.mode === dispatch.mode));
    const identities = new Set();
    return stages.flatMap((group, stage) => {
      if (group.stage !== stage || group.children.length !== childIds.length) throw fail();
      const stageInput = hostDispatch(group.parent.receipt.inputId, `stage-${stage}`);
      const stageSettled = completed(parentId, group.parent.settled.seq);
      if (accepted(stageInput).disposition !== 'started' || stageInput.seq >= stageSettled.seq) throw fail();
      return childIds.map(botId => {
        const child = one(group.children.filter(row => row.result.childId === botId));
        const childSettled = completed(botId, child.result.eventSeq);
        const dispatch = one(inputs.filter(row => row.state === 'dispatched' && row.source === `bot:${parentId}` &&
          row.botId === botId && row.seq > stageInput.seq && row.seq < stageSettled.seq));
        const forwarded = hostDispatch(child.receipt.inputId, `child-result:${botId}:${child.result.eventSeq}`);
        const admission = accepted(dispatch);
        accepted(forwarded);
        if (dispatch.mode !== 'followUp' || admission.disposition !== 'started' || !identity(dispatch.inputId) ||
            identities.has(dispatch.inputId) || dispatch.seq >= childSettled.seq || childSettled.seq >= forwarded.seq ||
            forwarded.seq >= stageSettled.seq) throw fail();
        identities.add(dispatch.inputId);
        return { stage, botId, inputId: dispatch.inputId, forwardedToParentInputId: forwarded.inputId };
      });
    });
  } catch { throw fail(); }
}

/** Reads only this Runtime's four required exports. Never executes supplied code. */
export async function verifySubagentsArchives({ outputDir, runtimeId, parentId, childIds, stages, maxBytes, programming }) {
  if (!identity(runtimeId) || !identity(parentId) || !Array.isArray(childIds) || childIds.length !== 3 || new Set([parentId,...childIds]).size !== 4 || !childIds.every(identity) || !Array.isArray(stages) || stages.length !== 4 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || typeof programming?.verify !== 'function') throw invalid();
  try {
    const manifests = new Map(); const roots = new Map();
    for (const botId of [parentId,...childIds]) {
      const root = join(outputDir,runtimeId,botId,'artifacts');
      for (const path of [join(outputDir,runtimeId),join(outputDir,runtimeId,botId),root,join(root,'files'),join(root,'files','hour-results')]) if (!(await lstat(path)).isDirectory()) throw invalid();
      const manifest = JSON.parse(await read(join(root,'manifest.json'), 1024*1024));
      if (manifest.version !== 1 || manifest.botId !== botId || manifest.collect?.required !== true || manifest.collect.includeGit !== false || !Number.isSafeInteger(manifest.collect.maxBytes) || manifest.collect.maxBytes<1 || manifest.collect.maxBytes > maxBytes || !manifest.collect.paths.some(path=>path==='hour-results'||path==='.') || !Array.isArray(manifest.files) || manifest.files.some(row=>typeof row.path!=='string'||row.path.startsWith('/')||row.path.split('/').some(part=>!part||part==='.'||part==='..')||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^[a-f0-9]{64}$/.test(row.sha256??'')) || new Set(manifest.files.map(row=>row.path)).size !== manifest.files.length || manifest.files.reduce((sum,row)=>sum+row.bytes,0)>maxBytes) throw invalid();
      manifests.set(botId,manifest); roots.set(botId,root);
    }
    async function content(botId,path,expected) {
      const row=manifests.get(botId).files.find(row=>row.path===path);
      if (!row || !Number.isSafeInteger(row.bytes) || row.bytes<0 || row.bytes>maxBytes) throw invalid();
      let directory=join(roots.get(botId),'files');
      for (const name of path.split('/').slice(0,-1)) {
        directory=join(directory,name);
        if (!(await lstat(directory)).isDirectory()) throw invalid();
      }
      const bytes=await read(join(roots.get(botId),'files',path),maxBytes);
      const sha256=hash(bytes);
      if (bytes.length!==row.bytes || sha256!==row.sha256 || expected!==undefined && bytes.toString('utf8').trim()!==expected.trim()) throw invalid();
      return { botId,path,bytes:bytes.length,sha256,content:bytes.toString('utf8') };
    }
    const children=[],parents=[];
    for (const [stage,entry] of stages.entries()) {
      if (entry.stage!==stage || entry.children.length!==3) throw invalid();
      const parentResult=readSubagentsStageResult(entry.parent.settled.output);
      const parent=await content(parentId,`hour-results/stage-${stage}.json`,parentResult.payload);
      const {content: parentContent, ...parentProof}=parent; parents.push(parentProof);
      for (const [peer,childId] of childIds.entries()) {
        const delivery=entry.children.find(row=>row.result.childId===childId);
        if (!delivery) throw invalid();
        const {payload,value}=readSubagentsStageResult(delivery.result.output);
        const delivered=await content(childId,`hour-results/stage-${stage}.json`,payload);
        if (value.stage!==stage || value.child!==peer || !value.programming) throw invalid();
        const digests=Object.hasOwn(value.programming,'sourceSha256');
        let sourcePath=`hour-results/stage-${stage}.py`, stdoutPath=`hour-results/stage-${stage}.stdout.json`;
        if (digests) {
          const paths = manifests.get(childId).files.map(row => row.path);
          const sources = paths.filter(path => posix.basename(path) === `hour-program-${stage}.py`);
          const outputs = paths.filter(path => posix.basename(path) === `hour-program-${stage}.stdout.json`);
          if (sources.length !== 1 || outputs.length !== 1 || posix.dirname(sources[0]) !== posix.dirname(outputs[0])) throw invalid();
          [sourcePath] = sources;
          [stdoutPath] = outputs;
        }
        const source=await content(childId,sourcePath);
        const stdout=await content(childId,stdoutPath);
        const answers=JSON.parse(stdout.content);
        if(digests){
          if(source.sha256!==value.programming.sourceSha256 || hash(JSON.stringify(answers))!==value.programming.answersSha256)throw invalid();
        }else if(typeof value.programming.source!=='string'||!value.programming.source.trim()||source.content!==value.programming.source||JSON.stringify(answers)!==JSON.stringify(value.programming.answers))throw invalid();
        let timer;
        try {
          if (await Promise.race([Promise.resolve().then(()=>programming.verify({peer,stage,submission:value.programming})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(invalid()),5000);})])!==true) throw invalid();
        } finally { clearTimeout(timer); }
        children.push({stage,childId,eventSeq:delivery.result.eventSeq,files:[delivered,source,stdout].map(({content,...proof})=>proof)});
      }
    }
    return { children,parents };
  } catch { throw invalid(); }
}
