import type { ProjectHarness } from '../../src/harness/project-harness.js';
import { observeProjectRuntime, projectConfiguration } from '../../src/harness/project-runtime.js';
import { ProjectPreflightError } from '../../src/harness/project-input.js';
import { runMessageHandoff } from './handoff.js';
import { handoffConfig, type HandoffConfig } from './handoff-config.js';

const messages = {
  id: 'messages', apiVersion: 1,
  async run(context) {
    const config = await projectConfiguration<HandoffConfig>(context, async () => ({ default: handoffConfig() }));
    for (const ms of [config.workTimeoutMs, config.cleanupTimeoutMs]) {
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647) {
        throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Messages requires finite work and cleanup time limits');
      }
    }
    const { report, submissions } = await runMessageHandoff({ ...config, outputDir: context.outputDir },
      context.signal, undefined, {
        files: context.initial.files, prompt: context.input.prompt,
        artifact: `murm-message-${context.runId}.txt`, ready: context.markRunning,
        observe(runtime) { return observeProjectRuntime(runtime, context).close; },
      });
    const receipt = report.coreClose.status === 'unknown' ? null : report.coreClose.receipt;
    const verified = report.artifactVerification.status === 'passed';
    const cleanup = receipt?.cleanup === 'complete' && receipt.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete');
    return {
      outcome: report.business.status === 'cancelled' ? 'cancelled'
        : report.business.status !== 'completed' || report.reportSaveFailure ? 'failed' : 'completed',
      reason: report.business.status === 'completed' ? 'completed' : report.business.error.code,
      result: JSON.parse(JSON.stringify({ ...report, submissions })),
      artifacts: (receipt?.agents ?? []).flatMap(agent => agent.artifacts.map(path => ({ agentId: agent.agentId, path }))),
      acceptance: { status: 'not-run' },
      export: { status: verified ? 'complete' : report.artifactVerification.status === 'pending' ? 'pending' : 'failed' },
      cleanup: { status: cleanup ? 'complete' : 'pending', receipt: JSON.parse(JSON.stringify(receipt)) },
    };
  },
} satisfies ProjectHarness;

export default messages;
