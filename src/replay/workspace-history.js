import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { SwarmEnvError } from '../errors.js';
import { readWorkspaceHistory, WORKSPACE_HISTORY_DIR, WorkspaceRepository, writeWorkspaceJson } from '../runtime/workspace-repository.js';
import { parseReplayTime } from './service-history.js';

const run = promisify(execFile);
const META = '.swarm-workspace.json';
const revisionId = value => typeof value === 'string' && /^\d+\.\d+$/.test(value);
const objectId = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const eventFile = sequence => `${String(sequence).padStart(12, '0')}.json`;
const unavailable = (message, details) => new SwarmEnvError('REPLAY_HISTORY_INCOMPLETE', message, details);
const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' });

async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw unavailable('Workspace historical metadata is missing or unreadable', { file: path, reason: error.code ?? error.name }); }
}

async function physicalDestination(path) {
  const absolute = resolve(path);
  if (await exists(absolute)) return realpath(absolute);
  const parent = dirname(absolute);
  return join(await physicalDestination(parent), absolute.slice(parent.length));
}

function validateRecord(record, workspaceId) {
  if (record?.format_version !== 2 || record.workspace_id !== workspaceId || !record.mission_id ||
      !Array.isArray(record.revisions) || !record.revisions.length || !record.revisions.every(revisionId) ||
      new Set(record.revisions).size !== record.revisions.length || !record.revisions.includes(record.main_revision) || !objectId(record.main_commit)) {
    throw unavailable('Workspace format or public revision index cannot be replayed', { workspace_id: workspaceId });
  }
}

async function readRevisions(source, ids) {
  const revisions = new Map();
  for (const id of ids) {
    const revision = await readJson(join(source, '.swarm-revisions', `${id}.json`));
    if (revision.revision !== id || !objectId(revision.git_commit) || !objectId(revision.git_tree) ||
        !Array.isArray(revision.parents) || !revision.parents.every(revisionId) || !Number.isFinite(Date.parse(revision.created_at))) {
      throw unavailable('Workspace revision lacks complete historical identity', { revision: id });
    }
    revisions.set(id, revision);
  }
  return revisions;
}

function legacyRecord(latest, revisions, at) {
  const visible = latest.revisions.filter(id => Date.parse(revisions.get(id).created_at) <= Date.parse(at));
  const visibleSet = new Set(visible);
  // Main advances only through merge. Its first parent is the previous main;
  // unrelated saves, even newer ones, must never become the replayed main.
  let main = latest.main_revision;
  const visited = new Set();
  while (!visibleSet.has(main)) {
    if (visited.has(main)) throw unavailable('Workspace main ancestry contains a cycle', { revision: main });
    visited.add(main);
    const previous = revisions.get(main)?.parents[0];
    if (!previous) throw unavailable('Requested time precedes the Workspace history', { requested_at: at, created_at: latest.created_at });
    main = previous;
  }
  const last = visible.at(-1);
  const [major, minor] = last.split('.').map(Number);
  const updatedAt = new Date(Math.max(...visible.map(id => Date.parse(revisions.get(id).created_at)))).toISOString();
  return { format_version: 2, workspace_id: latest.workspace_id, mission_id: latest.mission_id,
    main_revision: main, main_commit: revisions.get(main).git_commit,
    next_revision: `${major}.${minor + 1}`, revisions: visible,
    frozen_submission_id: null, freeze_epoch: 0, metadata: latest.metadata,
    created_at: latest.created_at, updated_at: updatedAt };
}

async function legacyReceipts(source, revisions) {
  const receipts = new Map();
  for (const revision of revisions.values()) {
    if (!revision.request_id) continue;
    const key = createHash('sha256').update(revision.request_id).digest('hex');
    const path = join(source, '.swarm-requests', `${key}.json`);
    if (!await exists(path)) continue;
    const receipt = await readJson(path);
    const result = receipt.result;
    // Only a successful receipt bound to this immutable public revision can
    // be dated in the old format. Undated failures/checking attempts are not
    // copied from the future into the new run.
    if (receipt.key === key && !receipt.error && result &&
        ((result.revision === revision.revision && result.git_commit === revision.git_commit) ||
         (result.main_revision === revision.revision && result.main_commit === revision.git_commit))) {
      if (Array.isArray(result.revisions) && result.revisions.some(id => !revisions.has(id))) continue;
      receipts.set(key, receipt);
    }
  }
  return receipts;
}

async function copyObjects(source, destination, commits) {
  const options = { env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] };
  const pack = spawn('git', ['-C', source, 'pack-objects', '--revs', '--stdout'], options);
  const unpack = spawn('git', ['-C', destination, 'unpack-objects', '-r'], options);
  let packError = '', unpackError = '';
  pack.stderr.on('data', chunk => { packError = (packError + chunk).slice(-4000); });
  unpack.stderr.on('data', chunk => { unpackError = (unpackError + chunk).slice(-4000); });
  const completion = child => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Git exited with ${code ?? signal}`)));
  });
  const finished = Promise.all([completion(pack), completion(unpack)]);
  const timer = setTimeout(() => { pack.kill('SIGKILL'); unpack.kill('SIGKILL'); }, 120_000);
  pack.stdout.pipe(unpack.stdin);
  // A missing object or failed destination can close its peer's pipe first.
  pack.stdin.on('error', () => {});
  unpack.stdin.on('error', () => {});
  pack.stdin.end([...new Set(commits)].join('\n') + '\n');
  try { await finished; }
  catch (error) {
    pack.kill('SIGKILL'); unpack.kill('SIGKILL');
    throw unavailable('Referenced Workspace Git objects could not be restored', { reason: packError || unpackError || error.message });
  } finally { clearTimeout(timer); }
}

async function sourceMark(source) {
  const meta = await readFile(join(source, META));
  const head = await readFile(join(source, WORKSPACE_HISTORY_DIR, 'head.json')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
  return createHash('sha256').update(meta).update(head).digest('hex');
}

/** Rebuild an ended experiment's public Workspace at a time chosen afterwards. */
export async function restoreWorkspaceAt({ sourceRoot, destinationRoot, workspaceId, at }) {
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspaceId)) {
    throw new SwarmEnvError('INVALID_CONTRACT', 'workspaceId is required and must be a safe identifier');
  }
  const requestedAt = parseReplayTime(at);
  const sourceContainer = await realpath(resolve(sourceRoot));
  const destinationContainer = await physicalDestination(destinationRoot);
  if (sourceContainer === destinationContainer || sourceContainer.startsWith(destinationContainer + sep) || destinationContainer.startsWith(sourceContainer + sep)) {
    throw new SwarmEnvError('NOT_ALLOWED', 'Historical Workspace source and destination must be separate');
  }
  const source = join(sourceContainer, workspaceId);
  const destination = join(destinationContainer, workspaceId);
  if (await exists(join(source, '.swarm-journal.json'))) throw unavailable('Source Workspace has an unsettled publication; finish its ordinary recovery before replay');
  const originalMark = await sourceMark(source);
  const latest = await readJson(join(source, META));
  validateRecord(latest, workspaceId);
  const events = readWorkspaceHistory(source);
  if (events.length && JSON.stringify(events.at(-1).record) !== JSON.stringify(latest)) {
    throw unavailable('Workspace current metadata is not covered by its committed history');
  }
  const prefix = events.filter(event => Date.parse(event.committed_at) <= Date.parse(requestedAt));
  if (events[0]?.kind === 'create' && !prefix.length) {
    throw unavailable('Requested time precedes the committed Workspace creation', { requested_at: requestedAt, created_at: events[0].committed_at });
  }
  let workspace, selectedRevisions, receipts, history;
  if (prefix.length) {
    workspace = structuredClone(prefix.at(-1).record);
    validateRecord(workspace, workspaceId);
    selectedRevisions = await readRevisions(source, workspace.revisions);
    receipts = new Map(prefix.filter(event => event.receipt).map(event => [event.receipt.key, event.receipt]));
    history = { mode: 'recorded', requested_at: requestedAt, selected_at: prefix.at(-1).committed_at,
      sequence: prefix.at(-1).sequence, warnings: [] };
  } else {
    const revisions = await readRevisions(source, latest.revisions);
    workspace = legacyRecord(latest, revisions, requestedAt);
    selectedRevisions = new Map(workspace.revisions.map(id => [id, revisions.get(id)]));
    receipts = await legacyReceipts(source, selectedRevisions);
    history = { mode: 'legacy', requested_at: requestedAt, selected_at: workspace.updated_at, sequence: null,
      warnings: ['Legacy Workspace times identify revision creation; exact publication commit times were not recorded.',
        'Legacy freeze state and undated request attempts require new-run handoff; they are not inferred from the final Workspace.'] };
  }
  if (selectedRevisions.get(workspace.main_revision)?.git_commit !== workspace.main_commit) {
    throw unavailable('Historical main points to a different immutable commit', { revision: workspace.main_revision });
  }
  for (const revision of selectedRevisions.values()) {
    if (revision.parents.some(parent => !selectedRevisions.has(parent))) {
      throw unavailable('A visible Workspace revision has an unavailable historical parent', { revision: revision.revision });
    }
  }
  await mkdir(destinationContainer, { recursive: true });
  // Reserve an empty target. The final rename publishes the complete restored
  // repository; existing data are never overwritten.
  await mkdir(destination);
  let stage;
  try {
    stage = await mkdtemp(join(destinationContainer, '.swarm-restore-'));
    const repository = new WorkspaceRepository();
    await repository.initialize(stage);
    await copyObjects(source, stage, [...selectedRevisions.values()].map(revision => revision.git_commit));
    for (const revision of selectedRevisions.values()) {
      const tree = (await run('git', ['-C', stage, 'rev-parse', `${revision.git_commit}^{tree}`], { env: gitEnvironment() })).stdout.trim();
      if (tree !== revision.git_tree) throw unavailable('Historical Workspace tree identity does not match its commit', { revision: revision.revision });
      await run('git', ['-C', stage, 'update-ref', `refs/swarm/revisions/${revision.revision}`, revision.git_commit], { env: gitEnvironment() });
      writeWorkspaceJson(join(stage, '.swarm-revisions', `${revision.revision}.json`), revision);
    }
    await run('git', ['-C', stage, 'update-ref', 'refs/heads/main', workspace.main_commit], { env: gitEnvironment() });
    await run('git', ['-C', stage, 'read-tree', '--reset', workspace.main_commit], { env: gitEnvironment() });
    writeWorkspaceJson(join(stage, META), workspace);
    for (const [key, receipt] of receipts) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw unavailable('Workspace receipt has an invalid identity');
      writeWorkspaceJson(join(stage, '.swarm-requests', `${key}.json`), receipt);
    }
    const restoredEvents = prefix.length ? prefix : [{ version: 1, sequence: 1, event_id: `restore:${randomUUID()}`,
      previous_event_id: null, committed_at: requestedAt, kind: 'restore', record: workspace, revision: null, receipt: null }];
    if (!prefix.length) {
      for (const receipt of receipts.values()) {
        const previous = restoredEvents.at(-1);
        restoredEvents.push({ version: 1, sequence: previous.sequence + 1, event_id: `restore:${randomUUID()}`,
          previous_event_id: previous.event_id, committed_at: requestedAt, kind: 'receipt', record: workspace, revision: null, receipt });
      }
    }
    for (const event of restoredEvents) writeWorkspaceJson(join(stage, WORKSPACE_HISTORY_DIR, eventFile(event.sequence)), event);
    const head = restoredEvents.at(-1);
    writeWorkspaceJson(join(stage, WORKSPACE_HISTORY_DIR, 'head.json'), { sequence: head.sequence, event_id: head.event_id, committed_at: head.committed_at });
    if (await exists(join(source, '.swarm-journal.json')) || await sourceMark(source) !== originalMark) {
      throw unavailable('Source Workspace changed while its history was being read');
    }
    await rename(stage, destination);
    stage = null;
    return { workspace, history };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    // rmdir only removes our empty reservation, never a populated repository.
    await rmdir(destination).catch(error => { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error; });
  }
}
