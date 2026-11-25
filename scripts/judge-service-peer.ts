#!/usr/bin/env node
import { installPeerLifetime } from '../src/sdk/peer-process-lifetime.js';
import { cleanupOwnedCheckers } from '../src/judge/checker-owner.js';
import { readFile } from 'node:fs/promises';
import { createJudgeServicePeer } from '../src/sdk/judge-service-peer.js';
import { LeanChecker } from '../src/judge/lean-adapter.js';
import { createLockedFinalTreeVerifier } from '../src/judge/final-tree-deployment.js';
if (process.env.SWARMENV_JUDGE_PEER_LOCKED !== 'true') throw new Error('Use the locked Judge peer entrypoint');
await cleanupOwnedCheckers(process.env.SWARMENV_CHECKER_OWNER_FILE);
if (process.argv.includes('--cleanup')) process.exit(0);
const config = JSON.parse(await readFile(process.env.SWARMENV_JUDGE_PEER_CONFIG!, 'utf8'));
const deployment = config.finalTreeConfiguration
  ? await createLockedFinalTreeVerifier({ configuration: config.finalTreeConfiguration, problem: config.problem }) : null;
const checker = new LeanChecker({ ...config.checker,
  checkerRef: config.fixtureManifest?.checker_ref ?? 'lean',
  checkerVersion: config.fixtureManifest?.checker_version ?? 'mvp-1',
  runner: deployment?.adapter.runSourceDiagnostic.bind(deployment.adapter),
  projectChecker: deployment?.adapter.projectChecks ? deployment.adapter.checkProject.bind(deployment.adapter) : null });
const peer = createJudgeServicePeer({ ...config, database: process.env.SWARMENV_SERVICE_DATABASE,
  token: process.env.SWARMENV_COORDINATOR_TOKEN, cleanupResources: () => cleanupOwnedCheckers(process.env.SWARMENV_CHECKER_OWNER_FILE), checker, projectChecks: Boolean(deployment?.adapter.projectChecks) });
console.log(JSON.stringify(await peer.start({ port: Number(process.env.SWARMENV_SERVICE_PORT ?? 0) })));
installPeerLifetime(peer);
