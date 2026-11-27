import { leadWorkerConfig } from './project-config.js';

const runId = process.env.MURM_LEAD_WORKER_RUN;
if (!runId) throw new Error('Set MURM_LEAD_WORKER_RUN for the legacy fixed-team fixture');
export default {
  ...leadWorkerConfig(), runId, outputDir: './lead-worker-runs',
  goal: 'Build two complementary text reports about input validation and caller authentication. Each initial artifact must give a concrete check and a public feedback suggestion.',
  supplement: 'Require explicit evidence and explain authorization as a separate check. Preserve earlier reports and deliver a new text report containing the full updated public direction.',
};
