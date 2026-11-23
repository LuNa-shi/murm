import assert from 'node:assert/strict';

// Observe only native Session filenames after Pi has completed a turn; never read JSONL contents.
export async function sessionEvidence(container, execute) {
  const result = await execute('docker', ['exec', container, 'find', '/workspace/runtime/pi-session',
    '-type', 'f', '-name', '*.jsonl', '-printf', '%f\n'], { timeout: 5000 });
  const files = result.stdout.trim().split('\n').filter(Boolean).sort();
  assert.equal(files.length, 1, 'One persisted native Pi Session is required after a completed turn');
  const match = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/.exec(files[0]);
  assert.ok(match, 'Native Pi Session filename must identify its timestamp and Session ID');
  return { sessionId: match[2], sessionFile: files[0] };
}
