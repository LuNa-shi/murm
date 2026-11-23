import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePrivateUpstreamHeaders, createAcceptanceDeadline, acceptanceFailed, promptRevocationVerified } from './fixtures/flat-model-acceptance.js';

test('private header parsing exposes only a fixed sanitized error for malformed or invalid secrets', () => {
  for (const input of ['{"authorization":"private-secret"', '{"authorization":{"secret":"private-secret"}}', '["private-secret"]', '{"authorization":"private-secret\\ninvalid"}']) {
    assert.throws(() => parsePrivateUpstreamHeaders(input), error => {
      assert.equal(error.message, 'FLAT_PRIVATE_UPSTREAM_CONFIGURATION_INVALID');
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes('private-secret'), false);
      return true;
    });
  }
  assert.deepEqual(parsePrivateUpstreamHeaders('{"authorization":"Bearer valid"}'), { authorization: 'Bearer valid' });
});

test('deadline remains expired after timer cancellation and after the clock moves backwards', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let called = 0;
  const deadline = createAcceptanceDeadline(1100, () => { called++; });
  assert.equal(deadline.expired(), false);
  t.mock.timers.tick(100);
  deadline.stop();
  t.mock.timers.setTime(1000);
  assert.equal(deadline.expired(), true); assert.equal(called, 1);
});

test('final acceptance fails closed for timeouts, capped extra arrivals, or incomplete evidence', () => {
  const report = { failure: false, requestCap: 2, upstream: { arrivals: 2, forwarded: 2, deadlineReached: false }, localArrivals: 2, localAccepted: 2,
    selectionCompleted: true, usageObserved: true, revocation: { heldBeforeTransition: true, requestTimeoutMs: 60_000, requestAgeAtTransitionMs: 100, domainTransitionAt: 1000, upstreamSocketClosedAt: 1100, socketCloseElapsedMs: 100, settledAt: 1200, settledElapsedMs: 200, outcome: 'failed' }, streamRevoked: true, deniedBeforeUpstream: true, domainState: 'CLOSED', close: [{ cleanup: 'complete' }], runtimeId: 'r', resources: { r: { empty: true } } };
  assert.equal(acceptanceFailed(report, false, false), false);
  assert.equal(acceptanceFailed(report, true, false), true);
  for (const changed of [{ upstream: { ...report.upstream, deadlineReached: true } }, { upstream: { ...report.upstream, arrivals: 3 } }, { localArrivals: 3 }, { localAccepted: 1 }, { failure: true }, { domainState: 'UNBOUND' }, { close: [{ cleanup: 'pending' }] }]) {
    assert.equal(acceptanceFailed({ ...report, ...changed }, false, false), true);
  }
});


test('an elapsed wall clock fails the gate even before a delayed timeout callback runs', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let called = false;
  const deadline = createAcceptanceDeadline(1100, () => { called = true; });
  t.mock.timers.setTime(1101);
  assert.equal(called, false);
  assert.equal(deadline.expired(), true);
  deadline.stop();
  t.mock.timers.setTime(1000);
  assert.equal(deadline.expired(), true);
});


test('revocation evidence requires actual socket closure and matching failed settle within five seconds', () => {
  const evidence = { heldBeforeTransition: true, requestTimeoutMs: 60_000, requestAgeAtTransitionMs: 100, domainTransitionAt: 1000, upstreamSocketClosedAt: 1100, socketCloseElapsedMs: 100, settledAt: 1200, settledElapsedMs: 200, outcome: 'failed' };
  assert.equal(promptRevocationVerified(evidence), true);
  assert.equal(promptRevocationVerified({ ...evidence, socketCloseElapsedMs: 5000, settledElapsedMs: 5000 }), true);
  for (const changed of [{ socketCloseElapsedMs: 60_000 }, { requestAgeAtTransitionMs: 59_900 }, { socketCloseElapsedMs: 5001 }, { settledElapsedMs: 5001 }, { socketCloseElapsedMs: -1 }, { heldBeforeTransition: false }, { upstreamSocketClosedAt: undefined }, { outcome: 'completed' }]) {
    assert.equal(promptRevocationVerified({ ...evidence, ...changed }), false);
  }
});
