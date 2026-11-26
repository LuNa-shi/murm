import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { runPastel } from './pastel-open.ts';
import { task } from './case.ts';
import { auditPastelReceipt } from './pastel-matrix.ts';
import { inputTexts, localUpstream, message, tool, toolOutput } from './local-integration.ts';

const [, , mode, image, duration = '30000', extra] = process.argv;
const durationMs = Number(duration);
assert.ok(!extra && ['subagents', 'taskpool', 'peermesh'].includes(mode) && /^sha256:[a-f0-9]{64}$/.test(image),
  'Usage: node pastel-open-local.ts <subagents|taskpool|peermesh> <worker-image-id> [duration-ms]');
assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 15_000 && durationMs <= 60_000);
const compile = '#!/bin/sh\nset -eu\ninstall -m 0755 pastel.py executable\n';
const parser = 'def color(value):\n    return {"red": "ff0000", "blue": "0000ff"}.get(value, value)\n';
const formatting = 'def format_hex(value):\n    return "#" + value.removeprefix("#").lower()\n';
const main = '#!/usr/bin/env python3\nimport sys\nfrom colors import color\nfrom formatting import format_hex\nfor value in sys.argv[3:]:\n    print(format_hex(color(value)))\n';
const simpleMain = '#!/usr/bin/env python3\nimport sys\nfrom colors import color\nfor value in sys.argv[3:]:\n    print("#" + color(value))\n';
const reference = '/opt/programbench/executable';

const common = `
import json, pathlib, subprocess, base64, os
def cli(service, operation, *arguments, payload=None):
    completed = subprocess.run(['swarm', service, operation, *arguments, *(['--stdin'] if payload is not None else [])],
        input=None if payload is None else json.dumps(payload), text=True, capture_output=True, timeout=20)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)
def bash(*arguments):
    return subprocess.check_output(arguments, text=True, timeout=15).strip()
def save(files):
    for name, content in files.items():
        pathlib.Path(name).write_text(content)
def verify():
    bash('sh','compile.sh')
    assert bash('./executable','format','hex','red','blue') == bash('${reference}','format','hex','red','blue')
    pathlib.Path('executable').unlink()
`;
const command = source => `PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'\n${common}\n${source}\nPY`;
const seen = new Set();
const childSource = { 'PARSER': { 'colors.py': parser }, 'FORMATTER': { 'formatting.py': formatting } };
const childTask = role => 'OPEN_LOCAL_CHILD ' + role + '\n\n' + task;

function subagents(input, number, texts) {
  const child = Object.keys(childSource).find(key => texts.includes(childTask(key)));
  if (child) {
    const referenceResult = toolOutput(input, 'probe');
    if (referenceResult === undefined) return tool('probe', `${reference} format hex red blue`);
    assert.equal(referenceResult.trim(), '#ff0000\n#0000ff');
    return message(number, JSON.stringify({ files: childSource[child], observation: referenceResult.trim() }));
  }
  if (!seen.has('spawn')) {
    assert.ok(texts.some(value => value.startsWith(task + '\n\n')));
    seen.add('spawn');
    const assignments = Object.fromEntries(Object.keys(childSource).map(role => [role, childTask(role)]));
    return tool('delegate', command(`
assignments=json.loads(${JSON.stringify(JSON.stringify(assignments))})
for role, assignment in assignments.items():
    result=cli('agent','spawn','--request-id','child-'+role,payload={'profile':'child','input':assignment,'mode':'followUp'})
    print(result['agent']['id'])
`), 55);
  }
  const children = texts.filter(value => value.startsWith('{"childId"')).map(JSON.parse);
  const published = toolOutput(input, 'publish');
  if (published !== undefined) {
    assert.equal(JSON.parse(published).verified_children, 2);
    return message(number, 'Adopted both child source files and published the tested candidate.');
  }
  if (children.length < 2 || seen.has('publish')) return message(number, 'I will continue when both child results are available.');
  seen.add('publish');
  const files = { 'compile.sh': compile, 'pastel.py': main };
  const refs = [];
  for (const { childId, eventSeq, output } of children) {
    for (const [file, content] of Object.entries(JSON.parse(output).files)) {
      files[file] = content;
      refs.push({ child_id: childId, event_seq: eventSeq, file });
    }
  }
  return tool('publish', command(`
payload=json.loads(${JSON.stringify(JSON.stringify({ files, used_children: refs }))})
save(payload['files'])
verify()
print(json.dumps(cli('candidate','publish','--request-id','verified-candidate',payload=payload)))
`));
}

function taskpool(input, number) {
  const roles = ['parser', 'formatter', 'integrator'];
  if (roles.some(role => toolOutput(input, role) !== undefined)) {
    return message(number, 'Completed the Task and published its source.');
  }
  const role = roles.find(value => !seen.has(value));
  if (!role) return message(number, 'No additional work available.');
  seen.add(role);
  return tool(role, command(`
role='${role}'
tasks=cli('task','list','--state','ready')['tasks']
prefix={'parser':'Implement Pastel color parsing','formatter':'Implement Pastel output formatting','integrator':'Integrate'}[role]
todo=next(row for row in tasks if row['summary'].startswith(prefix))
taken=cli('task','take',todo['task_id'],'--request-id','take')
from datetime import datetime
execution=taken['execution']
lease=(datetime.fromisoformat(execution['execution_deadline']) - datetime.fromisoformat(execution['started_at'])).total_seconds()
assert 0 < lease <= ${durationMs / 1000}, f'Unexpected Task deadline: {lease}s'
used=[]
if role in ('parser','formatter'):
    components={'parser':{'colors.py':${JSON.stringify(parser)}},'formatter':{'formatting.py':${JSON.stringify(formatting)}}}[role]
    save(components)
    files=list(components)
    assert bash('${reference}','format','hex','red','blue') == '#ff0000\\n#0000ff'
else:
    materials=cli('material','list')['materials']
    files=[]
    for producer,path in [('parser','colors.py'),('formatter','formatting.py')]:
        material=next(row for row in materials if row['title']=='Open local '+producer)
        material_id=material['material_id']
        attachment=cli('material','view',payload={'material_id':material_id,'attachment_name':path})['attachment']
        pathlib.Path(path).write_bytes(base64.b64decode(attachment['content_base64'], validate=True))
        used.append(material_id)
        files.append(path)
    save({'pastel.py':${JSON.stringify(main)},'compile.sh':${JSON.stringify(compile)}})
    verify()
    cli('material','consume','--request-id','consume',payload={'material_ids':used,'action':'integration','impact':'Used the acquired parser for named colors in the CLI.'})
    files.extend(['pastel.py','compile.sh'])
title='Open local '+role
attachments=[{'name':path,'content_base64':base64.b64encode(pathlib.Path(path).read_bytes()).decode()} for path in files]
published=cli('material','publish','--request-id','publish',payload={'title':title,'content':{'files':files},'attachments':attachments,'used_material_ids':used})['material']
material_id=published['material_id']
cli('task','link','--request-id','link',payload={'task_id':todo['task_id'],'material_id':material_id,'role':'experience'})
cli('task','finish','--request-id','finish',payload={'outcome':'done','material_ids':[material_id]})
print(material_id)
`), 55);
}

function peermesh(input, number, texts) {
  const role = texts.some(text => text.includes('reusable color-input parsing component')) ? 'a'
    : texts.some(text => text.includes('independent color-output formatting')) ? 'b' : 'c';
  const response = toolOutput(input, `peer-${role}`);
  if (response !== undefined) return message(number, role !== 'c' ? 'Component PR and Board fact published.' :
    JSON.stringify({ adopted_files: ['colors.py', 'formatting.py'], checks: ['Compiled and matched the reference for red and blue.'] }));
  return tool(`peer-${role}`, command(`
role='${role}'
board={'board_id':os.environ['RUN_BOARD']}
repo={'owner':os.environ['RUN_OWNER'],'repo':os.environ['RUN_REPO']}
bash('git','clone',os.environ['RUN_REPOSITORY'],'.')
bash('git','switch','-c',os.environ['WORK_BRANCH'])
facts={'a':'Open local component colors.py provides color(value).','b':'Open local component formatting.py provides format_hex(value).'}
if role in ('a','b'):
    name='colors.py' if role=='a' else 'formatting.py'
    save({name:${JSON.stringify(parser)} if role=='a' else ${JSON.stringify(formatting)}})
    fact=facts[role]
    cli('peermesh-context','board_write','--request-id','fact',payload={**board,'type':'FACT','content':fact,'detail':'Observed the reference named colors.'})
    bash('git','add',name)
else:
    rendered=cli('peermesh-context','board_read',payload=board)['rendered']
    assert all(fact in rendered for fact in facts.values())
    assert pathlib.Path('colors.py').is_file()
    save({'pastel.py':${JSON.stringify(main)},'compile.sh':${JSON.stringify(compile)}})
    verify()
    bash('git','add','pastel.py','compile.sh')
bash('git','commit','-m','Open local contribution '+role)
bash('git','push','-u','origin',os.environ['WORK_BRANCH'])
print(cli('gitea','pull_request_write','--request-id','pr',payload={**repo,'method':'create','title':'Pastel contributor '+role,'head':os.environ['WORK_BRANCH'],'base':'main'})['number'])
`), 55);
}

const driver = { subagents, taskpool, peermesh }[mode];
assert.ok(driver);
const maxRequests = 24;
const maxOutputTokens = 4096;
const maxConcurrent = 3;
const kind = 'scripted_loopback';
const policy = { kind, durationMs, maxRequests, maxConcurrent, maxOutputTokens };
const upstream = await localUpstream((input, number) => driver(input, number, inputTexts(input)), maxRequests, 240_000);
try {
  const { outputDir, receipt } = await runPastel({ ...policy, mode, image,
    upstream: { url: upstream.url }, upstreamKind: kind });
  const audit = await auditPastelReceipt(receipt, policy);
  console.log(JSON.stringify({ run: basename(outputDir), receipt: join(outputDir, 'receipt.json'), audit }));
  assert.equal(upstream.receipt().failure, undefined);
  assert.deepEqual(audit.failures, []);
  assert.equal(audit.verifiedContributors, 2);
  assert.ok(audit.meteredAgents >= 3);
} finally {
  await upstream.close();
}
