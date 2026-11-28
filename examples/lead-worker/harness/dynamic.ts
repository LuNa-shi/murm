import { createHash } from 'node:crypto';
import {
  type AgentAccessPolicy, type FileTree, type Profile, type Runtime, ServiceRegistry,
  type JsonValue, type ServiceManifest, type ServiceRegistration, seededCheckoutInstruction,
  type createOwnedResources,
} from '@luna-shi/murm';
import { dynamicBoardPermissions, type createBoard } from '../services/board.js';
import type { createLeadWorkerGit, prepareLeadWorkerGit } from './git.js';
import { dynamicWorkerPrompt, projectDynamicWorkerPrompt } from './prompts.js';

const maxSourceBytes = 128 * 1024;
const fail = (code: string, message = code) => Object.assign(new Error(message), { code });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' };
const requestId = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' };
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const rules = (project: boolean) => ({

  profile_register: object({ id, prompt: text, check_service_id: id }, project ? ['id', 'prompt'] : undefined),
  profile_get: object({ id }),
  profile_list: object({}),
  service_deploy: object({
    source_path: { type: 'string', pattern: '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*\\.mjs$', maxLength: 128 },
    manifest: object({ id, title: text, purpose: text, operation: { const: project ? 'check_project' : 'check_orders' } }),
  }),
  service_register: object({ reference: id }),
  service_get: object({ id }),
  service_list: object({}),
  service_retire: object({ id }),
  spawn_member: object({ profile: id }),
  member_get: object({ request_id: requestId }),
});
type Operation = keyof ReturnType<typeof rules>;
const teamOperations: readonly Operation[] = ['spawn_member', 'member_get'];
const manageOperations = (Object.keys(rules(false)) as Operation[]).filter(operation => !teamOperations.includes(operation));
const accessErrors = ['INVALID_CONTRACT', 'CONFLICT', 'NOT_ALLOWED', 'NOT_FOUND', 'OPERATION_UNKNOWN', 'DEPLOYMENT_FAILED']
  .map(code => ({ code, retryable: code === 'OPERATION_UNKNOWN' }));
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

export interface DynamicDeploymentRequest {
  id: string;
  manifest: ServiceManifest;
  source: Uint8Array;
  sourceDigest: string;
  signal: AbortSignal;
  resources: ReturnType<typeof createOwnedResources>;
}

export interface DynamicLeadWorkerOptions {
  deploy(request: DynamicDeploymentRequest): Promise<{ registration: ServiceRegistration; deploymentRef: string; verification?: unknown }>;
  externalServices?: Readonly<Record<string, { registration: ServiceRegistration; deploymentRef: string; implementationId: string }>>;
  initialFiles?: Readonly<Record<string, string>>;
  projectFiles?: FileTree;
  goal: string;
  verifyFinal?(input: {
    repositoryUrl: string; token: string; commit: string; sha256: string; signal: AbortSignal;
    resources: ReturnType<typeof createOwnedResources>;
  }): Promise<{ ok: boolean; [key: string]: unknown }>;
}

type MemberActor = Awaited<ReturnType<Awaited<ReturnType<typeof prepareLeadWorkerGit>>['prepareMember']>>;
type MemberRequest = {
  profile: string; status: 'preparing' | 'ready' | 'failed'; agentId?: string; error?: string;
  actor?: MemberActor; settled?: Promise<JsonValue>;
};
type DeploymentRequest = { id: string; fingerprint: string; sourceDigest?: string; verification?: unknown; work?: Promise<JsonValue> };

export function dynamicServices(role: 'lead' | 'helper') {
  return {
    board: dynamicBoardPermissions[role],
    gitea: ['pull_request_write'],
    ...(role === 'lead' ? { agent: ['access_get', 'grant', 'revoke'], manage: manageOperations, team: teamOperations } : {}),
  };
}

function checkManifest(input: { id: string; title: string; purpose: string }, project: boolean): ServiceManifest {
  const operation = project ? 'check_project' : 'check_orders';
  return {
    id: input.id, title: input.title, purpose: input.purpose, provider_version: '1', contract_version: '2',
    endpoint: { transport: 'http-json', url: 'http://127.0.0.1:8080' },
    capabilities: [{
      name: operation, operation,
      description: project ? 'Check text input against a project requirement.' : 'Check a JSONL orders candidate using the shared task specification.',
      side_effect: 'read', idempotent: true, help: { when: project
        ? 'Submit text from a project artifact to the team checker.' : 'Check valid and invalid JSONL data from a named Git candidate.' },
      input_schema: object({ [project ? 'text' : 'jsonl']: { type: 'string', maxLength: 131072 } }),
      output_schema: { type: 'object' }, path: `/v2/${operation}`, timeout_ms: 10000, errors: [],
    }],
  };
}

export function createDynamicLeadWorker({
  options, getRuntime, team, runId, model, image, facilities, board, git, resources, signal, addSecret, includeGit, exportLimit,
}: {
  options: DynamicLeadWorkerOptions;
  getRuntime(): Runtime;
  team: Record<string, string>;
  runId: string;
  model: string;
  image: string;
  facilities: Awaited<ReturnType<typeof prepareLeadWorkerGit>>;
  board: ReturnType<typeof createBoard>;
  git: ReturnType<typeof createLeadWorkerGit>;
  resources: ReturnType<typeof createOwnedResources>;
  signal: AbortSignal;
  addSecret(value: string): void;
  includeGit: boolean;
  exportLimit: number;
}) {
  const project = options.projectFiles !== undefined;
  const operation = project ? 'check_project' : 'check_orders';
  const schemas = rules(project);
  let member: MemberRequest | undefined;
  let memberKey: string | undefined;
  let deployment: DeploymentRequest | undefined;
  let deploymentKey: string | undefined;
  const inflight = new Set<Promise<unknown>>();
  const known = () => getRuntime();
  const owned = (serviceId: string, caller: string) => known().services.get(serviceId)?.actorId === caller;
  const keyFor = (caller: string, request: string) => JSON.stringify([caller, request]);
  function admit() {
    if (signal.aborted) throw fail('NOT_ALLOWED', 'Lead-Worker is closing');
  }
  function track<T>(work: Promise<T>) {
    inflight.add(work);
    void work.then(() => inflight.delete(work), () => inflight.delete(work));
    return work;
  }
  function memberView(request: MemberRequest) {
    return json({ profile: request.profile, status: request.status, agentId: request.agentId,
      ...(request.actor && request.status === 'ready' ? { branch: request.actor.branch } : {}),
      ...(request.error ? { error: request.error } : {}) });
  }

  async function spawnMember(profileId: string, caller: string, request: string) {
    const key = keyFor(caller, request);
    if (member && (memberKey !== key || profileId !== member.profile)) throw fail('CONFLICT', 'The dynamic member Slot is already claimed');
    if (!member) {
      admit();
      const profile = known().profiles.get(profileId);
      if (profile?.actorId !== caller) throw fail('NOT_ALLOWED', 'Profile is outside the Lead delegation scope');
      member = { profile: profileId, status: 'preparing' };
      memberKey = key;
    }
    if (member.status !== 'preparing') return memberView(member);
    const current = member;
    current.settled ??= track((async () => {
      try {
        admit();
        current.actor ??= await facilities.prepareMember(signal);
        const actor = current.actor;
        addSecret(actor.token);
        admit();
        const agent = await known().spawn({
          profile: profileId, parentId: caller, ...(project ? { files: options.projectFiles } : {}), requestId: `member-${createHash('sha256').update(key).digest('hex')}`,
          bindings: { board: `${runId}:board`, gitea: actor.binding },
          secretEnv: { GITEA_TOKEN: actor.token, WORK_BRANCH: actor.branch, GITEA_USERNAME: actor.username,
            GIT_AUTHOR_NAME: actor.username, GIT_AUTHOR_EMAIL: `${actor.username}@murm.invalid`,
            GIT_COMMITTER_NAME: actor.username, GIT_COMMITTER_EMAIL: `${actor.username}@murm.invalid` },
          collect: { paths: ['.'], includeGit, maxBytes: exportLimit, required: true },
        });
        current.agentId = agent.id;
        admit();
        const { accountId, username, branch } = actor;
        board.prepareMember({ agentId: agent.id, profile: profileId, requestId: request, git: { accountId, username, branch } });
        git.addMember({ agentId: agent.id, profile: profileId, actor });
        board.readyMember(agent.id);
        team[profileId] = agent.id;
        current.status = 'ready';
        current.error = undefined;
      } catch (caught) {
        const error = caught as Error & { code?: string; agentId?: string };
        current.agentId ??= error.agentId;
        current.error = error.code ?? 'MEMBER_PREPARE_FAILED';
        if (current.error !== 'OPERATION_UNKNOWN') current.status = 'failed';
      }
      return memberView(current);
    })().finally(() => { current.settled = undefined; }));
    return current.settled;
  }

  async function deploy(input: { source_path: string; manifest: { id: string; title: string; purpose: string } }, caller: string, request: string) {
    const key = keyFor(caller, request);
    const manifest = checkManifest(input.manifest, project);
    const fingerprint = JSON.stringify([input.source_path, manifest]);
    if (deployment) {
      if (deploymentKey !== key || deployment.fingerprint !== fingerprint) throw fail('CONFLICT', 'The dynamic Service is already claimed');
      if (deployment.work) return deployment.work;
    } else {
      admit();
      if (known().services.get(manifest.id) || ['agent', 'manage', 'team'].includes(manifest.id)) throw fail('CONFLICT');
      new ServiceRegistry().registerService({ manifest, adapter: { invoke: () => null } });
      deployment = { id: manifest.id, fingerprint };
      deploymentKey = key;
    }
    admit();
    const current = deployment;
    current.work = track((async () => {
      const snapshot = await known().files.snapshot(caller, {
        requestId: `service-${createHash('sha256').update(key).digest('hex')}`, paths: [input.source_path], maxBytes: maxSourceBytes,
      });
      const entry = (snapshot.files as FileTree)[input.source_path];
      if (!entry || Object.keys(snapshot.files).length !== 1) throw fail('INVALID_CONTRACT', 'Service requires one source file');
      const source = Buffer.from(entry.data, entry.encoding);
      current.sourceDigest = createHash('sha256').update(source).digest('hex');
      admit();
      const ready = await options.deploy({ id: manifest.id, manifest, source, sourceDigest: current.sourceDigest, signal, resources });
      current.verification = ready.verification;
      admit();
      return json(await known().services.register({
        requestId: request, actorId: caller, registration: ready.registration, deploymentRef: ready.deploymentRef,
        implementationId: current.sourceDigest, ownership: 'run',
      }));
    })().catch(error => {
      // Before a source identity exists, the same snapshot request can recover
      // a lost reply. Once deployment begins, never allocate again on replay.
      if (!current.sourceDigest && error?.code === 'OPERATION_UNKNOWN') current.work = undefined;
      throw error;
    }));
    return current.work;
  }

  function register(registry: ServiceRegistry) {
    for (const [service, list] of [['manage', manageOperations], ['team', teamOperations]] as const) {
      registry.registerService({
        manifest: {
          id: service, title: `Lead-Worker ${service}`, purpose: 'Manage the current team and its scoped checking capability.',
          contract_version: '2', provider_version: '1', endpoint: { transport: 'in-process' },
          capabilities: list.map(operation => ({
            name: operation, operation, description: operation.replaceAll('_', ' '),
            help: { when: 'Use the current Run and the Lead delegation scope.' },
            input_schema: schemas[operation], output_schema: { anyOf: [{ type: 'object' }, { type: 'array' }, { type: 'null' }] },
            side_effect: /_(get|list)$/.test(operation) ? 'read' : 'write', idempotent: true, errors: accessErrors, timeout_ms: 60_000,
          })),
        },
        adapter: { async invoke({ caller, capability, input, envelope, assertAuthorized }) {
          if (caller.agentId !== team.lead || caller.runtimeId !== known().id) throw fail('NOT_ALLOWED');
          assertAuthorized();
          const request = envelope.operation_id;
          if (!new RegExp(requestId.pattern).test(request)) throw fail('INVALID_CONTRACT');
          const value = input as any;
          switch (capability.operation as Operation) {
            case 'profile_register': {
              admit();
              const serviceId = value.check_service_id;
              if (serviceId !== undefined && !owned(serviceId, caller.agentId)) throw fail('NOT_ALLOWED');
              const profile: Profile = {
                model, image, writable: true, prompt: `${project ? [projectDynamicWorkerPrompt, seededCheckoutInstruction].join('\n\n') : dynamicWorkerPrompt}\n\n${value.prompt}`,
                network: { allow: [new URL(facilities.repositoryUrl).origin] },
                env: { ...(facilities.initialCommit ? { RUN_INITIAL_COMMIT: facilities.initialCommit } : {}), RUN_REPOSITORY: facilities.repositoryUrl, RUN_OWNER: facilities.repository.owner,
                  RUN_REPO: facilities.repository.name, GIT_TERMINAL_PROMPT: '0' },
                services: { ...dynamicServices('helper'), ...(serviceId === undefined ? {} : { [serviceId]: [operation] }) },
              };
              return json(await known().profiles.register({ actorId: caller.agentId, requestId: request, id: value.id, profile }));
            }
            case 'profile_get': return json(known().profiles.get(value.id));
            case 'profile_list': return json(known().profiles.list());
            case 'service_deploy': return deploy(value, caller.agentId, request);
            case 'service_register': {
              admit();
              if (!Object.hasOwn(options.externalServices ?? {}, value.reference)) throw fail('NOT_ALLOWED');
              const ready = options.externalServices![value.reference];
              return json(await known().services.register({ ...ready, ownership: 'external', requestId: request, actorId: caller.agentId }));
            }
            case 'service_get': return json(known().services.get(value.id));
            case 'service_list': return json(known().services.list());
            case 'service_retire':
              if (!owned(value.id, caller.agentId)) throw fail('NOT_ALLOWED');
              return json(await known().services.retire({ actorId: caller.agentId, requestId: request, serviceId: value.id }));
            case 'spawn_member': return spawnMember(value.profile, caller.agentId, request);
            case 'member_get': return member && memberKey === keyFor(caller.agentId, value.request_id) ? memberView(member) : null;
          }
        } },
      });
    }
  }

  const agentAccessPolicy: AgentAccessPolicy = request => {
    if (request.callerId !== team.lead || request.agentId === team.lead || !board.snapshot().members[request.agentId]?.ready) return false;
    return request.operation === 'access_get' || owned(request.serviceId, request.callerId) &&
      request.operations.every(requested => requested === operation);
  };

  return {
    register, agentAccessPolicy,
    async settled(timeoutMs: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.allSettled([...inflight]).then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    },
    snapshot: () => ({ member: member ? memberView(member) : null,
      deployment: deployment ? { id: deployment.id, sourceDigest: deployment.sourceDigest, verification: deployment.verification } : null }),
  };
}
