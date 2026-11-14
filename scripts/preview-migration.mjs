#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { stableStringify } from '../src/protocol/envelope.js';

const domains = {
  task: { tasks: ['task_id', 'state'], executions: ['execution_id', 'state', 'owner_ref'] },
  context: { materials: ['material_id', 'content_json', 'content_hash'] },
  judge: { check_results: ['check_result_id', 'verdict'] },
};
const optionalAuthority = {
  task: { bots: ['bot_id', 'state'], mission_submissions: ['submission_id', 'state'],
    execution_workspace_requests: ['request_id', 'phase'], mission_final_check_admissions: ['submission_id', 'settled_at'] },
  context: { material_attachments: ['material_id', 'name', 'media_type', 'content_hash', 'bytes'] },
  judge: { judge_mission_check_admissions: ['check_result_id', 'settled_at'] },
};
const terminal = new Set(['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FENCED', 'HANDED_OFF', 'SUPERSEDED']);
const taskStates = new Set(['OPEN', 'RUNNING', 'BLOCKED', 'DONE', 'CANCELED']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async path => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};
async function canonical(path, type) {
  if (!path) throw new Error('Required explicit input path is missing');
  path = resolve(path);
  if (await realpath(path) !== path || !(await lstat(path))[type]()) throw new Error('Input must be canonical and of the required type');
  return path;
}
async function privateDirectory(path) {
  path = await canonical(path, 'isDirectory');
  const info = await lstat(path);
  if (info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Destination parent must be owner-private');
  return path;
}
async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
async function snapshot(root, revision) {
  root = await canonical(root, 'isDirectory');
  if (!/^\d+\.\d+$/.test(revision ?? '')) throw new Error('Select a fixed public Workspace revision');
  const read = async path => JSON.parse(await readFile(await canonical(join(root, path), 'isFile'), 'utf8'));
  const journal = await lstat(join(root, '.swarm-journal.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (journal) throw new Error('Workspace has an unfinished publication journal');
  const index = await read('.swarm-workspace.json');
  if (index.format_version !== 2 || !index.revisions?.includes(revision)) throw new Error('Revision was not published in a supported public Workspace format');
  const row = await read(`.swarm-revisions/${revision}.json`);
  const oid = /^[a-f0-9]{40}$/;
  if (row.revision !== revision || !oid.test(row.git_commit) || !oid.test(row.git_tree) || row.conflicts?.length) throw new Error('Revision is not an unconflicted Git snapshot');
  await canonical(join(root, '.git'), 'isDirectory');
  const git = (...args) => execFileSync('git', ['--git-dir', join(root, '.git'), '--no-replace-objects', ...args], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (String(git('rev-parse', '--verify', `refs/swarm/revisions/${revision}`)).trim() !== row.git_commit ||
      String(git('rev-parse', `${row.git_commit}^{tree}`)).trim() !== row.git_tree) throw new Error('Retained revision identity disagrees with Git');
  const files = Object.create(null);
  const manifest = Object.create(null);
  let total = 0;
  for (const entry of String(git('ls-tree', '-rz', '--full-tree', row.git_tree)).split('\0').filter(Boolean)) {
    const split = entry.indexOf('\t');
    const [mode, type, blob] = entry.slice(0, split).split(' ');
    const path = entry.slice(split + 1);
    if (!['100644', '100755'].includes(mode) || type !== 'blob' || !oid.test(blob) || path.includes('\uFFFD') ||
        path.includes('\\') || path.split('/').some(part => !part || ['.', '..', '.git', '.pi', '.swarm', 'node_modules'].includes(part) || /^\.env(?:\.|$)|^\.swarm-/.test(part))) {
      throw new Error('Revision contains a nonpublic or nonregular path');
    }
    const bytes = git('cat-file', 'blob', blob);
    total += bytes.length;
    if (total > 32 * 1024 * 1024 || Object.keys(files).length >= 4096) throw new Error('Revision exceeds rehearsal limits');
    files[path] = { mode, base64: bytes.toString('base64') };
    manifest[path] = { bytes: bytes.length, content_hash: hash(bytes) };
  }
  if (stableStringify(manifest) !== stableStringify(row.files) || hash(stableStringify(manifest)) !== row.content_hash) {
    throw new Error('Revision content does not match the published manifest');
  }
  return { workspace_id: index.workspace_id, mission_id: index.mission_id, revision, commit: row.git_commit, tree: row.git_tree, content_hash: row.content_hash, files };
}
function readDomain(db, domain) {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const tables = new Set(schema.filter(item => item.type === 'table').map(item => item.name));
  const supportedTables = new Set();
  const columns = {};
  const rows = table => supportedTables.has(table) ? db.prepare(`SELECT * FROM ${table}`).iterate() : [];
  const findings = [];
  let count = 0;
  const record = (id, classification, reason) => {
    count += 1;
    if (findings.length < 250) findings.push({ id, classification, reason });
  };
  let busy = false;
  const active = (id, reason) => { busy = true; record(id, 'reject', reason); };
  const claims = new Map();
  const requirements = { ...domains[domain], ...optionalAuthority[domain] };
  for (const [table, required] of Object.entries(requirements)) {
    if (!tables.has(table)) {
      if (Object.hasOwn(domains[domain], table)) record(table, 'reject', 'missing_authority_table');
      continue;
    }
    columns[table] = db.prepare(`PRAGMA table_info(${table})`).all()
      .map(({ name, type, pk }) => ({ name, type, primary_key_order: pk }));
    const missing = required.filter(name => !columns[table].some(column => column.name === name));
    if (missing.length) {
      for (const name of missing) record(`${table}.${name}`, 'reject', 'missing_authority_column');
    } else supportedTables.add(table);
  }
  const authoritySchemaComplete = Object.keys(domains[domain]).every(table => supportedTables.has(table)) &&
    Object.keys(optionalAuthority[domain]).every(table => !tables.has(table) || supportedTables.has(table));
  if (domain === 'task') {
    for (const row of rows('executions')) {
      if (!terminal.has(row.state)) {
        active(row.execution_id, 'nonterminal_execution');
        if (row.owner_ref && claims.has(row.owner_ref)) active(row.execution_id, 'duplicate_active_owner');
        if (row.owner_ref) claims.set(row.owner_ref, row.execution_id);
      }
      if (row.workspace_ref) record(row.execution_id, 'reject', 'private_workspace_reference');
    }
    for (const row of rows('bots')) if (row.state !== 'CLOSED') active(row.bot_id, 'nonterminal_bot');
    for (const row of rows('mission_submissions')) if (['preparing', 'pending'].includes(row.state)) active(row.submission_id, 'pending_submission');
    for (const row of rows('execution_workspace_requests')) if (!['failed', 'done'].includes(row.phase)) active(row.request_id, 'pending_workspace_operation');
    for (const row of rows('tasks')) record(row.task_id, 'owner_decision', taskStates.has(row.state) ? 'optional_explicit_task_selection' : 'historical_or_unknown_task_state');
  }
  if (domain === 'context') {
    const attachments = supportedTables.has('material_attachments') ? db.prepare('SELECT name, media_type, content_hash, bytes FROM material_attachments WHERE material_id = ? ORDER BY name') : null;
    for (const row of rows('materials')) {
      if ((!row.source_task || !row.source_execution) && row.role !== 'input') record(row.material_id, 'owner_decision', 'missing_producer_provenance');
      if (row.role) record(row.material_id, 'owner_decision', 'historical_role_requires_interpretation');
      if (row.content_ref && row.content_ref !== `sqlite://material/${row.material_id}`) record(row.material_id, 'reject', 'external_or_private_content_reference');
      try {
        const manifest = (attachments?.all(row.material_id) ?? []).map(({ bytes, ...item }) => {
          if (hash(bytes) !== item.content_hash) throw new Error();
          return { ...item, size_bytes: bytes.length };
        });
        const content = JSON.parse(row.content_json);
        if (hash(stableStringify(manifest.length ? { content, attachments: manifest } : content)) !== row.content_hash) throw new Error();
      } catch { record(row.material_id, 'reject', 'missing_or_unverifiable_content_or_attachment'); }
    }
  }
  if (domain === 'judge') {
    for (const row of rows('judge_mission_check_admissions')) if (!row.settled_at) active(row.check_result_id, 'unsettled_judge_reservation');
    for (const row of rows('check_results')) if (row.judge_operation_status === 'running' || !row.verdict) active(row.check_result_id, 'unresolved_check');
  }
  if (domain === 'task') for (const row of rows('mission_final_check_admissions')) if (!row.settled_at) active(row.submission_id, 'unsettled_final_reservation');
  return { sqlite_user_version: db.prepare('PRAGMA user_version').get().user_version,
    schema_sha256: hash(stableStringify(schema)), inspected_table_columns: columns, authority_schema_complete: authoritySchemaComplete,
    nonterminal_records: busy, finding_count: count, findings };
}

async function run() {
  const command = process.argv[2];
  const options = Object.fromEntries(['task', 'context', 'judge', 'workspace', 'revision', 'run-manifest', 'external-evidence', 'out', 'backup'].map(key => [key, { type: 'string' }]));
  const { values } = parseArgs({ options, args: process.argv.slice(3) });
  if (command === 'restore-verify') {
    const bundle = await privateDirectory(values.backup);
    const manifest = JSON.parse(await readFile(await canonical(join(bundle, 'manifest.json'), 'isFile'), 'utf8'));
    const expected = ['task.sqlite', 'context.sqlite', 'judge.sqlite', 'workspace.json', 'run-manifest.json', 'external-evidence.json'];
    if (manifest.version !== 1 || Object.keys(manifest.files ?? {}).sort().join() !== [...expected].sort().join()) throw new Error('Unrecognized backup manifest');
    for (const file of expected) {
      if (await fileHash(await canonical(join(bundle, file), 'isFile')) !== manifest.files[file]) throw new Error(`Backup checksum failed for ${file}`);
    }
    const out = resolve(values.out);
    await privateDirectory(dirname(out));
    await mkdir(out, { mode: 0o700 });
    try {
      for (const file of expected) {
        await copyFile(join(bundle, file), join(out, file));
        if (await fileHash(join(out, file)) !== manifest.files[file]) throw new Error(`Restored checksum failed for ${file}`);
        if (!file.endsWith('.sqlite')) continue;
        const db = new DatabaseSync(join(out, file), { readOnly: true });
        try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Restored SQLite integrity check failed'); }
        finally { db.close(); }
      }
      await writeJson(join(out, 'manifest.json'), manifest);
    } catch (error) { await rm(out, { recursive: true }); throw error; }
    return { status: 'verified_rehearsal', import_performed: false, files: expected };
  }
  if (!['preview', 'backup'].includes(command)) throw new Error('Use preview, backup, or restore-verify with explicit paths');
  const state = {};
  const sources = {};
  const versions = {};
  const workspace = await snapshot(values.workspace, values.revision);
  try {
    for (const domain of Object.keys(domains)) {
      const path = await canonical(values[domain], 'isFile');
      sources[domain] = new DatabaseSync(path, { readOnly: true });
      versions[domain] = sources[domain].prepare('PRAGMA data_version').get().data_version;
      state[domain] = readDomain(sources[domain], domain);
    }
    const { files, ...publicInput } = workspace;
    const blocked = Object.values(state).some(x => x.nonterminal_records || !x.authority_schema_complete);
    const report = { mode: 'fresh_no_import', import_performed: false, external_isolation_verified: false, blocked,
      selected_input: { ...publicInput, classification: 'accept_as_candidate_input', file_count: Object.keys(files).length }, domains: state };
    if (command === 'preview') return report;
    if (blocked) throw new Error('Backup refused: unresolved authority or nonterminal records; run preview');
    const readInput = async key => JSON.parse(await readFile(await canonical(values[key], 'isFile'), 'utf8'));
    const runManifest = await readInput('run-manifest');
    const evidence = await readInput('external-evidence');
    if (!['old_writer_stop', 'provider_isolation', 'external_operations_accounted'].every(field => typeof evidence?.[field] === 'string' && evidence[field].trim())) {
      throw new Error('External evidence must reference old writer stop, provider isolation and external operation accounting');
    }
    const out = resolve(values.out);
    await privateDirectory(dirname(out));
    await mkdir(out, { mode: 0o700 });
    try {
      const hashes = {};
      for (const domain of Object.keys(domains)) {
        const file = `${domain}.sqlite`;
        await backup(sources[domain], join(out, file));
        const restored = new DatabaseSync(join(out, file), { readOnly: true });
        try {
          if (stableStringify(readDomain(restored, domain)) !== stableStringify(state[domain])) throw new Error('SQLite classification changed during capture');
        } finally { restored.close(); }
        hashes[file] = await fileHash(join(out, file));
      }
      for (const [file, value] of [['workspace.json', workspace], ['run-manifest.json', runManifest], ['external-evidence.json', evidence]]) {
        await writeJson(join(out, file), value);
        hashes[file] = await fileHash(join(out, file));
      }
      for (const [domain, db] of Object.entries(sources)) {
        if (db.prepare('PRAGMA data_version').get().data_version !== versions[domain]) throw new Error('An old writer changed a database during capture');
      }
      if (stableStringify(await snapshot(values.workspace, values.revision)) !== stableStringify(workspace)) throw new Error('Selected Workspace changed during capture');
      await writeJson(join(out, 'manifest.json'), { version: 1, coordination: 'operator_attested_quiescence', report, files: hashes });
    } catch (error) { await rm(out, { recursive: true }); throw error; }
    return { ...report, status: 'backup_created' };
  } finally { for (const db of Object.values(sources)) db.close(); }
}

process.umask(0o077);
try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
  if (result.blocked) process.exitCode = 2;
}
catch (error) { console.error(error.message); process.exitCode = 1; }
