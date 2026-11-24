import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySubagentsArchives } from '../examples/subagents-environment/hour-artifacts.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

test('required archives bind all twelve actual programs, stdout and original child delivery bytes', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'subagents-hour-archives-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtimeId = 'runtime'; const childIds = ['a','b','c']; const stages = [];
  const artifacts = new Map(childIds.concat('parent').map(id => [id, []]));
  for (let stage = 0; stage < 4; stage++) {
    const children = childIds.map((childId, index) => {
      const programming = { source: `print(${stage + index})\n`, answers: [stage + index] };
      const output = JSON.stringify({ stage, child: index, programming });
      for (const [suffix, bytes] of [['json',output],['py',programming.source],['stdout.json',JSON.stringify(programming.answers)]]) artifacts.get(childId).push({ path: `hour-results/stage-${stage}.${suffix}`, bytes });
      return { result: { childId, eventSeq: stage+1, output } };
    });
    const parentOutput = JSON.stringify({ stage, summary: 'All programs adopted.', conclusions: stages.flatMap(row=>row.children).concat(children).map(row=>({childId:row.result.childId,eventSeq:row.result.eventSeq,quote:row.result.output})) });
    artifacts.get('parent').push({ path: `hour-results/stage-${stage}.json`, bytes: parentOutput });
    stages.push({stage,children,parent:{settled:{output:parentOutput}}});
  }
  for (const [botId, files] of artifacts) {
    const root = join(outputDir,runtimeId,botId,'artifacts'); await mkdir(join(root,'files','hour-results'),{recursive:true});
    const manifest = {version:1,botId,collect:{paths:['hour-results'],includeGit:false,required:true,maxBytes:1048576},files:[]};
    for (const file of files) { await writeFile(join(root,'files',file.path),file.bytes); manifest.files.push({path:file.path,bytes:Buffer.byteLength(file.bytes),sha256:hash(file.bytes)}); }
    await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
  }
  const verified = [];
  const options = { outputDir,runtimeId,parentId:'parent',childIds,stages,maxBytes:1048576,programming:{async verify(value){verified.push(value);return value.submission.answers[0]===value.peer+value.stage;}} };
  const receipt = await verifySubagentsArchives(options);
  assert.equal(receipt.children.length,12); assert.equal(receipt.parents.length,4); assert.equal(verified.length,12);
  await writeFile(join(outputDir,runtimeId,'b','artifacts','files','hour-results','stage-3.py'),'changed source');
  await assert.rejects(verifySubagentsArchives(options),{code:'SUBAGENTS_ARCHIVE_INVALID'});
});
