import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerEventStream, validateWorkerEventPage } from '../src/core/worker-event-stream.js';

const cursor = (stream: ReturnType<typeof createWorkerEventStream>, afterSequence = 0) => ({
  workerInstanceId: stream.workerInstanceId, streamEpoch: stream.streamEpoch, afterSequence,
});

test('events published before or during a suspended read are delivered in one bounded sequence', async () => {
  const stream = createWorkerEventStream();
  stream.publish({ type: 'first' });
  const first = await stream.poll({ ...cursor(stream), maxRecords: 1 });
  assert.deepEqual(first.records.map(row => row.type), ['first']);
  assert.equal(first.nextSequence, 1);
  const waiting = stream.poll({ ...cursor(stream, 1), waitMs: 1000 });
  assert.equal(stream.snapshot().waiters, 1);
  stream.publish({ type: 'second' });
  const second = await waiting;
  assert.equal(second.nextSequence, 2);
  assert.equal(stream.snapshot().waiters, 0);
  assert.deepEqual(validateWorkerEventPage(second, cursor(stream, 1)), second);
});

test('lost response replay produces identical pages and the caller commits the cursor explicitly', async () => {
  const stream = createWorkerEventStream();
  for (let index = 0; index < 5; index++) stream.publish({ type: 'probe', index });
  const input = { ...cursor(stream), maxRecords: 2 };
  const first = stream.read(input);
  assert.deepEqual(stream.read(input), first);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.records.map(row => row.worker_sequence), [1, 2]);
  const next = stream.read({ ...input, afterSequence: first.nextSequence });
  assert.deepEqual(next.records.map(row => row.worker_sequence), [3, 4]);
  assert.throws(() => validateWorkerEventPage(first, { ...input, afterSequence: 2 }), { code: 'EVENT_GAP' });
});

test('history count and byte overflow report a gap without advancing the cursor', () => {
  const stream = createWorkerEventStream({ maxRecords: 2, maxBytes: 1024 });
  stream.publish({ type: 'one' });
  stream.publish({ type: 'two' });
  stream.publish({ type: 'three' });
  assert.equal(stream.snapshot().records, 2);
  const page = stream.read(cursor(stream));
  assert.equal(page.gap, true);
  assert.equal(page.reason, 'history-expired');
  assert.equal(page.nextSequence, 0);
  assert.equal(page.historyFloor, 2);
  assert.throws(() => validateWorkerEventPage(page, cursor(stream)), { code: 'EVENT_GAP' });
  stream.publish({ type: 'large', text: 'x'.repeat(2048) });
  assert.equal(stream.snapshot().bytes, 0);
  assert.equal(stream.read(cursor(stream, 3)).gap, true);
});

test('page limits never split an event and oversized single events fail with a gap', () => {
  const stream = createWorkerEventStream();
  stream.publish({ type: 'large', text: 'x'.repeat(2000) });
  const page = stream.read({ ...cursor(stream), maxBytes: 1024 });
  assert.equal(page.reason, 'record-too-large');
  assert.equal(page.nextSequence, 0);
  assert.equal(page.records.length, 0);
});

test('a new Worker instance, a new stream epoch or a future cursor cannot resume a previous stream', () => {
  const stream = createWorkerEventStream();
  assert.equal(stream.read({ ...cursor(stream), workerInstanceId: 'restarted' }).reason, 'instance-changed');
  assert.equal(stream.read({ ...cursor(stream), streamEpoch: 'restarted' }).reason, 'instance-changed');
  assert.equal(stream.read(cursor(stream, 1)).reason, 'cursor-ahead');
  const page = stream.read(cursor(stream));
  assert.throws(() => validateWorkerEventPage({ ...page, workerInstanceId: 'other' }, cursor(stream)), { code: 'EVENT_GAP' });
});

test('timeout, client disconnect and Worker close remove all event waiters', async () => {
  const stream = createWorkerEventStream();
  const empty = await stream.poll({ ...cursor(stream), waitMs: 2 });
  assert.deepEqual(empty.records, []);
  assert.equal(stream.snapshot().waiters, 0);
  const owner = new AbortController();
  const aborted = assert.rejects(stream.poll({ ...cursor(stream), waitMs: 1000 }, owner.signal));
  assert.equal(stream.snapshot().waiters, 1);
  owner.abort();
  await aborted;
  assert.equal(stream.snapshot().waiters, 0);
  const pending = stream.poll({ ...cursor(stream), waitMs: 1000 });
  stream.close();
  await pending;
  assert.equal(stream.snapshot().waiters, 0);
});

test('the receiver rejects malformed sequence and cursor metadata', () => {
  const stream = createWorkerEventStream();
  stream.publish({ type: 'probe' });
  const page = stream.read(cursor(stream));
  assert.throws(() => validateWorkerEventPage({ ...page, records: [{ ...page.records[0], worker_sequence: 2 }] }, cursor(stream)), { code: 'EVENT_GAP' });
  assert.throws(() => validateWorkerEventPage({ ...page, nextSequence: 10 }, cursor(stream)), { code: 'INVALID_CONTRACT' });
  assert.throws(() => validateWorkerEventPage({ ...page, hasMore: true }, cursor(stream)), { code: 'INVALID_CONTRACT' });
});

test('discarded stdout creates an unrecoverable sequence boundary and repeated reads cannot hide it', () => {
  const stream = createWorkerEventStream();
  stream.publish({ type: 'before' });
  stream.invalidate({ type: 'worker_output_gap', discardedBytes: 4096 });
  stream.publish({ type: 'after' });
  const page = stream.read(cursor(stream, 1));
  assert.equal(page.gap, true);
  assert.equal(page.reason, 'history-expired');
  assert.equal(page.nextSequence, 1);
  assert.equal(page.historyFloor, 3);
});

test('one suspended read bounds the Worker wait queue', async () => {
  const stream = createWorkerEventStream();
  const waiting = stream.poll({ ...cursor(stream), waitMs: 1000 });
  await assert.rejects(stream.poll({ ...cursor(stream), waitMs: 1000 }), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(stream.snapshot().waiters, 1);
  stream.close();
  await waiting;
  assert.equal(stream.snapshot().waiters, 0);
});
