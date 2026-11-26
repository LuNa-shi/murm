import { fileProtocol } from './core-file-seed.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DiagnosticCheck } from './local-environment.js';

const exec = promisify(execFile);
const protocol = 'murm-core-v1';
const pi = '1.3.0';
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const imageReferencePattern = /^[a-z0-9][a-z0-9._/@:+-]{0,254}$/i;

type Image = {
  Id: string;
  RepoDigests?: string[];
  Config?: { Labels?: Record<string, string>; Env?: string[] };
};
export type WorkerImage = { reference: string; id: string; digests: string[]; protocol: string; pi: string };
type WorkerInspection = { checks: DiagnosticCheck[]; image?: WorkerImage; absent: boolean };
const remedy = 'Run murm setup to build the package Worker, or set MURM_SUBAGENTS_IMAGE to a compatible local image.';

async function inspectWorker(reference: string, signal: AbortSignal): Promise<WorkerInspection> {
  if (!imageReferencePattern.test(reference)) return {
    checks: [{ id: 'worker-image', ok: false, detail: 'The configured Worker image reference is invalid.', remedy }], absent: false,
  };
  let image: Image;
  try {
    const { stdout } = await exec('docker', ['image', 'inspect', '--', reference], { signal, timeout: 8_000, maxBuffer: 1024 * 1024 });
    [image] = JSON.parse(stdout);
    if (!imageIdPattern.test(image?.Id)) throw new Error('Invalid image identity');
  } catch (error) {
    signal.throwIfAborted();
    const absent = /No such image|not found/.test((error as { stderr?: string }).stderr ?? '');
    return {
      checks: [{ id: 'worker-image', ok: false,
        detail: absent ? 'The Worker image is absent from the local Docker cache.' : 'Docker could not inspect the Worker image.',
        remedy }], absent,
    };
  }
  const labels = image.Config?.Labels ?? {};
  const protocolMatches = labels['org.murm.opensandbox.worker-protocol'] === protocol &&
    labels['org.murm.opensandbox.file-protocol'] === fileProtocol;
  const piMatches = labels['org.murm.opensandbox.pi-version'] === pi && image.Config?.Env?.includes(`MURM_PI_VERSION=${pi}`) === true;
  return {
    checks: [
      { id: 'worker-image', ok: true, detail: `Docker resolved ${image.Id}.` },
      { id: 'worker-protocol', ok: protocolMatches,
        detail: protocolMatches ? `The image declares ${protocol} and ${fileProtocol}.` : `The image does not declare the required Worker protocol ${protocol} and ${fileProtocol}.`,
        ...(protocolMatches ? {} : { remedy }) },
      { id: 'worker-pi', ok: piMatches,
        detail: piMatches ? `The image declares Pi ${pi}.` : `The image does not declare the required Pi version ${pi}.`,
        ...(piMatches ? {} : { remedy }) },
    ],
    ...(protocolMatches && piMatches ? { image: { reference, id: image.Id,
      digests: (image.RepoDigests ?? []).filter(value => imageReferencePattern.test(value)), protocol, pi } } : {}),
    absent: false,
  };
}

export async function prepareWorkerImage({ packageRoot, requestedImage, install, signal }: {
  packageRoot: string; requestedImage?: string; install: boolean; signal: AbortSignal;
}): Promise<WorkerInspection & { reference: string; source: 'cache' | 'build' | 'pull' }> {
  const manifest: { version: string } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const reference = requestedImage ?? `murm-worker:${manifest.version}-${protocol}-${fileProtocol}-pi-${pi}`;
  const cached = await inspectWorker(reference, signal);
  if (!install || cached.image || !cached.absent) return { ...cached, reference, source: 'cache' };

  const source = requestedImage ? 'pull' : 'build';
  if (requestedImage && imageIdPattern.test(requestedImage)) return { ...cached, reference, source: 'cache' };
  const args = requestedImage ? ['pull', '--', reference] : [
    'build', '--file', join(packageRoot, 'deploy/worker/Dockerfile'), '--tag', reference, packageRoot,
  ];
  try {
    await exec('docker', args, { signal, timeout: 15 * 60_000, maxBuffer: 12 * 1024 * 1024 });
  } catch {
    signal.throwIfAborted();
    return { ...cached, reference, source, checks: [{ id: `worker-${source}`, ok: false,
      detail: `Docker could not ${source} the Worker image.`, remedy: source === 'build'
        ? 'Run docker build -f deploy/worker/Dockerfile . in the package or checkout to inspect the build failure.'
        : 'Check the requested image reference and registry access, or import the compatible Worker image locally.' }] };
  }
  return { ...(await inspectWorker(reference, signal)), reference, source };
}
