import { once } from 'node:events';
import { createRuntime, createSandbox, recoverRuntime, ServiceRegistry, type CreateRuntimeOptions } from '@luna-shi/murm';
import { finishCleanup } from '../../benchmarks/kubernetes/cleanup.js';
import { reconcileRuntimeReceipt } from '../../src/core/runtime-admissions.js';

const [mode, outputDir, configuration, runDirectory] = process.argv.slice(2);
const { image, callbackHost, callbackPort, modelPort, deploymentId, kubernetes } = JSON.parse(configuration);
const options: CreateRuntimeOptions = {
  sandbox: createSandbox({
    endpoint: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    apiKey: process.env.MURM_CORE_TEST_API_KEY, timeoutSeconds: 300,
    ...(kubernetes ? { egressMode: 'dns+nft' } : {}),
    resourceRequests: { cpu: '1', memory: '1Gi' }, resourceLimits: { cpu: '1', memory: '1Gi' },
  }),
  connection: { ...(kubernetes ? { bindHost: '0.0.0.0' } : {}), bindPort: callbackPort, publicUrl: `http://${callbackHost}:${callbackPort}` },
  profiles: { worker: { model: 'default', image, writable: true, services: {},
    ...(kubernetes ? { network: { allow: [] } } : {}),
    collect: { paths: ['recovered.txt'], maxBytes: 1024, includeGit: false, required: true } } },
  models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${modelPort}/v1/responses`, headers: {} } } },
  services: new ServiceRegistry(),
  maxAgents: 1, outputDir,
  persistence: { deploymentId, contract: 'native-recovery-v1' },
};

try {
  if (mode === 'start' || mode === 'retain') {
    const runtime = await createRuntime(options);
    process.send?.({ step: 'runtime', runId: runtime.id });
    const agent = await runtime.spawn({ requestId: 'spawn', profile: 'worker',
      files: { 'recovered.txt': { encoding: 'utf8', data: 'survives controller restart\n' } } });
    const settled = new Promise<void>((resolve, reject) => {
      const release = runtime.onEvent(event => {
        if (event.type !== 'settled' || event.agentId !== agent.id) return;
        release();
        if (event.outcome === 'completed') resolve();
        else reject(new Error(`First input failed: ${event.error?.code ?? 'unknown'}`));
      });
    });
    const receipt = await runtime.send(agent.id, 'Return the scripted answer.', { requestId: 'once' });
    await settled;
    const probe = await runtime.probeWorkerEvent(agent.id, { requestId: 'before', timeoutMs: 8000 });
    process.send?.({ step: 'started', agentId: agent.id, receipt, probe });
    if (mode === 'retain') {
      await once(process, 'message');
      process.send?.({ step: 'retained', receipt: await runtime.close({ timeoutMs: 20_000 }) });
    }
  } else {
    const runtime = await recoverRuntime({ ...options, runDirectory, cleanupOnly: mode === 'cleanup' });
    const close = () => kubernetes
      ? finishCleanup(timeoutMs => runtime.close({ timeoutMs }), performance.now() + 60_000)
      : runtime.close({ timeoutMs: 20_000 });
    const agents = await runtime.list();
    if (mode === 'finish-close') {
      if (runtime.state !== 'closing' || agents[0]?.status !== 'closing') throw new Error('Persisted shutdown unexpectedly reopened work');
      let rejection: unknown;
      try { await runtime.send(agents[0].id, 'A new input must remain fenced.', { requestId: 'blocked' }); }
      catch (error) { rejection = (error as { code?: string }).code; }
      if (rejection !== 'NOT_ALLOWED') throw new Error('Recovered closing Run admitted a new input');
      process.send?.({ step: 'closed', receipt: await close() });
    } else if (mode === 'cleanup') {
      process.send?.({ step: 'closed', receipt: await close() });
    } else {
      const [agent] = agents;
      if (!agent) throw new Error('Recovered Runtime has no original Agent');
      if (agent.status !== 'idle') throw new Error(`Recovery did not reopen the same Agent: ${agent.status} ${agent.lastError?.code ?? ''}`);
      // The replacement Controller must be able to query with no prompt text.
      const queried = await reconcileRuntimeReceipt(runtime, agent.id, 'send', 'once');
      const replay = await runtime.send(agent.id, 'Return the scripted answer.', { requestId: 'once' });
      const probe = await runtime.probeWorkerEvent(agent.id, { requestId: 'after', timeoutMs: 8000 });
      const snapshot = await runtime.files.snapshot(agent.id, { requestId: 'recovered-files', paths: ['recovered.txt'] });
      process.send?.({ step: 'closed', agentId: agent.id, queried, replay, probe,
        content: snapshot.files['recovered.txt'], receipt: await close() });
    }
  }
} catch (error) {
  process.send?.({ step: 'error', code: (error as { code?: string }).code, message: (error as Error).message,
    details: (error as { details?: unknown }).details });
}
