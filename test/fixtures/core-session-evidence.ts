import assert from 'node:assert/strict';

// Observe only native Session filenames after the executor has completed a turn; never read JSONL contents.
export async function sessionEvidence(container, execute, executor = 'pi') {
  const sessionDirectory = executor === 'codex' ? '/workspace/runtime/codex-home/sessions' : '/workspace/runtime/pi-session';
  const result = await execute('docker', ['exec', container, 'find', sessionDirectory,
    '-type', 'f', '-name', '*.jsonl', '-printf', '%f\n'], { timeout: 5000 });
  const files = result.stdout.trim().split('\n').filter(Boolean).sort();
  assert.equal(files.length, 1, 'One persisted native Session is required after a completed turn');
  const pattern = executor === 'codex'
    ? /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/
    : /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/;
  const match = pattern.exec(files[0]);
  assert.ok(match, 'Native Session filename must identify its timestamp and Session ID');
  return { sessionId: match[executor === 'codex' ? 1 : 2], sessionFile: files[0] };
}
