import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { HarnessState } from '@luna-shi/murm';
import { transport } from './fixtures/core-agent-service-backend.js';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './sandbox/opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./fixtures/lead-worker-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createHarnessSession } = await import('../src/core/index.js');
const { default: project } = await import('../examples/lead-worker/project.js');
hooks.deregister();
const execute = promisify(execFile);

test('Lead project publishes committed Board changes while the Agent status vector stays fixed', { timeout: 15000 }, async t => {
  transport.reset(); transport.collectable = true;
  const directory = await mkdtemp(join(tmpdir(), 'lead-project-observation-'));
  const dispatched = Promise.withResolvers<void>();
  transport.next = () => { dispatched.resolve(); };
  const actors = Object.fromEntries(['lead', 'helper1', 'helper2'].map(role => [role, {
    accountId: role, username: role, token: `private-${role}`, branch: role, binding: `test:${role}`,
  }]));
  const session = createHarnessSession(project, { outputRoot: join(directory, 'output'), configuration: {
    image: 'test', sandbox: {}, models: {}, team: 'static', turnTimeoutMs: 10000, workTimeoutMs: 12000, closeTimeoutMs: 2000,
    prepare: ({ runId }: { runId: string }) => ({ runId, origin: 'http://192.0.2.1:12345', initialCommit: 'a'.repeat(40),
      repository: { owner: 'owner', name: 'repo' }, repositoryUrl: 'http://192.0.2.1:12345/owner/repo.git', actors }),
  } });
  const states: HarnessState[] = [];
  const unsubscribe = session.onEvent(event => { if (event.type === 'state') states.push(event.state); });
  t.after(async () => {
    await session.stop({ requestId: 'stop' });
    if (session.completion) assert.equal((await session.completion).cleanup.status, 'complete');
    unsubscribe();
    await rm(directory, { recursive: true, force: true });
  });
  await session.start({ cwd: directory, prompt: 'Observe Board facts' }, { requestId: 'start' });
  await Promise.race([dispatched.promise, session.completion!.then(result => assert.fail(JSON.stringify(result)))]);
  await delay(25);
  const vector = (state: HarnessState) => (state.agents as { id: string; status: string }[])
    .map(agent => [agent.id, agent.status]).sort((a, b) => a[0].localeCompare(b[0]));
  const before = states.at(-1)!;
  assert.ok(vector(before).some(([, status]) => status === 'running'));
  const first = states.length;
  const lead = [...transport.spawns.values()].find(agent => agent.options.profile === 'lead');
  const payload = join(directory, 'announce.json');
  await writeFile(payload, JSON.stringify({ text: 'Committed while the Lead execution waits', feedback_ids: [] }));
  await execute(process.execPath, [new URL('../scripts/swarm.js', import.meta.url).pathname,
    'board', 'announce', '--input', payload, '--request-id', 'board-only-change'], {
    env: { ...process.env, ...lead.credentials.environment, ...lead.credentials.secretEnvironment }, timeout: 5000,
  });
  const deadline = Date.now() + 1000;
  const updated = () => states.slice(first).find(state => {
    const business = state.business as { detail?: { board?: { directions?: unknown[] } } };
    return business.detail?.board?.directions?.length === 1;
  });
  while (!updated() && Date.now() < deadline) await delay(10);
  assert.ok(updated(), 'A committed Board write must emit a fresh Session state without an Agent transition or getState polling');
  assert.deepEqual(vector(updated()!), vector(before));
});
