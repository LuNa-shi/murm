import { createSandbox } from '@luna-shi/murm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { peerMeshConfig } from './project-config.js';

const runId = process.env.MURM_PEERMESH_RUN_ID;
const file = process.env.MURM_PEERMESH_PROJECT_FILE;
if (!runId) throw Object.assign(new Error('Set MURM_PEERMESH_RUN_ID for the project fixture'), { code: 'PEERMESH_CONFIG_RUN_ID_REQUIRED' });
if (!file) throw Object.assign(new Error('Set MURM_PEERMESH_PROJECT_FILE for the project fixture'), { code: 'PEERMESH_CONFIG_PROJECT_FILE_REQUIRED' });
const project = JSON.parse(await readFile(resolve(file), 'utf8'));
const { timeoutMs, ...config } = peerMeshConfig(project.durationMs ?? 3_600_000);
export default { mode: 'peermesh', timeoutMs, options: { ...config, runId, project, sandbox: createSandbox(config.sandbox) } };
