import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSimple, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { leadHelperCommand, createLeadHelperUpstream, adjustedDirection } from './fixtures/lead-helper-upstream.js';
import { execute } from './fixtures/notes-installed-package.js';
const user = value => ({ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(value) }] });
const modelFor = upstream => ({ id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses', baseUrl: upstream.url.replace(/\/responses$/, ''), reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 512 });

test('native programs parse and wrong-role input gets terminal nonretryable Pi failure once', async t => {
  for (const kind of ['initialize', 'helper-initial', 'user-and-feedback', 'helper-followup']) await execute('python3', ['-c', 'import ast,sys;ast.parse(sys.argv[1])', leadHelperCommand(kind).split("<<'LEAD_HELPER'\n")[1].split('\nLEAD_HELPER')[0]]);
  const upstream = await createLeadHelperUpstream(); t.after(() => upstream.close());
  const result = await completeSimple(modelFor(upstream), { messages: [{ role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ type: 'initialize' }) }], api: 'openai-responses', provider: 'kimi_proxy', model: 'k3', stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 }] }, { apiKey: 'local-only', maxTokens: 512 });
  assert.equal(result.stopReason, 'error'); assert.equal(isRetryableAssistantError(result), false); assert.equal(upstream.receipt().arrivals, 1);
});

async function transcript(t, mutate) {
  const phases = []; const upstream = await createLeadHelperUpstream({ observeSessions: async phase => phases.push(phase) }); t.after(() => upstream.close());
  const inputs = { lead: [], helper1: [], helper2: [] };
  let ordinal = 0;
  const round = async (role, kind) => {
    const payload = { type: kind, ...(kind === 'initialize' ? { helpers: { helper1: 'one', helper2: 'two' } } : {}), ...(kind === 'user-and-feedback' ? { supplement: adjustedDirection } : {}) };
    inputs[role].push(user(payload));
    const post = async input => { const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) }); return response.text(); };
    assert.doesNotMatch(await post(inputs[role]), /response.failed/); const call_id = `lead_helper_${++ordinal}`;
    const followup = kind === 'user-and-feedback' || kind === 'helper-followup';
    const row = { role, kind, botId: role, cwd: '/workspace/project', process: { pid: 20, starttime: '123' }, ...(followup ? { sessionFile: role + '.jsonl' } : {}) };
    if (role === 'lead') Object.assign(row, followup ? { userInputId: 'lead-adjust', feedbackIds: [1, 2] } : { forgedOwnerDenied: true, leadClaimDenied: true });
    else Object.assign(row, { leadOperationDenied: true, otherOwnerDenied: true, delivery: { verified: true, commit: 'a'.repeat(40), path: `${role}${followup ? '-next' : ''}.txt` } });
    if (mutate && role === 'helper2' && followup) mutate(row);
    inputs[role].push({ type: 'function_call_output', call_id, output: JSON.stringify(row) });
    const result = await post(inputs[role]); ordinal++;
    if (mutate && role === 'helper2' && followup) assert.match(result, /response.failed/); else assert.doesNotMatch(result, /response.failed/);
  };
  for (const [role, kind] of [['lead', 'initialize'], ['helper1', 'helper-initial'], ['helper2', 'helper-initial'], ['lead', 'user-and-feedback'], ['helper1', 'helper-followup'], ['helper2', 'helper-followup']]) await round(role, kind);
  if (!mutate) { assert.deepEqual(phases, ['before-adjust', 'final']); assert.equal(upstream.receipt().accepted, 12); assert.equal(upstream.receipt().evidence.length, 6); }
  else { assert.equal(upstream.receipt().accepted, 11); assert.deepEqual(phases, ['before-adjust']); }
}
test('fixed twelve-response native transcript validates all roles and original-helper continuity', t => transcript(t));
for (const [name, mutate] of Object.entries({ 'replacement identity': row => { row.botId = 'replacement'; }, 'changed process': row => { row.process.starttime = '999'; }, 'missing session': row => { delete row.sessionFile; }, 'unverified proof': row => { row.delivery.verified = false; }, 'wrong artifact': row => { row.delivery.path = 'other.txt'; } })) test(`native evidence rejects ${name} before final success`, t => transcript(t, mutate));

test('all arrivals are counted before parse and first failure remains sticky', async t => {
  let failures = 0; const upstream = await createLeadHelperUpstream({ onFailure: () => failures++ }); t.after(() => upstream.close());
  const response = await fetch(upstream.url, { method: 'POST', body: 'not-json' }); assert.match(await response.text(), /response.failed/);
  const second = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [user({ type: 'initialize' })] }) }); assert.match(await second.text(), /response.failed/);
  assert.equal(upstream.receipt().arrivals, 2); assert.equal(upstream.receipt().accepted, 0); assert.equal(failures, 1); assert.equal(upstream.receipt().failure.ordinal, 1);
});
