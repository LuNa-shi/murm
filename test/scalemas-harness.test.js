import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createScaleMASUpstream, scaleMASCommand } from './fixtures/scalemas-upstream.js';
import { completeSimple, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';

test('all six native fixed programs parse and preserve newline bytes without NUL arguments', () => {
  for (let peer = 0; peer < 3; peer++) for (let cycle = 0; cycle < 2; cycle++) {
    const command = scaleMASCommand(peer, cycle); assert.equal(command.includes(String.fromCharCode(0)), false);
    const source = command.split("<<'SCALEMAS_FIXED'\n")[1].split('\nSCALEMAS_FIXED')[0];
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source });
  }
});

test('controlled native harness rejects bad correlation with one nonretryable terminal and counts every rejected arrival', async t => {
  const upstream = await createScaleMASUpstream({ deadlineAt: Date.now() + 5000 }); t.after(() => upstream.close());
  const model = { id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses', baseUrl: upstream.url.replace(/\/responses$/, ''),
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 };
  const failed = await completeSimple(model, { messages: [{ role: 'user', content: 'bad fixed input', timestamp: 0 }] }, { apiKey: 'local-only', maxTokens: 128 });
  assert.equal(failed.stopReason, 'error'); assert.equal(isRetryableAssistantError(failed), false);
  assert.match(failed.errorMessage, /FIXED_SCALEMAS_FAILED/);
  assert.equal(upstream.receipt().arrivals, 1); assert.equal(upstream.receipt().accepted, 0);
});
