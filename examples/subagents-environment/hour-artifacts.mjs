import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
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
      const bytes=await read(join(roots.get(botId),'files',path),maxBytes);
      const sha256=hash(bytes);
      if (bytes.length!==row.bytes || sha256!==row.sha256 || expected!==undefined && bytes.toString('utf8').trim()!==expected.trim()) throw invalid();
      return { botId,path,bytes:bytes.length,sha256,content:bytes.toString('utf8') };
    }
    const children=[],parents=[];
    for (const [stage,entry] of stages.entries()) {
      if (entry.stage!==stage || entry.children.length!==3) throw invalid();
      const parent=await content(parentId,`hour-results/stage-${stage}.json`,entry.parent.settled.output);
      const {content: parentContent, ...parentProof}=parent; parents.push(parentProof);
      for (const [peer,childId] of childIds.entries()) {
        const delivery=entry.children.find(row=>row.result.childId===childId);
        if (!delivery) throw invalid();
        const delivered=await content(childId,`hour-results/stage-${stage}.json`,delivery.result.output);
        const value=JSON.parse(delivered.content);
        if (value.stage!==stage || value.child!==peer || !value.programming) throw invalid();
        const digests=Object.hasOwn(value.programming,'sourceSha256');
        const source=await content(childId,digests?`hour-program-${stage}.py`:`hour-results/stage-${stage}.py`);
        const stdout=await content(childId,digests?`hour-program-${stage}.stdout.json`:`hour-results/stage-${stage}.stdout.json`);
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
