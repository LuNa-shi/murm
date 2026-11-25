import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const instance = 'sharkdp__pastel.b60e899';
export const privateDirectory = fileURLToPath(new URL('../../experiments/programbench-pastel/', import.meta.url));
export const goal = `Rebuild Pastel for ProgramBench (${instance}).
Use the reference program at /opt/programbench/executable and its documentation in /opt/programbench.
Observe its behavior by running it. Author original source without accessing project source, external resources or hidden tests. Do not use or redistribute the reference in the candidate.
Create a source tree with a root compile.sh that builds ./executable in the offline ProgramBench environment. Preserve partial work if the full program is unfinished.`;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const task = `${goal}
Select and implement an original approach. Create an early runnable source snapshot, then extend or correct it as time allows.
Your teammates solve part of the same program. Record whose work was used, the source or version, and the behavior it supports.
Keep the candidate source and offline build instructions in the shared deliverable channel described below. A runnable subset is acceptable.`;

export async function runDirectory(mode) {
  const path = join(privateDirectory, 'integration-runs');
  await mkdir(path, { recursive: true, mode: 0o700 });
  return mkdtemp(join(path, `${mode}-`));
}
