import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { httpClient } from './http.js';

/** Dedicated pinned native board, with explicit host Python/MySQL prerequisites.
 * Merely constructing this launcher allocates nothing. Calling it is a real
 * facility experiment and must pass the same independent gate as the Bot. */
export function createBoardLauncher({ sourceDirectory, mysqlDsn, origin, python = 'python3', startupTimeoutMs = 15_000 }) {
  const address = new URL(origin);
  if (!['127.0.0.1', '0.0.0.0'].includes(address.hostname) || address.protocol !== 'http:' || !address.port || address.username || address.password || address.pathname !== '/' || address.search || address.hash ||
      typeof mysqlDsn !== 'string' || !mysqlDsn || typeof sourceDirectory !== 'string' || !sourceDirectory || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30_000) throw new TypeError('Board launcher requires explicit local origin, source, MySQL DSN and bounded startup');
  return async function startBoard({ boardId, workerId, own }) {
    await new Promise((resolve, reject) => {
      const reservation = createServer();
      reservation.once('error', () => reject(Object.assign(new Error('Board port is already in use'), { code: 'BOARD_PORT_UNAVAILABLE' })));
      reservation.listen(Number(address.port), address.hostname, () => reservation.close(resolve));
    });
    const child = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', address.hostname, '--port', address.port, '--no-access-log', '--log-level', 'error'], {
      cwd: sourceDirectory, stdio: 'ignore', env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', MYSQL_DSN: mysqlDsn,
        BOARD_MEMBERS_JSON: JSON.stringify({ [boardId]: [workerId] }), BOARD_OPERATOR: `operator-${boardId}` },
    });
    let ended = false; let failed = false;
    const exited = new Promise(resolve => { child.once('exit', () => { ended = true; resolve(); }); child.once('error', () => { ended = true; failed = true; resolve(); }); });
    own({ kind: 'board-process', id: boardId, close: async () => {
      if (ended) return;
      child.kill('SIGTERM');
      let timer;
      try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); } finally { clearTimeout(timer); }
      if (!ended) {
        child.kill('SIGKILL');
        try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); } finally { clearTimeout(timer); }
      }
      if (!ended) throw new Error('Board process stop remains unknown');
    } });
    // A busy port could otherwise make readiness observe someone else's board.
    // Require the newly spawned process to remain alive after the HTTP probe.
    const request = httpClient(origin);
    const deadline = performance.now() + startupTimeoutMs;
    while (performance.now() < deadline && !ended) {
      try {
        await request('GET', `/board/${encodeURIComponent(boardId)}/read?viewer=${encodeURIComponent(workerId)}`, undefined,
          { signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))) });
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!ended) return { origin, processId: child.pid };
      } catch { /* Startup is bounded; request failures carry no upstream text. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Object.assign(new Error('Dedicated board did not become ready'), { code: failed ? 'BOARD_START_FAILED' : 'BOARD_NOT_READY' });
  };
}
