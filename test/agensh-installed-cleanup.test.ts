import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCleanupBudget } from './fixtures/agensh-deadline.js';
import { closeInstalledForeground } from './fixtures/agensh-installed-cleanup.js';

for (const race of [false, true]) test(
  `pre-Core config failure closes owned fixture without a terminal receipt (${race ? 'during shutdown wait' : 'already observed'})`,
  {
    timeout: 10_000
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'agensh-cli-setup-failure-'));

    t.after(() => rm(directory, {
      recursive: true,
      force: true
    }));

    const marker = join(directory, 'closed');

    await writeFile(join(directory, 'config.mjs'), `
import { writeFile } from 'node:fs/promises';
process.on('message', async message => {
  if (message.type === 'close-facilities') {
    await writeFile(${JSON.stringify(marker)}, 'owned fixture closed');
    process.send({ type: 'facilities-closed', receipt: { cleanup: 'complete' } });
    process.disconnect();
  }
});
process.send({ type: 'setup-entered' });
await new Promise(resolve => setTimeout(resolve, 100));
process.send({ type: 'setup-failed' });
throw Object.assign(new Error('fixture setup rejected'), { code: 'LOCAL_SETUP_FAILED' });
`);

    const child = spawn(
      process.execPath,
      [resolve('dist/scripts/run-environment.js'), '--config', join(directory, 'config.mjs')],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      }
    );

    const messages = [], rows = [];
    let exited = false, stdout = '';
    child.on('message', row => messages.push(row));

    child.on('exit', () => {
      exited = true;
    });

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });

    child.stderr.resume();

    t.after(() => {
      if (child.connected) child.disconnect();

      if (!exited) child.kill('SIGKILL');
    });

    while (!messages.some(row => row.type === (race ? 'setup-entered' : 'setup-failed')))
      await new Promise(resolve => setTimeout(resolve, 5));

    const cleanup = createCleanupBudget(2000);
    t.after(() => cleanup.dispose());

    const result = await closeInstalledForeground({
      child,
      rows,
      messages,
      cleanup,
      isExited: () => exited
    });

    assert.equal(result.terminal, undefined);
    assert.equal(result.facilityCleanup.cleanup, 'complete');
    assert.equal(exited, true);
    assert.equal(await readFile(marker, 'utf8'), 'owned fixture closed');
    assert.equal(stdout, '');
    assert.equal(cleanup.receipt().expired, false);
  }
);
