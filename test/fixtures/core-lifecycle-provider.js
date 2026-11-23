import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { BOT_UID } from '../../scripts/sandbox-project.mjs';

// Simulate only external infrastructure: provider/Worker HTTP and host OS commands.
// Core, its backend, manager, admission state and cleanup are the actual modules.
export async function createLifecycleProvider(t) {
  const resources = new Map();
  const records = [];
  const tables = new Map();
  let allocations = 0;
  let rejectDelete = true;
  let deletion;
  let releaseDelete;
  let holdDelete = true;
  const deletionStarted = new Promise(resolve => { deletion = resolve; });
  const deletionReleased = new Promise(resolve => { releaseDelete = resolve; });
  const originalExec = childProcess.execFile;
  const run = async (command, args) => {
    if (command === 'docker') {
      const id = args.at(-1);
      const resource = [...resources.values()].find(row => `sandbox-${row.id}` === id || row.container === id);
      assert.ok(resource, 'Fixture OS accepts only its own resource');
      const format = args[args.indexOf('--format') + 1];
      if (format.startsWith('{"id"')) return { stdout: JSON.stringify({ id: resource.container, pid: 54,
        started: 'fixture-start', running: true, labels: resource.labels }) };
      return { stdout: [resource.container, 54, true, 'fixture-start', 'bridge', false, resource.labels].map(JSON.stringify).join(' ') };
    }
    assert.equal(command, 'sudo');
    const [, program, ...rest] = args;
    if (program.endsWith('/stat')) return { stdout: rest.at(-1) === '/proc/1/ns/net' ? '4:22' : '4:111' };
    if (program.endsWith('/cat')) return { stdout: rest[0].endsWith('/cgroup')
      ? `0::/docker/${[...resources.values()].at(-1).container}` : '0 0 65536' };
    if (program.endsWith('/mktemp')) return { stdout: '/tmp/swarmenv-netns.ABCDEFG123' };
    if (program.endsWith('/nsenter')) {
      const commands = rest.slice(3);
      const emit = rows => ({ stdout: JSON.stringify({ nftables: rows }) });
      if (commands[0] === '-j' && commands[2] === 'tables') return emit([...tables.values()].map(rows => rows[0]));
      if (commands[0] === '-j') return emit(tables.get(commands.at(-1)));
      const declarations = commands[0].split('\n');
      const table = /^add table inet (swarmbot_[a-f0-9]+)$/.exec(declarations.shift())[1];
      declarations.shift();
      const owner = { match: { op: '==', left: { meta: { key: 'skuid' } }, right: BOT_UID } };
      const match = (protocol, field, right) => ({ match: { op: '==', left: { payload: { protocol, field } }, right } });
      tables.set(table, [{ table: { family: 'inet', name: table } },
        { chain: { family: 'inet', table, name: 'output', type: 'filter', hook: 'output', prio: -150, policy: 'accept' } },
        ...declarations.map(line => {
          const rule = line.slice(`add rule inet ${table} output meta skuid ${BOT_UID} `.length);
          const [, address, port] = /^ip daddr ([\d.]+) tcp dport (\d+) accept$/.exec(rule) ?? [];
          return { rule: { family: 'inet', table, chain: 'output', expr: address
            ? [owner, match('ip', 'daddr', address), match('tcp', 'dport', Number(port)), { accept: null }]
            : [owner, { reject: { type: 'icmpx', expr: 'port-unreachable' } }] } };
        })]);
      return { stdout: '' };
    }
    assert.ok(['/usr/bin/touch', '/usr/bin/mount', '/usr/bin/umount', '/usr/bin/rm', '/usr/bin/rmdir', '/usr/bin/python3'].includes(program));
    return { stdout: '' };
  };
  const execute = () => { throw new Error('Fixture expects promisified OS commands'); };
  execute[promisify.custom] = run;
  childProcess.execFile = execute;
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = originalExec; syncBuiltinESMExports(); });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = new URL(request.url, 'http://fixture').pathname;
    const send = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path === '/sandboxes' && request.method === 'POST') {
      const id = `fixture-${++allocations}`;
      records.length = 0;
      resources.set(id, { id, container: createHash('sha256').update(id).digest('hex'), labels: { ...body.metadata, 'opensandbox.io/id': id } });
      return send({ id, execd_endpoint: { url: `${base}/execd` } });
    }
    if (path.includes('/endpoints/')) return send({ url: `${base}/worker` });
    if (['/execd/ready', '/worker/health'].includes(path)) return send({ ok: true });
    if (path === '/execd/command') {
      const argv = body.argv ?? [];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      return response.end(`event: stdout\ndata: ${JSON.stringify({ text: argv[0] === 'pi' ? '1.3.0' : 'v22.19.0' })}\n\nevent: execution_complete\ndata: {"exit_code":0}\n\n`);
    }
    if (path === '/worker/start') return send({ result: { contract: { version: 'swarmenv-core-v1', resources: [] },
      project_quota: body.project_quota, model_catalog_resource: body.model_catalog_resource } });
    if (path === '/worker/rpc') return send({ result: { response: { id: body.message.id, success: true, command: body.message.type,
      ...(body.message.type === 'prompt' ? { data: { disposition: 'started' } } : {}) },
      records: records.filter(row => row.worker_sequence > (body.message.since ?? 0)) } });
    if (path === '/worker/stop') return send({ result: { stopped: true } });
    if (path.startsWith('/sandboxes/') && request.method === 'DELETE') {
      deletion();
      if (holdDelete) await deletionReleased;
      if (rejectDelete) return send({ message: 'Controlled deletion failure' }, 503);
      resources.delete(path.split('/').at(-1));
      return send({});
    }
    if (path.startsWith('/sandboxes/') && request.method === 'GET') return send({}, resources.has(path.split('/').at(-1)) ? 200 : 404);
    return send({ message: 'Unrecognized fixture request' }, 400);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { releaseDelete(); return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return {
    url: base, deletionStarted,
    allocations: () => allocations,
    unexpectedExit() { records.push({ type: 'worker_exit', code: 1, worker_sequence: records.length + 1 }); },
    releaseDeletion() { holdDelete = false; releaseDelete(); },
    allowDeletion() { holdDelete = false; rejectDelete = false; releaseDelete(); },
  };
}
