import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { HarnessRpcClient, HarnessState, HarnessEvent, HarnessResult } from '@luna-shi/murm';

/** Exercise the installed package's root client and installed foreground CLI. */
export async function runInstalledHarnessRpc(installation: { directory: string; env: NodeJS.ProcessEnv }, options: {
  harness: string; cwd: string; prompt: string; configPath: string; outputDir: string; timeoutMs: number;
}) {
  const require = createRequire(join(installation.directory, 'native-consumer.mjs'));
  const installed = require('@luna-shi/murm') as typeof import('@luna-shi/murm');
  const child = spawn(process.execPath, ['node_modules/.bin/murm', '--harness', options.harness, '--mode', 'rpc', '--lifetime', 'task',
    '--interaction', 'none', '--config', options.configPath, '--output-dir', options.outputDir], {
    cwd: installation.directory, env: installation.env, stdio: 'pipe',
  });
  const exited = once(child, 'close');
  let diagnostic = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
  const session: HarnessRpcClient = new installed.HarnessRpcClient(child);
  const snapshots: HarnessState[] = [];
  const events: HarnessEvent[] = [];
  const observedAgents = new Map<string, unknown>();
  let latest: HarnessState | undefined;
  let result: HarnessResult | undefined;
  let status = 1;
  let timer: NodeJS.Timeout | undefined;
  const unsubscribe = session.onEvent(event => {
    if (events.length < 1024) events.push(event);
    if (event.type === 'snapshot' || event.type === 'state') {
      latest = event.state;
      if (snapshots.length < 64) snapshots.push(event.state);
    }
  }, { initialSnapshot: true });
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Installed Harness RPC workload deadline exceeded')), options.timeoutMs); });
  try {
    const ready = await Promise.race([session.ready, limit]);
    assert.equal(ready.harness.id, options.harness);
    assert.equal(ready.status.lifetime, 'task');
    assert.equal((await session.describe()).id, options.harness);
    const accepted = await session.start({ cwd: options.cwd, prompt: options.prompt }, { requestId: 'native-project-start' });
    assert.equal(accepted.status, 'accepted');
    assert.ok(session.completion);
    const polling = async () => {
      while (!result) {
        const state = await session.getState();
        latest = state;
        if (snapshots.length < 64) snapshots.push(state);
        const agents = Array.isArray(state.agents) ? state.agents : [];
        for (const agent of agents) {
          if (!agent || typeof agent !== 'object' || !('id' in agent) || typeof agent.id !== 'string' || !('status' in agent) || !['idle', 'running'].includes(String(agent.status)) || observedAgents.has(agent.id)) continue;
          try { observedAgents.set(agent.id, await session.agents.getState(agent.id)); }
          catch { /* A natural completion can close an Agent between snapshot and query. */ }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const pollingWork = polling().catch(() => {});
    result = await Promise.race([session.completion, limit]);
    await pollingWork;
    child.stdin.end();
    const [code] = await Promise.race([exited, limit]);
    status = typeof code === 'number' ? code : 1;
    assert.ok(snapshots.some(state => state.runId === result!.runId));
    assert.ok(events.some(event => event.type === 'result'));
    assert.ok(observedAgents.size > 0, 'The installed client must query real live Agent state');
    return { result, status, diagnostic, observation: {
      initialSnapshot: snapshots[0], finalState: latest,
      runIds: [...new Set(snapshots.map(state => state.runId).filter(Boolean))],
      phases: [...new Set(snapshots.map(state => state.phase))],
      agents: [...observedAgents].map(([agentId, state]) => ({ agentId, state })),
      eventKinds: [...new Set(events.map(event => event.type))],
      businessObserved: snapshots.some(state => state.business !== null && state.business !== undefined),
    } };
  } finally {
    clearTimeout(timer);
    unsubscribe();
    if (!result && session.completion) {
      await session.stop({ requestId: 'native-project-emergency-stop', reason: 'test-finished' }).catch(() => {});
      await Promise.race([session.completion.catch(() => {}), new Promise(resolve => setTimeout(resolve, 30000))]);
    }
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}
