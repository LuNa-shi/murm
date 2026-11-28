import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { HarnessRpcClient, HarnessState, HarnessEvent, HarnessResult } from '@luna-shi/murm';

/** Exercise the installed package's root client and installed foreground CLI. */
export async function runInstalledHarnessRpc(installation: { directory: string; env: NodeJS.ProcessEnv }, options: {
  harness: string; cwd: string; prompt: string; configPath: string; outputDir: string; timeoutMs: number;
  interact?: (session: HarnessRpcClient) => Promise<void>;
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
  const eventKinds = new Set<HarnessEvent['type']>();
  const observedAgents = new Map<string, unknown>();
  const phases = new Set<HarnessState['phase']>();
  const runIds = new Set<string>();
  let businessObserved = false;
  let latest: HarnessState | undefined;
  const observeState = (state: HarnessState) => {
    latest = state;
    phases.add(state.phase);
    if (state.runId) runIds.add(state.runId);
    businessObserved ||= state.business !== null && state.business !== undefined;
    if (snapshots.length < 64) snapshots.push(state);
  };
  let result: HarnessResult | undefined;
  let status = 1;
  let timer: NodeJS.Timeout | undefined;
  const unsubscribe = session.onEvent(event => {
    eventKinds.add(event.type);
    if (event.type === 'snapshot' || event.type === 'state') {
      observeState(event.state);
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
        observeState(state);
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
    const interaction = options.interact?.(session);
    result = await Promise.race([Promise.all([session.completion, interaction]).then(([completed]) => completed), limit]);
    await pollingWork;
    child.stdin.end();
    const [code] = await Promise.race([exited, limit]);
    status = typeof code === 'number' ? code : 1;
    assert.ok(runIds.has(result.runId));
    assert.ok(phases.has('running'), 'The installed Harness must publish its running phase');
    assert.ok(eventKinds.has('result'));
    assert.ok(observedAgents.size > 0, 'The installed client must query real live Agent state');
    return { result, status, diagnostic, observation: {
      initialSnapshot: snapshots[0], finalState: latest,
      runIds: [...runIds],
      phases: [...phases],
      agents: [...observedAgents].map(([agentId, state]) => ({ agentId, state })),
      eventKinds: [...eventKinds],
      businessObserved,
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
