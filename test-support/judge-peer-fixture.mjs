import { createJudgeServicePeer } from '../src/sdk/judge-service-peer.js';
import { runProcess } from '../src/judge/lean-adapter.js';
const config = JSON.parse(process.env.JUDGE_PEER_FIXTURE);
const checker = {
  timeoutMs: 2000,
  preflight: async ({ startProcess }) => {
    await startProcess(() => runProcess(process.execPath, ['-e', `setTimeout(() => {}, ${config.preflightDelay ?? 0})`], { timeoutMs: 2000 }));
    return { status: 'healthy', checker_process_status: 'completed',
      evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } };
  },
  check: async ({ startProcess }) => {
    const process = await startProcess(() => runProcess(globalThis.process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 2000 }));
    return { verdict: process.exit_code === 0 ? 'PASS' : 'ERROR', evidence: { checker_started: true, exit_code: process.exit_code } };
  },
};
const peer = createJudgeServicePeer({ ...config, checker });
console.log(JSON.stringify(await peer.start()));
process.once('SIGTERM', async () => { await peer.stop(); process.exit(0); });
