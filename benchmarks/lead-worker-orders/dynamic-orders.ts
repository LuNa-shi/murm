import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DynamicDeploymentRequest, DynamicLeadWorkerOptions } from '../../examples/lead-worker/harness/dynamic.js';
import { httpClient } from '@luna-shi/murm';
import { assertContainerImage, deployDynamicContainer, docker, isolatedContainer } from '../../examples/lead-worker/dynamic-container.js';

type Variant = 'orders-a' | 'orders-b';
type Candidate = Record<string, string>;
type OrdersCase = { stdin?: string; file?: string; args?: string[] };
type ExecuteOrders = (input: OrdersCase) => Promise<{ status: number | null; stdout: string; stderr: string }>;
const fixtures = new URL('./fixtures/', import.meta.url);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const ordersTreeDigest = (files: Candidate) => digest(Buffer.from(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
const commitId = /^[a-f0-9]{40}$/;
const filePath = /^(?!\.git(?:\/|$))[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;

function safePath(path: string) {
  return filePath.test(path) && !path.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()));
}

export async function fetchOrdersCandidate({ repositoryUrl, token, commit, sha256, signal }: Omit<Parameters<NonNullable<DynamicLeadWorkerOptions['verifyFinal']>>[0], 'resources'>) {
  const url = new URL(repositoryUrl);
  const parts = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git$/);
  if (!parts || !commitId.test(commit) || !/^[a-f0-9]{64}$/.test(sha256) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid pinned orders delivery');
  const request = httpClient(url.origin, `token ${token}`);
  const base = `/api/v1/repos/${parts[1]}/${parts[2]}`;
  const pinned = await request('GET', `${base}/git/commits/${commit}`, undefined, { signal });
  const tree = pinned?.commit?.tree?.sha ?? pinned?.tree?.sha;
  if (pinned?.sha !== commit || !commitId.test(tree)) throw new Error('Orders commit could not be verified');
  const root = await request('GET', `${base}/git/trees/${tree}?recursive=true`, undefined, { signal });
  if (!Array.isArray(root?.tree) || root.truncated || root.tree.length > 64) throw new Error('Orders tree exceeds verification bounds');
  const files: Candidate = Object.create(null);
  let bytes = 0;
  for (const entry of root.tree) {
    if (typeof entry?.path !== 'string' || entry.path.length > 160 || !safePath(entry.path)) throw new Error('Invalid orders project path');
    if (entry.type === 'tree' && entry.mode === '040000') continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !commitId.test(entry.sha) || Object.hasOwn(files, entry.path))
      throw new Error('Orders project requires ordinary files');
    const blob = await request('GET', `${base}/git/blobs/${entry.sha}`, undefined, { signal });
    if (blob?.sha !== entry.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('Invalid orders project blob');
    const data = Buffer.from(blob.content, 'base64');
    bytes += data.length;
    if (bytes > 1024 ** 2 || blob.size !== data.length ||
        createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') !== entry.sha)
      throw new Error('Orders project blob exceeds bounds or does not match Git');
    files[entry.path] = data.toString('base64');
  }
  if (!Object.hasOwn(files, 'orders.mjs') || digest(Buffer.from(files['orders.mjs'], 'base64')) !== sha256) throw new Error('Orders delivery checksum mismatch');
  return files;
}

export async function withOrdersCandidate<T>(files: Candidate, image: string, run: (execute: ExecuteOrders) => Promise<T>,
  signal?: AbortSignal, resources?: DynamicDeploymentRequest['resources']) {
  assertContainerImage(image);
  let projectBytes = 0;
  if (!Object.hasOwn(files, 'orders.mjs') || Object.keys(files).length > 64) throw new Error('Invalid frozen candidate');
  const directory = await mkdtemp(join(tmpdir(), 'murm-candidate-'));
  try {
    const work = join(directory, 'project');
    await mkdir(work, { mode: 0o700 });
    const directories = new Set([work]);
    for (const [path, encoded] of Object.entries(files)) {
      if (!safePath(path) || path.length > 160 || typeof encoded !== 'string') throw new Error('Invalid frozen candidate path');
      const target = join(work, path);
      const bytes = Buffer.from(encoded, 'base64');
      projectBytes += bytes.length;
      if (projectBytes > 1024 ** 2 || bytes.toString('base64') !== encoded) throw new Error('Invalid frozen candidate bytes');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(target, 0o444);
      for (let parent = dirname(target); !directories.has(parent); parent = dirname(parent)) directories.add(parent);
    }
    for (const path of directories) await chmod(path, 0o755);
    await chmod(directory, 0o755);
    const testInput = join(directory, 'case.jsonl');
    let cleanupFailure: unknown;
    const verdict = await run(async ({ stdin, file, args = [] }) => {
      signal?.throwIfAborted();
      if (cleanupFailure) throw cleanupFailure;
      const fileArgs = file === undefined ? args.map(value => `/tmp/${value}`) : ['/case.jsonl'];
      const container = isolatedContainer(image, work, file === undefined ? undefined : testInput);
      resources?.own({ kind: 'orders-verification-container', id: container.name, close: container.close });
      try {
        if (file !== undefined) {
          await writeFile(testInput, file, { flag: 'wx', mode: 0o600 });
          await chmod(testInput, 0o444);
        }
        await container.create(['orders.mjs', ...fileArgs], signal);
        return await docker(['container', 'start', '-a', '-i', container.name], {
          signal, input: stdin, outputLimit: 512 * 1024,
        });
      } finally {
        try { await container.close(); }
        catch (error) { cleanupFailure = error; }
        if (file !== undefined && !cleanupFailure) await rm(testInput, { force: true });
      }
    });
    signal?.throwIfAborted();
    if (cleanupFailure) throw cleanupFailure;
    return verdict;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function testOrdersCandidate(files: Candidate, image: string, signal?: AbortSignal, resources?: DynamicDeploymentRequest['resources']) {
  const { verifyOrders } = await import(fileURLToPath(new URL('oracle.mjs', fixtures))) as {
    verifyOrders(execute: ExecuteOrders): Promise<{ ok: boolean; results: Array<{ id: string; ok: boolean }> }>;
  };
  return withOrdersCandidate(files, image, verifyOrders, signal, resources);
}

export async function dynamicOrders({ variant, serviceImage, candidatePath }: {
  variant: Variant; serviceImage: string; candidatePath?: string;
}): Promise<DynamicLeadWorkerOptions> {
  if (variant !== 'orders-a' && variant !== 'orders-b') throw new TypeError('Select orders-a or orders-b');
  assertContainerImage(serviceImage);
  const { publicInputs } = await import(fileURLToPath(new URL('oracle.mjs', fixtures))) as { publicInputs: Record<Variant, string> };
  const [spec, stub] = await Promise.all([
    readFile(new URL('spec.md', fixtures), 'utf8'), readFile(new URL('initial-project/orders.mjs', fixtures), 'utf8'),
  ]);
  return {
    initialFiles: { 'orders.mjs': stub, 'spec.md': spec, 'sample.jsonl': publicInputs[variant] },
    goal: `${spec}\nPublic sample ${variant}. Use its exact data during the Run.\n\`\`\`jsonl\n${publicInputs[variant]}\n\`\`\``,
    deploy: deployDynamicContainer(serviceImage, {
      async verify(invoke) {
        const good = '{"id":"valid","currency":"EUR","amount_cents":0}';
        const expected = { valid: [JSON.parse(good)], totals: { EUR: 0 }, errors: [] };
        assert.deepEqual(await invoke(`${good}\n`), expected);
        assert.deepEqual(await invoke(`${good}\n${good}\n{\n`), { ...expected,
          errors: [{ line: 2, code: 'DUPLICATE_ID' }, { line: 3, code: 'INVALID_JSON' }] });
        return { validInput: true, duplicateAndMalformedInput: true };
      },
    }),
    async verifyFinal(input) {
      const files = await fetchOrdersCandidate(input);
      const bundle = { commit: input.commit, sha256: input.sha256, treeSha256: ordersTreeDigest(files), image: serviceImage, files };
      if (candidatePath) await writeFile(candidatePath, JSON.stringify(bundle), { flag: 'wx', mode: 0o600 });
      const { files: _privateFiles, ...pin } = bundle;
      return { ...(await testOrdersCandidate(files, serviceImage, input.signal, input.resources)), ...pin };
    },
  };
}
