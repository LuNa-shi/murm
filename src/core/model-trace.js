import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createModelTrace(outputDir, redactor) {
  const path = join(outputDir, 'model-trace');
  let started = 0;
  let recorded = 0;
  let lost = 0;
  const json = value => JSON.stringify(redactor.value(value)) + '\n';

  return {
    initialize: () => mkdir(path, { mode: 0o700 }),
    snapshot: () => ({ path, recorded, lost, pending: started - recorded - lost }),
    begin(request) {
      const id = randomUUID();
      const seq = ++started;
      const attemptDir = join(path, id);
      const responsePath = join(attemptDir, 'response.txt');
      const redact = redactor.stream();
      let failed = false;
      function lose() {
        if (!failed) lost++;
        failed = true;
      }
      const initialized = (async () => {
        await mkdir(attemptDir, { mode: 0o700 });
        await writeFile(join(attemptDir, 'request.json'), json({ ...request, seq }), { mode: 0o600, flag: 'wx' });
        await writeFile(responsePath, '', { mode: 0o600, flag: 'wx' });
      })().catch(lose);
      let writing = initialized;
      return {
        write(bytes) {
          writing = writing.then(async () => {
            if (failed) return;
            const text = redact.write(bytes);
            if (text) await appendFile(responsePath, text);
          }).catch(lose);
          return writing;
        },
        async finish(result) {
          await writing;
          if (failed) return;
          try {
            const tail = redact.end();
            if (tail) await appendFile(responsePath, tail);
            await writeFile(join(attemptDir, 'result.json'), json({ ...result, seq }), { mode: 0o600, flag: 'wx' });
            recorded++;
          } catch { lose(); }
        },
      };
    },
  };
}
