import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

// Uses the shipped Guest executable and JSONL protocol with a real Pi Session.
export async function startNativePiSession(t: any, options: { configuration?: any; upstream?: string; beforeCompact?: any } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'murm-native-pi-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'agent');
  await mkdir(agentDir);
  if (options.upstream) await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { controlled: {
    baseUrl: options.upstream, api: 'openai-responses', apiKey: 'controlled-local-only',
    models: [{ id: 'k3', name: 'controlled', reasoning: false, contextWindow: 8000, maxTokens: 1000 }] } } }));
  await writeFile(join(directory, 'prompt'), 'Act on the controlled input.');
  await writeFile(join(directory, 'bridge.json'), JSON.stringify({
    args: ['--system-prompt', join(directory, 'prompt'), ...(options.upstream ? ['--provider', 'controlled', '--model', 'k3'] : [])],
    configuration: options.configuration ?? {}, beforeCompact: options.beforeCompact }));
  const child = spawn(process.execPath, [new URL('../../scripts/pi-session-bridge.js', import.meta.url).pathname, join(directory, 'bridge.json')], {
    cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', data => stderr += data);
  const records: any[] = [];
  const listeners = new Set<(record: any) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    const record = JSON.parse(line);
    records.push(record);
    for (const listener of listeners) listener(record);
  });
  const waitFor = async (predicate: () => any) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, stderr + JSON.stringify(records.slice(-3)));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return predicate();
  };
  const send = (message: any) => child.stdin.write(JSON.stringify(message) + '\n');
  await waitFor(() => records.find(record => record.type === 'core_session_ready'));
  return { child, directory, records, waitFor, send, onRecord(handler: (record: any) => void) { listeners.add(handler); },
    async command(id: string, type: string, values = {}) {
      send({ id, type, ...values });
      const reply = await waitFor(() => records.find(record => record.type === 'response' && record.id === id));
      assert.equal(reply.success, true, JSON.stringify(reply));
      return reply.data;
    } };
}
