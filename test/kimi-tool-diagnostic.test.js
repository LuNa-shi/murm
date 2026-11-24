import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyToolDiagnostic, verifyDiagnosticBounds, diagnosticInput, diagnosticFilename, diagnosticMarker } from './fixtures/kimi-tool-diagnostic.js';
const compatible = () => ({ fileVerified: true, result: { kind: 'completed', outcome: 'completed' }, receipt: { forwarded: 2, bashReturned: true, rejectedArrivals: 0, deadlineReached: false,
  requests: [{ status: 'complete' }, { status: 'complete', terminal: 'response.completed', geometry: { functionCalls: 1, functionCallOutputs: 1, callIdsMatched: true } }] } });
test('diagnostic distinguishes actual compatible continuation, rejected continuation and uninformative observations', () => {
  assert.deepEqual(classifyToolDiagnostic(compatible()), { status: 'compatible', geometryAvailable: true });
  const rejected = compatible(); rejected.result = { kind: 'failed' }; rejected.receipt.failure = { number: 2 };
  rejected.receipt.requests[1] = { status: 'rejected', statusCode: 400, rejection: { code: 'invalid_request_error' }, geometry: { functionCalls: 1, functionCallOutputs: 1, callIdsMatched: true } };
  rejected.receipt.rejectedArrivals = 3; // Locally fenced gateway retries cannot erase the observed provider 400.
  assert.deepEqual(classifyToolDiagnostic(rejected), { status: 'provider_rejected', geometryAvailable: true, rejection: { code: 'invalid_request_error' } });
  for (const alter of [x => { x.receipt.forwarded = 1; }, x => { x.receipt.bashReturned = false; }, x => { x.fileVerified = false; }, x => { x.receipt.deadlineReached = true; }, x => { x.receipt.rejectedArrivals = 1; }, x => { x.result.outcome = 'failed'; }, x => { delete x.receipt.requests[1].geometry; }, x => { x.receipt.requests[1].geometry.callIdsMatched = false; }, x => { x.receipt.requests[1].geometry.functionCallOutputs = 2; }]) {
    const value = compatible(); alter(value); assert.equal(classifyToolDiagnostic(value).status, 'uninformative');
  }
  assert.ok(diagnosticInput.includes(diagnosticFilename) && diagnosticInput.includes(diagnosticMarker) && diagnosticInput.includes('exactly one Bash'));
});

test('diagnostic hard bounds include actual usage and serialized input reservations', () => {
  const value = { maxRequests: 2, maxConcurrent: 1, maxOutputTokens: 512, maxAggregateOutputTokens: 1024, maxInputBytes: 131072, maxAggregateInputBytes: 262144, forwarded: 2, peakConcurrent: 1,
    reservedOutputTokens: 1024, reservedInputBytes: 200, requests: [{ maxOutputTokens: 512, inputBytes: 100, status: 'complete', usage: { inputTokens: 10, outputTokens: 20 } }, { maxOutputTokens: 512, inputBytes: 100, status: 'rejected' }] };
  assert.equal(verifyDiagnosticBounds(value), true);
  for (const mutate of [x => { x.peakConcurrent = 2; }, x => { x.requests[0].usage.outputTokens = 513; }, x => { x.reservedInputBytes++; }, x => { x.requests[0].usage = undefined; }]) {
    const altered = structuredClone(value); mutate(altered); assert.equal(verifyDiagnosticBounds(altered), false);
  }
});
