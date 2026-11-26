import { createSandbox } from '@murm/core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { peerMeshConfig } from './project-config.js';

const runId = process.env.MURM_PEERMESH_RUN_ID;
const file = process.env.MURM_PEERMESH_PROJECT_FILE;
if (!runId || !file) throw new Error('Set MURM_PEERMESH_RUN_ID and MURM_PEERMESH_PROJECT_FILE for the legacy project fixture');
const project = JSON.parse(await readFile(resolve(file), 'utf8'));
const { timeoutMs, ...config } = peerMeshConfig(project.durationMs ?? 3_600_000);
export default { mode: 'peermesh', timeoutMs, options: { ...config, runId, project, sandbox: createSandbox(config.sandbox) } };
