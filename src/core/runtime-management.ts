import { createHash } from 'node:crypto';
import type {
  AgentAccess, AgentAccessGrant, AgentAccessMutation, ErrorInfo, PendingCleanup, Profile, ProfileDefinition, ProfileRegistration, RuntimeManagementChange,
  RuntimeServiceDefinition, RuntimeServiceRegistration, ServiceRetirement,
} from './types.js';
import type { ServiceRegistration } from './services.js';
import { registerServicePrivateValues, snapshotServiceRegistration } from './services.js';
import { validId } from './config.js';

function problem(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function digest(input: unknown) {
  const serialized = JSON.stringify(input, (_, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en')));
  });
  return createHash('sha256').update(serialized).digest('hex');
}

type ExportResult = { path?: string; error?: ErrorInfo };
interface RegisteredService {
  definition: RuntimeServiceDefinition;
  registration: ServiceRegistration;
  dynamic: boolean;
  work?: Promise<void>;
  exported?: ExportResult;
  retirement?: { requestId: string; caller: string };
}

interface AccessState {
  version: number;
  services: AgentAccess['services'];
  bindings: Readonly<Record<string, string>>;
  generations: Map<string, number>;
}

const generationKey = (service: string, operation: string) => JSON.stringify([service, operation]);

const protectedServices = new Set(['agent', 'manage', 'team']);

export function createRuntimeManagement({
  profiles, registrations, validateProfile, isClosing, redact, addSecrets, changed, drainService, exportService, isAgentLive, cancelAccess,
}: {
  profiles: Map<string, Profile>;
  registrations: Map<string, ServiceRegistration>;
  validateProfile(id: string, profile: Profile): Profile;
  isClosing(): boolean;
  isAgentLive(agentId: string): boolean;
  cancelAccess(agentId: string, serviceId: string, operations: ReadonlySet<string>): void;
  redact(value: unknown): unknown;
  addSecrets(values: readonly string[]): void;
  drainService(id: string): Promise<void>;
  exportService(registration: ServiceRegistration): Promise<ExportResult | undefined>;
  changed(change: RuntimeManagementChange): void;
}) {
  let sequence = 0;
  const definitions = new Map([...profiles].map(([id, profile]) => [id, { id, digest: digest(profile), sequence }]));
  const requests = new Map<string, { digest: string; definition: ProfileDefinition }>();

  const serviceRequests = new Map<string, { digest: string; adapter: ServiceRegistration['adapter']; result: RuntimeServiceDefinition }>();
  const services = new Map<string, RegisteredService>();
  const access = new Map<string, AccessState>();
  const accessRequests = new Map<string, { fingerprint: string; access: AgentAccess }>();
  for (const [id, registration] of registrations) {
    services.set(id, { registration, definition: { id, manifest: registration.manifest, state: 'ready', sequence }, dynamic: false });
  }

  function profileGet(id: string): ProfileDefinition | null {
    const definition = definitions.get(id);
    return definition ? redact({ ...definition, profile: profiles.get(id)! }) as ProfileDefinition : null;
  }

  function profileList() {
    return [...definitions.keys()].map(id => profileGet(id)!);
  }

  async function registerProfile(input: ProfileRegistration, caller = 'host') {
    if (!validId(input?.id) || !validId(input?.requestId)) {
      throw problem('INVALID_CONTRACT', 'Profile registration requires a valid ID and requestId');
    }
    const { id, profile, requestId } = input;
    const key = JSON.stringify([caller, id, requestId]);
    let definitionDigest;
    try { definitionDigest = digest(profile); }
    catch { throw problem('INVALID_CONTRACT', 'Profile definition cannot be serialized'); }
    const previous = requests.get(key);
    if (previous) {
      if (previous.digest !== definitionDigest) throw problem('CONFLICT', 'Profile request has different parameters');
      return structuredClone(previous.definition);
    }
    if (isClosing()) throw problem('NOT_ALLOWED', 'Runtime is closing');
    if (definitions.has(id)) throw problem('CONFLICT', 'Profile ID is already registered');
    let snapshot;
    try { snapshot = validateProfile(id, profile); }
    catch (error) { throw problem('INVALID_CONTRACT', redact((error as Error).message) as string); }
    profiles.set(id, snapshot);
    definitions.set(id, { id, digest: digest(snapshot), sequence: ++sequence });
    const definition = profileGet(id)!;
    requests.set(key, { digest: definitionDigest, definition });
    changed({ operation: 'profile.register', sequence, caller, requestId, definition });
    return structuredClone(definition);
  }

  function serviceGet(id: string): RuntimeServiceDefinition | null {
    const entry = services.get(id);
    return entry ? redact(entry.definition) as RuntimeServiceDefinition : null;
  }

  function serviceList() {
    return [...services.keys()].map(id => serviceGet(id)!);
  }

  async function registerService(input: RuntimeServiceRegistration, caller = 'host') {
    const id = input?.registration?.manifest?.id;
    if (!validId(id) || !validId(input.requestId) || !validId(input.deploymentRef) || !validId(input.implementationId)
      || !['run', 'external'].includes(input.ownership)) {
      throw problem('INVALID_CONTRACT', 'Service registration requires IDs, implementation and ownership');
    }
    if (protectedServices.has(id)) throw problem('NOT_ALLOWED', 'Management Service ID is reserved');
    const { requestId, registration, deploymentRef, implementationId, ownership } = input;
    const key = JSON.stringify([caller, id, requestId]);
    let fingerprint;
    try { fingerprint = digest({ manifest: registration.manifest, deploymentRef, implementationId, ownership }); }
    catch { throw problem('INVALID_CONTRACT', 'Service definition cannot be serialized'); }
    const previous = serviceRequests.get(key);
    if (previous) {
      if (previous.digest !== fingerprint || previous.adapter !== registration.adapter) throw problem('CONFLICT', 'Service request has different parameters');
      return redact(previous.result) as RuntimeServiceDefinition;
    }
    if (isClosing()) throw problem('NOT_ALLOWED', 'Runtime is closing');
    if (services.has(id)) throw problem('CONFLICT', 'Service ID is already registered');
    const snapshot = snapshotServiceRegistration(registration);
    const definition: RuntimeServiceDefinition = {
      id, manifest: snapshot.manifest, deploymentRef, implementationId, ownership, state: 'ready', sequence: ++sequence,
    };
    registrations.set(id, snapshot);
    services.set(id, { registration: snapshot, definition, dynamic: true });
    registerServicePrivateValues(new Map([[id, snapshot]]), addSecrets);
    serviceRequests.set(key, { digest: fingerprint, adapter: registration.adapter, result: definition });
    changed({ operation: 'service.register', sequence, caller, requestId, definition });
    return serviceGet(id)!;
  }

  function updateRetirement(service: RegisteredService, state: 'retiring' | 'retired', error?: ErrorInfo) {
    const { error: _error, ...prior } = service.definition;
    service.definition = { ...prior, state, sequence: ++sequence, ...(error ? { error } : {}) };
    changed({ operation: 'service.retire', sequence, ...service.retirement!, definition: service.definition });
  }

  async function retireService(input: ServiceRetirement, caller = 'host') {
    const timeoutMs = input?.timeoutMs ?? 60_000;
    if (!validId(input?.serviceId) || !validId(input.requestId)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
      throw problem('INVALID_CONTRACT', 'Service retirement requires IDs and a bounded timeout');
    }
    const { serviceId, requestId } = input;
    if (protectedServices.has(serviceId)) throw problem('NOT_ALLOWED', 'Management Service cannot be retired');
    const service = services.get(serviceId);
    if (!service) throw problem('NOT_FOUND', 'Service is not registered');
    if (service.definition.state === 'ready') {
      registrations.delete(serviceId);
      service.retirement = { requestId, caller };
      updateRetirement(service, 'retiring');
    }
    if (service.definition.state === 'retiring') {
      service.work ??= (async () => {
        await drainService(serviceId);
        const result = await exportService(service.registration);
        if (result?.error) updateRetirement(service, 'retiring', result.error);
        else {
          service.exported = result;
          updateRetirement(service, 'retired');
        }
      })().finally(() => { service.work = undefined; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([service.work, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
      } finally { clearTimeout(timer); }
    }
    return serviceGet(serviceId)!;
  }

  function ownedRetirements() {
    return [...services.values()].filter(service => service.dynamic || service.retirement !== undefined);
  }

  async function retireAll(timeoutMs: number) {
    await Promise.all(ownedRetirements().map(({ definition }) => retireService({
      serviceId: definition.id, requestId: 'runtime-close', timeoutMs,
    })));
  }

  function pendingServices(): PendingCleanup[] {
    return ownedRetirements().filter(service => service.definition.state !== 'retired').map(({ definition }) => ({
      kind: 'service', id: definition.id, action: 'retire-service', ...(definition.error ? { error: definition.error } : {}),
      ...(definition.deploymentRef ? { resourceKey: definition.deploymentRef } : {}),
    }));
  }

  function initAccess(agentId: string, services: AgentAccess['services'], bindings?: AccessState['bindings']) {
    access.set(agentId, { version: 0, services, bindings: bindings ?? {}, generations: new Map() });
  }

  function accessGet(agentId: string): AgentAccess | null {
    const entry = access.get(agentId);
    if (!entry) return null;
    return { agentId, version: entry.version, services: Object.fromEntries(Object.entries(entry.services)
      .filter(([serviceId]) => registrations.has(serviceId)).map(([serviceId, operations]) => [serviceId, [...operations]])) };
  }

  async function mutateAccess(kind: 'grant' | 'revoke', input: AgentAccessGrant, caller = 'host') {
    const binding = input?.binding;
    if (!validId(input?.agentId) || !validId(input.serviceId) || !validId(input.requestId)
      || !Array.isArray(input.operations) || !input.operations.length || !input.operations.every(validId)
      || new Set(input.operations).size !== input.operations.length
      || (binding !== undefined && (kind === 'revoke' || typeof binding !== 'string' || !binding))) {
      throw problem('INVALID_CONTRACT', 'Access mutation requires an Agent, Service, operations and requestId');
    }
    const { agentId, serviceId, requestId } = input;
    const operations = [...input.operations].sort();
    const key = JSON.stringify([kind, caller, agentId, serviceId, requestId]);
    const fingerprint = digest({ operations, binding });
    const previous = accessRequests.get(key);
    if (previous) {
      if (fingerprint !== previous.fingerprint) throw problem('CONFLICT', 'Access request has different parameters');
      return structuredClone(previous.access);
    }
    const state = access.get(agentId);
    if (!state) throw problem('NOT_FOUND', 'Agent is not registered');
    if (kind === 'grant' && (isClosing() || !isAgentLive(agentId))) throw problem('NOT_ALLOWED', 'Agent cannot receive new access');
    const registration = kind === 'grant' ? registrations.get(serviceId) : services.get(serviceId)?.registration;
    if (!registration || operations.some(operation => !registration.manifest.capabilities.some(item => item.operation === operation))) {
      throw problem('INVALID_CONTRACT', 'Service or operation is unavailable');
    }
    const existingBinding = Object.hasOwn(state.bindings, serviceId) ? state.bindings[serviceId] : undefined;
    if (binding !== undefined && existingBinding !== undefined && binding !== existingBinding) {
      throw problem('CONFLICT', 'Service binding cannot be replaced');
    }
    const prior = new Set(Object.hasOwn(state.services, serviceId) ? state.services[serviceId] : []);
    const affected = operations.filter(operation => kind === 'grant' ? !prior.has(operation) : prior.has(operation));
    const bind = binding !== undefined && existingBinding === undefined;
    if (affected.length || bind) {
      const version = ++state.version;
      for (const operation of affected) {
        if (kind === 'grant') prior.add(operation);
        else prior.delete(operation);
        state.generations.set(generationKey(serviceId, operation), version);
      }
      const next = { ...state.services };
      if (prior.size) Object.defineProperty(next, serviceId, { value: [...prior], enumerable: true, configurable: true });
      else delete next[serviceId];
      state.services = next;
      if (bind) {
        addSecrets([binding]);
        state.bindings = { ...state.bindings, [serviceId]: binding };
      }
      if (kind === 'revoke') cancelAccess(agentId, serviceId, new Set(affected));
    }
    const result = accessGet(agentId)!;
    accessRequests.set(key, { fingerprint, access: result });
    if (affected.length || bind) changed({
      operation: kind === 'grant' ? 'access.grant' : 'access.revoke', sequence: ++sequence, caller, requestId,
      access: result, serviceId, operations,
    });
    return structuredClone(result);
  }

  function bridgeAccess(agentId: string) {
    const state = access.get(agentId)!;
    return { services: state.services, bindings: state.bindings, accessVersion: state.version,
      accessGeneration: (serviceId: string, operation: string) => state.generations.get(generationKey(serviceId, operation)) ?? 0 };
  }

  return {
    profiles: Object.freeze({ register: (input: ProfileRegistration) => registerProfile(input), get: profileGet, list: profileList }),
    services: Object.freeze({ register: (input: RuntimeServiceRegistration) => registerService(input), get: serviceGet, list: serviceList,
      retire: (input: ServiceRetirement) => retireService(input) }),
    access: Object.freeze({ get: accessGet,
      grant: (input: AgentAccessGrant) => mutateAccess('grant', input), revoke: (input: AgentAccessMutation) => mutateAccess('revoke', input) }),
    mutateAccess, initAccess, bridgeAccess,
    retireAll, pendingServices,
    retiredExports: () => ownedRetirements().flatMap(({ definition, exported }) => exported ? [{ serviceId: definition.id, ...exported }] : []),
    profileDigest: (id: string) => definitions.get(id)?.digest,
    snapshot: () => ({ sequence, profiles: profileList(), services: serviceList(), access: [...access.keys()].map(id => accessGet(id)!) }),
  };
}
