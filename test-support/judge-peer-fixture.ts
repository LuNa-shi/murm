import { createJudgeServicePeer } from '../examples/taskpool/deploy/service-hosts/judge-service-peer.js';
import { LeanFinalTreeVerifier } from '../examples/taskpool/services/judge/lean-final-tree-verifier.js';
import { readFile } from 'node:fs/promises';
import { runProcess, LeanChecker } from '../examples/taskpool/services/judge/lean-adapter.js';
const config = JSON.parse(process.env.JUDGE_PEER_FIXTURE!);
let checker: any = {
  timeoutMs: config.processTimeoutMs ?? 2000,
  preflight: async ({ startProcess, assertCanStart }: any) => {
    assertCanStart();
    await startProcess(() => runProcess(process.execPath, ['-e', `setTimeout(() => {}, ${config.preflightDelay ?? 0})`], { timeoutMs: 2000 }));
    return { status: 'healthy', checker_process_status: 'completed',
      evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } };
  },
  check: async ({ startProcess, assertCanStart }: any) => {
    assertCanStart();
    const process = await startProcess(() => runProcess(globalThis.process.execPath, ['-e', `setTimeout(() => process.exit(0), ${config.sourceDelay ?? 0})`], { timeoutMs: config.processTimeoutMs ?? 2000 }));
    return { verdict: process.exit_code === 0 ? 'PASS' : 'ERROR', evidence: { checker_started: true, exit_code: process.exit_code } };
  },
};
if (config.realLeanRoot) {
  const fixtureSource = await readFile(`${config.fixtureManifest.project_root}/Target.lean`, 'utf8');
  const verifier: any = new LeanFinalTreeVerifier({ identity: config.fixtureManifest, leanRoot: config.realLeanRoot,
    libraryRoots: [], comparatorLibraryRoots: ['/unused', '/unused'], exporterPath: '/unused/export',
    targetPath: 'Target.lean', declarationName: 'target', fixtureSource,
    fixtureSha256: config.fixtureManifest.problem_file_hash, projectChecks: true,
    allowUnboundedDiagnostics: true, timeoutMs: 30000 });
  checker = new LeanChecker({ command: `${config.realLeanRoot}/bin/lake`, checkerVersion: 'fixture',
    timeoutMs: 30000, projectChecker: (input: any) => verifier.checkProject(input) });
}
const peer = createJudgeServicePeer({ ...config, checker });
console.log(JSON.stringify(await peer.start()));
process.once('SIGTERM', async () => { await peer.stop(); process.exit(0); });
