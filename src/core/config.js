import { isIPv4 } from 'node:net';
import { snapshotFileSeed } from '../../scripts/core-file-seed.mjs';
import { snapshotCollectionSpec } from '../../scripts/core-collection.mjs';

export function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function record(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function strings(value) {
  return Array.isArray(value) && value.every(validId) && new Set(value).size === value.length;
}

export function validateEnvironment(value, name) {
  if (value === undefined) return;
  if (!record(value)) throw new TypeError(`${name} must be a map of environment variables`);
  const reserved = /^(?:SWARMENV_|PI_|PATH$|HOME$|TMPDIR$|TMP$|TEMP$|USER$|LOGNAME$|SHELL$|PWD$|OLDPWD$|NODE_OPTIONS$|BASH_ENV$|ENV$|LD_|XDG_)/;
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || reserved.test(key) ||
        typeof item !== 'string' || item.length > 4096 || item.includes('\0')) {
      throw new TypeError(`${name} contains an invalid or reserved key: ${key}`);
    }
  }
}

function origin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/\d+\.\d+\.\d+\.\d+(?::\d+)?\/?$/.test(value)) return false;
  const url = new URL(value);
  return isIPv4(url.hostname) && !url.hostname.startsWith('127.') && url.hostname !== '0.0.0.0' && url.port !== '0';
}

function snapshotCollection(value) {
  if (value === undefined) return undefined;
  if (!record(value)) throw new TypeError('collect must be a CollectionSpec object');
  return snapshotCollectionSpec(value);
}

export function snapshotProfiles(profiles, models, registrations) {
  if (!record(profiles) || Object.keys(profiles).length === 0) throw new TypeError('At least one Profile is required');
  const snapshots = new Map();
  for (const [name, input] of Object.entries(profiles)) {
    if (!validId(name) || !record(input) || typeof input.prompt !== 'string' ||
        typeof input.writable !== 'boolean' || typeof input.image !== 'string' || !input.image.trim() ||
        !record(input.services)) throw new TypeError(`Invalid Profile: ${name}`);
    if (typeof input.model !== 'string' || !Object.hasOwn(models, input.model)) {
      throw new TypeError(`Profile ${name} references unknown model ${input.model}`);
    }
    validateEnvironment(input.env, `Profile ${name} env`);
    if (input.network !== undefined && (!record(input.network) ||
        !Array.isArray(input.network.allow) || !input.network.allow.every(origin))) {
      throw new TypeError(`Profile ${name} network must contain non-loopback IPv4 HTTP(S) origins`);
    }
    const collect = snapshotCollection(input.collect);
    if (input.allowContextFork !== undefined && typeof input.allowContextFork !== 'boolean') {
      throw new TypeError(`Profile ${name} has invalid allowContextFork`);
    }
    if (input.spawnProfiles !== undefined && !strings(input.spawnProfiles)) {
      throw new TypeError(`Profile ${name} has invalid spawnProfiles`);
    }
    for (const [service, operations] of Object.entries(input.services)) {
      const registration = registrations.get(service);
      if (!strings(operations) || !registration || operations.some(operation =>
        !registration.manifest.capabilities.some(capability => capability.operation === operation))) {
        throw new TypeError(`Profile ${name} references unknown Service operations in ${service}`);
      }
    }
    snapshots.set(name, { ...structuredClone(input), ...(collect === undefined ? {} : { collect }) });
  }
  for (const [name, profile] of snapshots) {
    if (profile.spawnProfiles?.some(target => !snapshots.has(target))) {
      throw new TypeError(`Profile ${name} references an unknown spawn Profile`);
    }
  }
  return snapshots;
}

export function snapshotSpawn(input, profiles, registrations) {
  if (!record(input) || !validId(input.requestId) || !profiles.has(input.profile) ||
      Object.keys(input).some(key => !['requestId', 'profile', 'parentId', 'writable', 'files', 'bindings', 'secretEnv', 'collect', 'forkFrom', 'workspace'].includes(key)) ||
      (input.writable !== undefined && typeof input.writable !== 'boolean') ||
      (input.parentId !== undefined && !validId(input.parentId)) ||
      (input.forkFrom !== undefined && !validId(input.forkFrom))) {
    throw new TypeError('Invalid spawn request or unsupported spawn options');
  }
  validateEnvironment(input.secretEnv, 'secretEnv');
  if (input.bindings !== undefined && (!record(input.bindings) || Object.entries(input.bindings).some(([service, binding]) =>
    !registrations.has(service) || typeof binding !== 'string' || !binding))) {
    throw new TypeError('Invalid Service bindings');
  }
  if (input.workspace !== undefined) {
    const workspace = input.workspace;
    if (!record(workspace) || input.files !== undefined) throw new TypeError('workspace requires an explicit configuration without files');
    if (workspace.mode === 'frozen-copy') {
      if (Object.keys(workspace).some(key => !['mode', 'files'].includes(key))) throw new TypeError('Invalid frozen-copy workspace');
      snapshotFileSeed(workspace.files);
    } else if (!['read-only', 'read-write'].includes(workspace.mode) || !validId(workspace.id) ||
        Object.keys(workspace).some(key => !['mode', 'id'].includes(key)) ||
        (input.writable !== undefined && input.writable !== (workspace.mode === 'read-write'))) {
      throw new TypeError('Shared workspace requires an id and read-only or read-write mode');
    }
  }
  const snapshot = structuredClone(input);
  if (input.workspace?.mode === 'frozen-copy') snapshot.files = snapshotFileSeed(input.workspace.files).files;
  if (input.workspace && input.workspace.mode !== 'frozen-copy') snapshot.writable = input.workspace.mode === 'read-write';
  const collect = snapshotCollection(input.collect) ?? profiles.get(input.profile).collect;
  if (collect !== undefined) snapshot.collect = collect;
  if (input.files !== undefined) snapshot.files = snapshotFileSeed(input.files).files;
  if (snapshot.secretEnv) snapshot.secretEnv = Object.fromEntries(Object.entries(snapshot.secretEnv).sort());
  if (snapshot.bindings) snapshot.bindings = Object.fromEntries(Object.entries(snapshot.bindings).sort());
  return snapshot;
}
