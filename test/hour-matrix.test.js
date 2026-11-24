import assert from 'node:assert/strict';
import test from 'node:test';
import { runHourMatrix } from '../src/environments/endurance/matrix.js';

test('matrix reports pending Flat and missing real mode gates without allocating or claiming a pass', async () => {
  const report = await runHourMatrix({ configurations: {} });
  assert.equal(report.accepted, false);
  assert.deepEqual(report.results.map(row => row.preflightFailure.code), ['FLAT_HOUR_WORKLOAD_PENDING', 'HOUR_CONFIGURATION_MISSING', 'HOUR_CONFIGURATION_MISSING']);
});
test('a failed configured preflight closes the exact sole owner before ending the serial matrix', async () => {
  let closed = false, later = false;
  const report = await runHourMatrix({ modes: ['agensh', 'scaleMAS'], configurations: {
    agensh: async ({ peerCount, quotas }) => { assert.equal(peerCount, 8); assert.equal(quotas.maxRequests, 96); return {
      options: {}, workload: {}, quota: { receipt: () => ({ closed, forwarded:7, outstandingOutputTokens:1024, requests:[{status:'transport_failed'}] }), close: async () => { closed = true; } },
    }; },
    scaleMAS: async () => { later = true; },
  } });
  assert.equal(report.accepted, false); assert.equal(closed, true); assert.equal(later, false);
  assert.equal(report.results[0].preflightFailure.code, 'HOUR_PREFLIGHT_GATE_MISSING');
  assert.equal(report.results[0].ownerClosed, true);
  assert.equal(report.results[0].quota.forwarded,7); assert.equal(report.results[0].quota.outstandingOutputTokens,1024);
  assert.equal(report.results[0].quota.requests[0].status,'transport_failed');
});
