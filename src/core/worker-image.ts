import { readFileSync } from 'node:fs';
import { selectExecutorDriver } from './executor-driver.js';

export const WORKER_IMAGE_REPOSITORY = 'ghcr.io/luna-shi/murm-worker';
export const WORKER_PROTOCOL = 'murm-core-v1';
export const WORKER_PI_VERSION = '1.3.0';

function readPackageVersion(): string {
  for (const relative of ['../../package.json', '../../../package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (parsed.name === '@luna-shi/murm' && typeof parsed.version === 'string' && parsed.version) {
        return parsed.version;
      }
    } catch {
      // Try the compiled dist/src/core -> package root path next.
    }
  }
  return '0.2.0';
}

export const PACKAGE_VERSION = readPackageVersion();

/**
 * Default OpenSandbox Worker image tag matching this @luna-shi/murm release.
 * `murm setup` pulls this image from GHCR when available, or builds it locally
 * from `deploy/worker/Dockerfile` and tags it with this exact reference.
 */
export const DEFAULT_WORKER_IMAGE = `${WORKER_IMAGE_REPOSITORY}:${PACKAGE_VERSION}`;

export function workerImageFor(executor: unknown = 'pi'): string {
  const driver = selectExecutorDriver(executor);
  return driver.adapter?.image ?? `${DEFAULT_WORKER_IMAGE}-${driver.kind}${
    driver.version === selectExecutorDriver(driver.kind).version ? '' : `-${driver.version}`}`;
}
