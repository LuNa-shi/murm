import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import test from 'node:test';
import { preparePackageArchive } from './fixtures/notes-installed-package.js';

const exec = promisify(execFile);

test('installed murm CLI serves read-only Run evidence and resumes a live stream', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'murm-trace-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const consumer = join(root, 'consumer');
  await mkdir(consumer);
  const { archive } = await preparePackageArchive(root);
  const archiveListing = await exec('tar', ['-tzf', archive], { maxBuffer: 4 * 1024 ** 2 });
  const files = archiveListing.stdout.trim().split('\n');
  assert.ok(files.includes('package/dist/src/trace-viewer/public/index.html'));
  assert.ok(files.includes('package/dist/src/trace-viewer/public/app.js'));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await exec('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive], {
    cwd: consumer,
    timeout: 60_000,
    maxBuffer: 4 * 1024 ** 2,
  });
  const help = await exec(join(consumer, 'node_modules/.bin/murm'), ['trace', '--help'], { cwd: consumer });
  assert.match(help.stdout, /murm trace/);
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
    const cli = spawn(join(consumer, 'node_modules/.bin/murm'), [
      'trace', '--root', root, '--port', '0',
    ], { cwd: consumer });
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
  const homepage = await fetch(url);
  assert.match(homepage.headers.get('content-type'), /^text\/html/);
  assert.match(await homepage.text(), /Trace Viewer/i);
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
  const stream = await fetch(url + api + '/live?cursor=' + encodeURIComponent(page.cursor), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) });
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

test('command helpers support positional root, SSH forwarding hint, validation and rebuilt assets', async (t) => {
  const { formatSshHint, runTraceCommand } = await import('../src/trace-viewer/command.mjs');
  assert.equal(formatSshHint(8787, {}), null);
  const hint = formatSshHint(9090, {
    SSH_CONNECTION: '10.0.0.2 51234 192.168.1.50 22',
    USER: 'alice',
  });
  assert.match(hint, /ssh -N -L 9090:127\.0\.0\.1:9090 alice@192\.168\.1\.50/);

  const root = fileURLToPath(new URL('../../test/fixtures/trace-viewer/runs', import.meta.url));
  const viewer = await runTraceCommand([root, '--port', '0']);
  t.after(() => viewer.close());
  assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const port = new URL(viewer.url).port;
  await assert.rejects(
    runTraceCommand([root, '--port', port]),
    /already in use on 127\.0\.0\.1/,
  );

  const [html, js, css] = await Promise.all([
    fetch(viewer.url + '/'),
    fetch(viewer.url + '/app.js'),
    fetch(viewer.url + '/style.css'),
  ]);
  assert.equal(html.status, 200);
  assert.equal(js.status, 200);
  assert.equal(css.status, 200);
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  const markup = await html.text();
  assert.match(markup, /minimap-wrap/);
  assert.match(markup, /ins-mode-struct/);
});
