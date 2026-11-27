import { substrateConfiguration } from './project-config.js';

const runId = process.env.MURM_SUBSTRATE_RUN;
if (!runId) throw new Error('Set MURM_SUBSTRATE_RUN');

export default {
  ...substrateConfiguration(), runId, outputDir: './substrate-runs',
  question: 'Compare concrete input-validation approaches. Search and visit peer contributions, then publish a self-contained comparison citing the contributions actually used.',
};
