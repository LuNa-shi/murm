import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLifetimeProbe } from './fixtures/native-lifetime-probe.js';

for (const failure of ['none', 'spawn', 'admission', 'cleanup', 'deletion', 'upstream', 'requested', 'expiry', 'deadline']) {
  test(`lifetime preparation preserves zero-input and cleanup contract: ${failure}`, async () => {
    let spawned = 0, closed = 0, verified = 0;
    const runtime = {
      async spawn(options) { assert.deepEqual(Object.keys(options).sort(), ['profile', 'requestId']); const id = String(++spawned); if (failure === 'spawn') throw Error(); return { id, status: 'idle' }; },
      async close() { closed++; return { cleanup: failure === 'cleanup' ? 'pending' : 'complete', bots: Array.from({ length: 4 }, () => ({ execution: 'stopped', cleanup: 'complete' })) }; },
      send() { assert.fail('probe must never send'); },
    };
    const result = await runLifetimeProbe({ runtime, bounded: promise => promise,
      admit: async ids => { assert.equal(ids.length, 4); if (failure === 'admission') throw Error(); return { observedAtMs: 0, workDeadlineAtMs: 3600000, stopAtMs: failure === 'deadline' ? 3599999 : 3600000, resources: ids.map(id => ({ id, requestedSeconds: failure === 'requested' ? 3600 : 5100, expiresAtMs: failure === 'expiry' ? 4199999 : 4200000 })) }; },
      verifyDeleted: async () => { verified++; return { complete: failure !== 'deletion' }; },
      upstreamRequests: () => failure === 'upstream' ? 1 : 0 });
    assert.equal(spawned, 4); assert.equal(closed, 1); assert.equal(verified, 1);
    assert.equal(result.status, failure === 'none' ? 'passed' : 'failed');
    assert.equal(result.actualHourVerified, false); assert.equal(result.businessVerified, false);
  });
}
