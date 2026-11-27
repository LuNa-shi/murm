import { fileProtocol } from './core-file-seed.js';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { workerImageFor, WORKER_PROTOCOL } from '../src/core/worker-image.js';
import { selectExecutorDriver } from '../src/core/executor-driver.js';
import type { ExecutorSelection } from '../src/core/executor-adapter.js';
import type { DiagnosticCheck } from './local-environment.js';

const exec = promisify(execFile);
const protocol = WORKER_PROTOCOL;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const imageReferencePattern = /^[a-z0-9][a-z0-9._/@:+-]{0,254}$/i;

type Image = {
  Id: string;
  RepoDigests?: string[];
  Config?: { Labels?: Record<string, string>; Env?: string[] };
};
export type WorkerImage = { reference: string; id: string; digests: string[]; protocol: string; executor: string; version: string };
type WorkerInspection = { checks: DiagnosticCheck[]; image?: WorkerImage; absent: boolean };
const remedy = 'Run murm setup to prepare the selected Worker, or set MURM_WORKER_IMAGE to a compatible image.';

async function inspectWorker(reference: string, driver: ReturnType<typeof selectExecutorDriver>, signal: AbortSignal): Promise<WorkerInspection> {
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
  const { kind: executor, version } = driver;
  const installed = labels['org.murm.opensandbox.worker-executors'];
  const actualVersion = labels[`org.murm.opensandbox.${executor}-version`];
  const versionMatches = driver.adapter
    ? actualVersion === version && labels[`org.murm.opensandbox.${executor}-protocol`] === driver.adapter.protocol
    : actualVersion === version && (installed === undefined || installed === 'both' || installed === executor);
  return {
    checks: [
      { id: 'worker-image', ok: true, detail: `Docker resolved ${image.Id}.` },
      { id: 'worker-protocol', ok: protocolMatches,
        detail: protocolMatches ? `The image declares ${protocol} and ${fileProtocol}.` : `The image does not declare the required Worker protocol ${protocol} and ${fileProtocol}.`,
        ...(protocolMatches ? {} : { remedy }) },
      { id: `worker-${executor}`, ok: versionMatches,
        detail: versionMatches ? `The image declares ${executor} ${version}.` :
          `Image declares ${executor} ${actualVersion ?? 'unavailable'}; selected ${version} within ${driver.compatibleVersions.join(', ')}.`,
        ...(versionMatches ? {} : { remedy }) },
    ],
    ...(protocolMatches && versionMatches ? { image: { reference, id: image.Id,
      digests: (image.RepoDigests ?? []).filter(value => imageReferencePattern.test(value)), protocol, executor, version } } : {}),
    absent: false,
  };
}

export async function prepareWorkerImage({ packageRoot, requestedImage, executor = 'pi', install, signal }: {
  packageRoot: string; requestedImage?: string; executor?: ExecutorSelection; install: boolean; signal: AbortSignal;
}): Promise<WorkerInspection & { reference: string; source: 'cache' | 'build' | 'pull' }> {
  const driver = selectExecutorDriver(executor);
  const reference = requestedImage ?? workerImageFor(executor);
  const cached = await inspectWorker(reference, driver, signal);
  if (!install || cached.image || !cached.absent) return { ...cached, reference, source: 'cache' };

  if (requestedImage && imageIdPattern.test(requestedImage)) return { ...cached, reference, source: 'cache' };
  if (requestedImage || driver.adapter) {
    try {
      await exec('docker', ['pull', '--', reference], { signal, timeout: 15 * 60_000, maxBuffer: 12 * 1024 * 1024 });
    } catch {
      signal.throwIfAborted();
      return { ...cached, reference, source: 'pull', checks: [{ id: 'worker-pull', ok: false,
        detail: 'Docker could not pull the Worker image.',
        remedy: 'Check the requested image reference and registry access, or import the compatible Worker image locally.' }] };
    }
    return { ...(await inspectWorker(reference, driver, signal)), reference, source: 'pull' };
  }

  // Prefer the prebuilt official GHCR image for fast onboarding; fall back to a local build when unavailable.
  try {
    await exec('docker', ['pull', '--', reference], { signal, timeout: 10 * 60_000, maxBuffer: 12 * 1024 * 1024 });
    const pulled = await inspectWorker(reference, driver, signal);
    if (pulled.image) return { ...pulled, reference, source: 'pull' };
  } catch {
    signal.throwIfAborted();
  }

  try {
    await exec('docker', ['build', '--file', join(packageRoot, 'deploy/worker/Dockerfile'), '--tag', reference,
      '--build-arg', `WORKER_EXECUTOR=${driver.kind}`, '--build-arg', `${driver.kind.toUpperCase()}_VERSION=${driver.version}`, packageRoot],
      { signal, timeout: 15 * 60_000, maxBuffer: 12 * 1024 * 1024 });
  } catch {
    signal.throwIfAborted();
    return { ...cached, reference, source: 'build', checks: [{ id: 'worker-build', ok: false,
      detail: 'Docker could not build the Worker image.',
      remedy: `Run docker build -f deploy/worker/Dockerfile -t ${reference} . in the package or checkout to inspect the build failure.` }] };
  }
  return { ...(await inspectWorker(reference, driver, signal)), reference, source: 'build' };
}
