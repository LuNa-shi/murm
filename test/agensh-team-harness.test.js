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
