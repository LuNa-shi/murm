import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createTeamUpstream, teamCommand, teamInputs, teamFact } from './fixtures/agensh-team-upstream.js';

const names = { a: 'peer-fixed-a', b: 'peer-fixed-b' };
const stages = ['a-initial', 'b-initial', 'a-contribution', 'b-contribution', 'a-user'];
const batch = index => ({ batchId: `batch-${index}`, eventId: `event-${index}`, source: index < 2 ? 'kickoff' : index === 4 ? 'gitea' : 'mattermost', text: teamInputs[index], context: teamFact });
test('each fixed native command parses without allocating facilities or invoking a model', () => {
  for (let index = 0; index < stages.length; index++) {
    const script = teamCommand(stages[index], batch(index), names).split('\n').slice(1, -1).join('\n');
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: script, timeout: 5000 });
  }
});

test('ten fixed arrivals require their current batch tool result and the eleventh is terminal', async t => {
  const upstream = await createTeamUpstream({ deadlineAt: Date.now() + 5000, peerNames: names }); t.after(() => upstream.close());
  for (let index = 0; index < stages.length; index++) for (const tool of [false, true]) {
    const current = batch(index); const result = { stage: stages[index], event: current, pi: { pid: 1, start: '123' }, head: 'a'.repeat(40), prNumber: 1, claimCount: 2, adopted: true, binary: 'AP9BCg==', privateHead: 'b'.repeat(40), publicHead: 'a'.repeat(40) };
    const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', max_output_tokens: 128, input: [{ role: 'user', content: `instruction\n${JSON.stringify(current)}` }, ...(tool ? [{ type: 'function_call_output', call_id: `team_${stages[index]}`, output: JSON.stringify(result) }] : [])] }) });
    assert.match(await response.text(), /response.completed/);
  }
  const extra = await fetch(upstream.url, { method: 'POST', body: 'invalid' }); assert.match(await extra.text(), /response.failed/);
  assert.equal(upstream.receipt().arrivals, 11); assert.equal(upstream.receipt().accepted, 10);
});

test('mismatched current tool event cannot certify another native batch', async t => {
  const upstream = await createTeamUpstream({ deadlineAt: Date.now() + 5000, peerNames: names }); t.after(() => upstream.close());
  const current = batch(0); const input = [{ role: 'user', content: `instruction\n${JSON.stringify(current)}` }];
  await (await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', max_output_tokens: 128, input }) })).text();
  const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', max_output_tokens: 128, input: [...input, { type: 'function_call_output', call_id: 'team_a-initial', output: JSON.stringify({ stage: 'a-initial', event: { ...current, eventId: 'other' }, pi: { pid: 1, start: '123' } }) }] }) });
  assert.match(await response.text(), /response.failed/); assert.equal(upstream.receipt().accepted, 1);
});

test('eight-peer fixture requires all twelve current native batch results within twenty-four arrivals', async t => {
  const peerKeys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const upstream = await createTeamUpstream({ deadlineAt: Date.now() + 10_000, peerNames: names, peerKeys });
  t.after(() => upstream.close());
  const extra = peerKeys.slice(2).map(key => ({ stage: `${key}-initial`, text: `T15_KICK_${key.toUpperCase()}`, source: 'kickoff' }));
  const rows = [...stages.map((stage, index) => ({ stage, ...batch(index) })), ...extra, { stage: 'h-contribution', text: 'T15_ADOPT_H', source: 'gitea' }];
  for (const [index, row] of rows.entries()) {
    const current = { batchId: `eight-${index}`, eventId: `event-${index}`, text: row.text, source: row.source, context: teamFact };
    const input = [{ role: 'user', content: `instruction\n${JSON.stringify(current)}` }];
    const send = async () => (await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', max_output_tokens: 128, input }) })).text();
    const first = await send(); assert.match(first, /function_call/); assert.match(first, /response.completed/);
    const argumentsText = JSON.parse(first.split('\n').find(line => line.startsWith('data: ') && line.includes('response.output_item.done')).slice(6)).item.arguments;
    const script = JSON.parse(argumentsText).command.split('\n').slice(1, -1).join('\n');
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: script, timeout: 5000 });
    const result = { stage: row.stage, event: current, pi: { pid: 1, start: '123' }, head: 'a'.repeat(40), prNumber: 1, claimCount: 2, adopted: true, binary: 'AP9BCg==', privateHead: 'b'.repeat(40), publicHead: 'a'.repeat(40) };
    input.push({ type: 'function_call_output', call_id: `team_${row.stage}`, output: JSON.stringify(result) });
    assert.match(await send(), /response.completed/);
  }
  assert.equal(upstream.receipt().accepted, 24);
  assert.equal(upstream.receipt().evidence.length, 12);
  const overflow = await fetch(upstream.url, { method: 'POST', body: '{}' });
  assert.match(await overflow.text(), /response.failed/);
  assert.equal(upstream.receipt().arrivals, 25);
});
