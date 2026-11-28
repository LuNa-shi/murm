import { JUDGE_PEER_SCHEMA_SQL } from '../../persistence/service-peer-schema.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { JudgeService } from '../../services/judge/judge-service.js';
import { ServiceAuthoritySnapshot } from './service-authority-snapshot.js';
import { createCoordinatorPeerHost } from './coordinator-peer-host.js';
import { callCoordinatorPeer } from './coordinator-peer-client.js';
import { stableStringify } from '../../persistence/envelope.js';
import { ERROR_CODES, MurmError } from '../../errors.js';

export const JUDGE_READ_METHODS = Object.freeze(['getCheckResult', 'getAgentCheckResult', 'getByRequestKey',
  'getCheckerPreflight', 'listCheckerPreflights', 'getMissionCheckBudget']);

/** The process launcher holds an exclusive instance lock for this store. */
export function createJudgeServicePeer({ database, token, coordinator, checker, fixtureManifest, missionBudget,
  maxInfrastructureRetries = 2, host = '127.0.0.1', publicUrl = null, projectChecks = false, cleanupResources = async () => ({ settled: 0 }) }: any) {
  const generation = randomUUID();
  const requests = new AsyncLocalStorage<any>();
  const phases = new Map();
  const authority: Record<string, any> = {};
  for (const method of ['getAgent', 'getTask', 'getExecution', 'materialScope', 'assertMissionResearchOpen']) {
    authority[method] = (...args: any[]) => requests.getStore().authority[method](...args);
  }
  // Presence is required by local admission guards; all real remote writes
  // use lifecycleWrite below rather than this synchronous local seam.
  authority.withServiceLifecycleWrite = () => { throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Remote Judge requires a coordinator launch gate'); };
  const stage = (input: any) => callCoordinatorPeer({ ...coordinator, actorRef: 'service:judge', operation: 'judge_lifecycle', input });
  const judge = new (JudgeService as any)(database, { checker, fixtureManifest, taskService: authority, missionBudget, maxInfrastructureRetries,
    readProjectRevision: projectChecks ? async (reference: any) => {
      const project = requests.getStore().project;
      if (!project || project.workspace_id !== reference.workspaceId || project.revision !== reference.revision) {
        throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Judge project does not match the coordinator export');
      }
      return { ...project, files: Object.fromEntries(Object.entries(project.files).map(([path, bytes]: any) => [path, Buffer.from(bytes, 'base64')])) };
    } : null,
    refreshQueueAuthority: async () => {
      const request = requests.getStore();
      const refreshed = await stage({ action: 'queue_status', call_id: request.call_id, generation });
      request.authority = new ServiceAuthoritySnapshot(refreshed.authority);
    },
    lifecycleWrite: async (commit: any, metadata: any) => {
      const request = requests.getStore();
      const sequence = request.sequence++;
      const key = `${request.call_id}:${sequence}`;
      const phase: { request: any; commit: any; phase: any; executed: boolean; failure?: unknown; value?: any } = { request, commit, phase: metadata.phase, executed: false };
      phases.set(key, phase);
      try {
        await stage({ action: 'execute', call_id: request.call_id, generation, sequence, ...metadata });
        if (!phase.executed) throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Coordinator did not execute the Judge phase');
        if (phase.failure) throw phase.failure;
        return await phase.value;
      } finally {
        // Keep any admitted process tracked even when its acknowledgment is
        // lost. It retains its existing checker timeout and cannot be rerun.
        if (phase.value?.then) await phase.value.catch(() => {});
        phases.delete(key);
      }
    },
  });
  judge.db.exec(JUDGE_PEER_SCHEMA_SQL);
  // The exclusive process lock proves that the former JS process can no
  // longer invoke a checker. Never retry an ambiguous former launch phase.
  for (const row of judge.db.prepare('SELECT * FROM judge_peer_phases WHERE receipt_json IS NULL').all()) {
    judge.db.prepare('UPDATE judge_peer_phases SET receipt_json = ? WHERE gate_id = ?').run(JSON.stringify({
      terminal: true, gate_id: row.gate_id, digest: row.digest, generation: row.generation,
      phase: row.phase, outcome: 'interrupted', recovered_generation: generation,
    }), row.gate_id);
  }
  const interruptedAt = new Date().toISOString();
  judge.db.prepare(`UPDATE check_results SET status = 'RECEIVED', verdict = 'ERROR',
    judge_operation_status = 'persisted', result_class = 'infrastructure_failure',
    checker_process_status = 'crashed', retryable = 1, diagnostic_code = 'judge_peer_restarted',
    evidence_json = json_set(evidence_json, '$.diagnostic', 'Judge process restarted before a terminal receipt',
      '$.checker_started', json('null')), updated_at = ? WHERE status IN ('REQUESTED', 'RUNNING')`).run(interruptedAt);
  judge.db.prepare(`UPDATE judge_mission_check_admissions SET settled_at = ? WHERE settled_at IS NULL`).run(interruptedAt);
  const server = createCoordinatorPeerHost({ serviceId: 'judge', operation: 'domain_command',
    actorRef: 'service:coordinator', token, host, publicUrl, maxBodyBytes: 32 * 1024 * 1024, handler: async (command: any) => {
      if (command.method === 'identity') return { generation };
      if (command.method === 'reconcile_resources') { await judge.waitForIdle(); return cleanupResources(); }
      if (command.method === 'execute_phase') {
        const admission = command.admission;
        const bound = admission?.command;
        const phase = bound && phases.get(`${bound.call_id}:${bound.sequence}`);
        if (!phase || phase.executed || bound.generation !== generation || phase.phase !== bound.phase ||
            createHash('sha256').update(stableStringify(bound)).digest('hex') !== admission.digest) {
          throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Judge phase does not match its registered callback');
        }
        return requests.run(phase.request, () => {
          phase.request.authority = new ServiceAuthoritySnapshot(bound.authority);
          judge.db.prepare('INSERT INTO judge_peer_phases VALUES (?, ?, ?, ?, ?, NULL)')
            .run(admission.gate_id, admission.digest, generation, bound.call_id, bound.phase);
          phase.executed = true;
          try { phase.value = phase.commit(); if (phase.value?.catch) phase.value.catch(() => {}); }
          catch (error: any) { phase.failure = error; }
          const receipt = { terminal: true, gate_id: admission.gate_id, digest: admission.digest,
            generation, phase: bound.phase, outcome: phase.failure ? 'rejected' : 'committed' };
          judge.db.prepare('UPDATE judge_peer_phases SET receipt_json = ? WHERE gate_id = ?')
            .run(JSON.stringify(receipt), admission.gate_id);
          return receipt;
        });
      }
      if (command.method === 'phase_receipt') {
        const row = judge.db.prepare('SELECT receipt_json FROM judge_peer_phases WHERE gate_id = ? AND digest = ?')
          .get(command.gate_id, command.digest);
        return { receipt: row?.receipt_json ? JSON.parse(row.receipt_json) : null, generation };
      }
      if (JUDGE_READ_METHODS.includes(command.method)) return { result: (judge as any)[command.method](...command.args) };
      if (command.method !== 'dispatch' || !['workspace_check', 'get_check_result'].includes(command.args?.[0]) ||
          typeof command.call_id !== 'string' || !command.authority) {
        throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Unsupported coordinator Judge operation');
      }
      return requests.run({ call_id: command.call_id, project: command.project, authority: new ServiceAuthoritySnapshot(command.authority), sequence: 0 },
        async () => ({ result: await judge.dispatch(...command.args) }));
    } });
  return { generation, start: (options?: any) => server.start(options), environment: () => server.environment(),
    async stop() { await server.stop(); await judge.waitForIdle(); judge.close(); } };
}
