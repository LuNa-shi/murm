#!/usr/bin/env node
import { installPeerLifetime } from './peer-process-lifetime.js';
import { cleanupOwnedCheckers } from '../../services/judge/checker-owner.js';
import { readFile } from 'node:fs/promises';
import { createJudgeServicePeer } from './judge-service-peer.js';
import { LeanChecker } from '../../services/judge/lean-adapter.js';
import { createLockedFinalTreeVerifier } from '../../services/judge/final-tree-deployment.js';
if (process.env.MURM_JUDGE_PEER_LOCKED !== 'true') throw new Error('Use the locked Judge peer entrypoint');
await cleanupOwnedCheckers(process.env.MURM_CHECKER_OWNER_FILE);
if (process.argv.includes('--cleanup')) process.exit(0);
const config = JSON.parse(await readFile(process.env.MURM_JUDGE_PEER_CONFIG!, 'utf8'));
const deployment = config.finalTreeConfiguration
  ? await createLockedFinalTreeVerifier({ configuration: config.finalTreeConfiguration, problem: config.problem }) : null;
const checker = new LeanChecker({ ...config.checker,
  checkerRef: config.fixtureManifest?.checker_ref ?? 'lean',
  checkerVersion: config.fixtureManifest?.checker_version ?? 'mvp-1',
  runner: deployment?.adapter.runSourceDiagnostic.bind(deployment.adapter),
  projectChecker: deployment?.adapter.projectChecks ? deployment.adapter.checkProject.bind(deployment.adapter) : null });
const peer = createJudgeServicePeer({ ...config, database: process.env.MURM_SERVICE_DATABASE,
  token: process.env.MURM_COORDINATOR_TOKEN, cleanupResources: () => cleanupOwnedCheckers(process.env.MURM_CHECKER_OWNER_FILE), checker, projectChecks: Boolean(deployment?.adapter.projectChecks) });
console.log(JSON.stringify(await peer.start({ port: Number(process.env.MURM_SERVICE_PORT ?? 0) })));
installPeerLifetime(peer);
