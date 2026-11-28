import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function retainOriginalOwner(harness, exchange) {
  return {
    ...harness,
    run(context) {
      return harness.run({ ...context, registerAgentControls(registration) {
        const runtime = registration.runtime;
        let blocker;
        let running = false;
        const tick = setInterval(async () => {
          if (running) return;
          running = true;
          try {
            const request = join(exchange, 'owner-request');
            const command = await readFile(request, 'utf8').catch(error => {
              if (error.code !== 'ENOENT') throw error;
              return null;
            });
            if (!command) return;
            await rm(request);
            if (command === 'inject') {
              const agents = await runtime.list();
              if (agents.length !== 1) throw new Error('Expected one owned Root');
              const directory = join(context.outputDir, runtime.id, agents[0].id);
              await mkdir(directory, { recursive: true, mode: 0o700 });
              const artifactPath = join(directory, 'artifacts');
              await writeFile(artifactPath, 'required export fault', { flag: 'wx', mode: 0o600 });
              blocker = artifactPath;
              await writeFile(join(exchange, 'owner-injected'), JSON.stringify({ runtimeId: runtime.id, agentId: agents[0].id }), { mode: 0o600 });
            } else if (command === 'repair') {
              if (blocker) await rm(blocker, { force: true });
              const receipt = await runtime.close({ timeoutMs: 30_000 });
              await writeFile(join(exchange, 'owner-repaired'), receipt.cleanup, { mode: 0o600 });
              clearInterval(tick);
            } else throw new Error('Invalid owner test request');
          } catch (error) {
            await writeFile(join(exchange, 'owner-error'), String(error), { mode: 0o600 });
          } finally { running = false; }
        }, 50);
        tick.unref();
        return context.registerAgentControls(registration);
      } });
    },
  };
}
