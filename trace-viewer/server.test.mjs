import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('installed CLI serves read-only Run evidence and resumes a live stream', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'murm-trace-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, 'fixture');
  await mkdir(run);
  await writeFile(join(run, 'runtime.json'), JSON.stringify({
    runtimeId: 'fixture', status: 'open', config: { schemaVersion: 1 },
  }));
  const ledger = join(run, 'evidence.jsonl');
  const row = (seq) => JSON.stringify({
    seq, at: '2026-11-25T12:00:00.000Z', runtimeId: 'fixture', type: 'ready', agentId: 'root',
  });
  await writeFile(ledger, row(1) + '\n');

  const launch = async () => {
    const cli = spawn(process.execPath, [
      new URL('./murm.mjs', import.meta.url).pathname, 'trace', '--root', root, '--port', '0',
    ]);
    const exited = once(cli, 'exit');
    const stop = async () => {
      if (cli.exitCode !== null || cli.signalCode !== null) return;
      cli.kill();
      await exited;
    };
    t.after(stop);
    const url = await Promise.race([
      once(cli.stdout, 'data').then(([chunk]) => chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]),
      exited.then(async ([code]) => {
        const errors = [];
        for await (const chunk of cli.stderr) errors.push(chunk);
        throw new Error('Viewer exited (' + code + ') ' + Buffer.concat(errors).toString());
      }),
    ]);
    assert.ok(url);
    return { url, stop };
  };

  const { url, stop } = await launch();
  const listing = await fetch(url + '/api/runs');
  assert.equal(listing.status, 200);
  const { runs } = await listing.json();
  assert.equal(runs.length, 1);
  const api = '/api/runs/' + encodeURIComponent(runs[0].id);
  assert.equal((await fetch(url + api, { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + api, { headers: { origin: 'https://other.example' } })).status, 403);
  assert.ok((await fetch(url + api + '/files?path=..%2Foutside')).status >= 400);
  const page = await (await fetch(url + api + '/events')).json();
  assert.equal(page.events.length, 1);
  const record = await fetch(url + api + '/records/' + encodeURIComponent(page.events[0].id));
  assert.equal(record.status, 200);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(url + api + '/live?cursor=' + encodeURIComponent(page.cursor), { signal: controller.signal });
  await appendFile(ledger, row(2));
  assert.equal((await (await fetch(url + api + '/events')).json()).events.length, 1);
  await appendFile(ledger, '\n');
  const body = stream.body.getReader();
  const decoder = new TextDecoder();
  let chunk = '';
  while (!chunk.includes('event: trace')) {
    const next = await body.read();
    assert.equal(next.done, false);
    chunk += decoder.decode(next.value, { stream: true });
  }
  const cursor = chunk.match(/^id: (.+)$/m)?.[1];
  assert.ok(cursor);
  const live = JSON.parse(chunk.match(/^data: (.+)$/m)[1]);
  assert.equal(live.events.length, 1);
  assert.notEqual(live.events[0].id, page.events[0].id);
  controller.abort();
  await stop();

  const restarted = await launch();
  await appendFile(ledger, row(4) + '\n');
  const resumed = await fetch(restarted.url + api + '/live?cursor=' + encodeURIComponent(page.cursor), {
    headers: { 'Last-Event-ID': cursor },
    signal: AbortSignal.timeout(4000),
  });
  const resumedBody = resumed.body.getReader();
  const decoder2 = new TextDecoder();
  let resumedChunk = '';
  while (!resumedChunk.includes('event: trace')) {
    const next = await resumedBody.read();
    assert.equal(next.done, false);
    resumedChunk += decoder2.decode(next.value, { stream: true });
  }
  const resumedPage = JSON.parse(resumedChunk.match(/^data: (.+)$/m)[1]);
  assert.ok(resumedPage.events.length >= 1);
  assert.ok(resumedPage.events.every((event) => event.id !== live.events[0].id));
  await resumedBody.cancel();
});
