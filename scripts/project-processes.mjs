// Run by the trusted worker as the Bot UID, with fixed code and a clean env.
// Same-UID /proc reads work without granting the Bot or worker CAP_SYS_PTRACE.
import { readdir, readFile, readlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function assertProjectSwitchSafe({ pids, projectDir, changedPaths, replacedDirectories }) {
  const changed = new Set(changedPaths.map(path => `${projectDir}/${path}`));
  const removed = replacedDirectories.map(path => `${projectDir}/${path}`);
  const affected = path => changed.has(path) || removed.some(directory => path === directory || path.startsWith(`${directory}/`));
  const requireSafe = (path, kind, pid) => {
    if (affected(path) || affected(path.replace(/ \(deleted\)$/, ''))) throw new Error(`unsafe ${kind} in paused process ${pid}`);
  };
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid < 1) throw new Error('invalid paused process identity');
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      if (!/^State:\s+[TtZ]/m.test(status)) throw new Error('project process is not paused');
      if (/^State:\s+Z/m.test(status)) continue;
      const cwd = await readlink(`/proc/${pid}/cwd`);
      if (removed.some(directory => cwd === directory || cwd.startsWith(`${directory}/`))) throw new Error('a paused process is inside a replaced directory');
      for (const fd of await readdir(`/proc/${pid}/fd`)) requireSafe(await readlink(`/proc/${pid}/fd/${fd}`), 'open file descriptor', pid);
      const maps = await readFile(`/proc/${pid}/maps`, 'utf8');
      for (const line of maps.split('\n')) {
        const match = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line);
        if (match) requireSafe(match[1].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))), 'mapped file', pid);
      }
    } catch (error) {
      // A process exiting is harmless; an inaccessible or changing descriptor
      // cannot establish safety and must reject the switch.
      if (error.code === 'ENOENT') {
        try { await readFile(`/proc/${pid}/status`); } catch (gone) { if (gone.code === 'ENOENT') continue; }
      }
      throw error;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw new Error('process inspection metadata exceeds its bound');
      chunks.push(chunk);
    }
    await assertProjectSwitchSafe(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    process.stdout.write('{"safe":true}\n');
  }
  catch (error) { process.stdout.write(JSON.stringify({ safe: false, reason: error.message }) + '\n'); process.exitCode = 1; }
}
