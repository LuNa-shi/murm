import { constants, mkdir, readFile, realpath } from 'node:fs/promises';
import { lstat, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MARKER = '.swarmenv-private-audit-v1.json';
const CLOSED = '.swarmenv-private-audit-closed.json';
export const PRIVATE_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const activeRuns = new WeakSet();

async function processStart(pid) {
  try {
    const status = await readFile(`/proc/${pid}/stat`, 'utf8');
    return status.slice(status.lastIndexOf(') ') + 2).split(' ')[19] ?? null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function bootId() {
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
}

function isChild(root, path) {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function checkDirectory(path, { privateRun = false } = {}) {
  const state = await lstat(path);
  if (!state.isDirectory() || state.uid !== process.getuid() || (state.mode & (privateRun ? 0o077 : 0o022)) !== 0 ||
      await realpath(path) !== path) throw new Error('Unsafe private audit directory');
  return state;
}

async function writeMarker(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}

async function readMarker(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.size > 4096 || state.nlink !== 1 || state.uid !== process.getuid() || (state.mode & 0o077) !== 0) {
      throw new Error('Unsafe private audit marker');
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

export async function beginPrivateAudit({ root, directory }) {
  root = resolve(root);
  directory = resolve(directory);
  if (!isChild(root, directory)) throw new Error('Private audit directory must be under its managed experiment root');
  if (relative(root, directory).split(sep).some(component => component.startsWith('.'))) {
    throw new Error('Private audit path must be visible to the retention sweep');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checkDirectory(root);
  let parent = root;
  for (const component of relative(root, dirname(directory)).split(sep).filter(Boolean)) {
    parent = join(parent, component);
    try { await mkdir(parent, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkDirectory(parent);
    if (await readMarker(join(parent, MARKER))) throw new Error('Cannot create a private audit directory inside another managed run');
  }
  const owner = { pid: process.pid, start: await processStart(process.pid), boot: await bootId() };
  if (!owner.start || !owner.boot) throw new Error('Cannot establish private audit ownership');
  await mkdir(directory, { mode: 0o700 });
  const filesystem = await checkDirectory(directory, { privateRun: true });
  const marker = { schema: 1, owner, created_at_ms: Date.now(), device: filesystem.dev, inode: filesystem.ino };
  await writeMarker(join(directory, MARKER), marker);
  const audit = Object.freeze({
    directory,
    retentionMs: PRIVATE_AUDIT_RETENTION_MS,
    async close() {
      if (!activeRuns.has(audit)) return;
      await writeMarker(join(directory, CLOSED), { closed_at_ms: Date.now() });
      activeRuns.delete(audit);
    },
  });
  activeRuns.add(audit);
  return audit;
}

export async function prunePrivateAudit({ root, now = Date.now() }) {
  root = resolve(root);
  try { await checkDirectory(root); }
  catch (error) { if (error.code === 'ENOENT') return { removed: 0 }; throw error; }
  if (!Number.isSafeInteger(now)) throw new TypeError('Invalid private audit prune clock');
  const boot = await bootId();
  let removed = 0;
  async function scan(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = join(path, entry.name);
      const state = await checkDirectory(directory).catch(() => null);
      if (!state) continue;
      let marker;
      try { marker = await readMarker(join(directory, MARKER)); }
      catch { continue; }
      if (!marker) {
        await scan(directory);
        continue;
      }
      if ((state.mode & 0o077) !== 0 || marker.schema !== 1 || marker.device !== state.dev || marker.inode !== state.ino ||
          !Number.isSafeInteger(marker.created_at_ms) || !Number.isSafeInteger(marker.owner?.pid) || marker.owner.pid < 1 ||
          typeof marker.owner.start !== 'string' || !/^\d+$/.test(marker.owner.start) || typeof marker.owner.boot !== 'string') continue;
      let close;
      try { close = await readMarker(join(directory, CLOSED)); }
      catch { continue; }
      if (close && (!Number.isSafeInteger(close.closed_at_ms) || close.closed_at_ms < marker.created_at_ms)) continue;
      const startOfRetention = close?.closed_at_ms ?? marker.created_at_ms;
      if (now - startOfRetention < PRIVATE_AUDIT_RETENTION_MS) continue;
      if (!close && marker.owner.boot === boot && await processStart(marker.owner.pid) === marker.owner.start) continue;
      const checked = await stat(directory).catch(() => null);
      if (!checked || checked.dev !== state.dev || checked.ino !== state.ino) continue;
      await rm(directory, { recursive: true });
      removed += 1;
    }
  }
  await scan(root);
  return { removed };
}
