import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../protocol/envelope.js';
import { checkerResourceProfile, verifyCheckerProcessLimits } from './checker-process-limits.js';
import { LeanFinalTreeVerifier } from './lean-final-tree-verifier.js';

const exec = promisify(execFile);
const harness = fileURLToPath(new URL('./final-tree-proof.lean', import.meta.url));
export const FINAL_TREE_SOURCE_PINS = Object.freeze({
  lean: '4.33.1',
  lean_commit: '819816b2e0a3bf405af45ae5c7af2491d8f5bee6',
  comparator: '3927ad383f208ae977c340a91c48ac9b497d2097',
  lean4export: '15f6055e299ad5b89345e533cc2192f4cc00f659',
  mathlib: '0df444a360eaa60ab8c11dca51a86af692955474',
});
function sourcePins(configuration) {
  if (configuration.benchmarkProfile != null) throw failure('Benchmark profiles have been retired from the checker deployment');
  return FINAL_TREE_SOURCE_PINS;
}
const hash = value => createHash('sha256').update(stableStringify(value)).digest('hex');
const failure = message => new Error(message);
const hostMounts = Object.freeze(['/usr/lib', '/usr/lib64']);

async function digestFile(path, size) {
  if (size <= 1024 * 1024) return createHash('sha256').update(await readFile(path)).digest('hex');
  const digest = createHash('sha256');
  const file = await open(path, 'r');
  try {
    for await (const chunk of file.createReadStream({ highWaterMark: 1024 * 1024, autoClose: false })) digest.update(chunk);
    return digest.digest('hex');
  } finally { await file.close(); }
}

function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonical(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) {
    throw failure(`Checker artifact ${label} must use a canonical absolute path`);
  }
  return path;
}

export async function fingerprintFinalTreeArtifact(root, { label, host = false, directory = undefined }) {
  await canonical(root, label);
  if (directory !== undefined && (await lstat(root)).isDirectory() !== directory) {
    throw failure(`Checker artifact ${label} has the wrong filesystem type`);
  }
  const digest = createHash('sha256');
  let entries = 0;
  async function visit(path) {
    const stat = await lstat(path);
    const location = relative(root, path);
    let record;
    if (stat.isDirectory()) {
      record = ['directory', location, stat.mode & 0o777];
    } else if (stat.isFile()) {
      record = ['file', location, stat.mode & 0o777, stat.size, await digestFile(path, stat.size)];
      const end = await lstat(path);
      if (end.ino !== stat.ino || end.dev !== stat.dev || end.size !== stat.size || end.ctimeMs !== stat.ctimeMs) {
        throw failure(`Checker artifact ${label} changed during verification`);
      }
    } else if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      if (!host) {
        const resolved = await realpath(path);
        if (isAbsolute(target) || !within(root, resolved)) {
          throw failure(`Checker artifact ${label} contains a symlink outside its mount`);
        }
      }
      // Fixed host OS mounts may contain OS-package links to unmounted paths.
      // Their literal targets are locked, and bwrap resolves them in its own
      // filesystem namespace. Do not follow them into the host filesystem.
      record = ['symlink', location, target];
    } else {
      throw failure(`Checker artifact ${label} contains an unsupported filesystem entry`);
    }
    digest.update(`${stableStringify(record)}\n`);
    entries += 1;
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    }
  }
  await visit(root);
  return { label, path: root, sha256: digest.digest('hex'), entries };
}

function selected(configuration) {
  sourcePins(configuration ?? {});
  checkerResourceProfile(configuration?.resources);
  if (configuration?.projectJobs !== undefined && (!Number.isSafeInteger(configuration.projectJobs) || configuration.projectJobs < 1 || configuration.projectJobs > 256)) {
    throw failure('Invalid project build concurrency');
  }
  if (!configuration || !Array.isArray(configuration.libraryRoots) || !Array.isArray(configuration.comparatorLibraryRoots) ||
      configuration.comparatorLibraryRoots.length !== 2 || !configuration.libraryRoots.length) {
    throw failure('Checker configuration requires pinned dependency and Comparator libraries');
  }
  const identity = Object.fromEntries(['checker_ref', 'checker_version', 'environment_ref'].map(key => [key, configuration.identity?.[key]]));
  if (Object.values(identity).some(value => typeof value !== 'string' || !value || value.length > 256)) {
    throw failure('Checker configuration requires a fixed identity');
  }
  return {
    identity, leanRoot: configuration.leanRoot, libraryRoots: configuration.libraryRoots,
    comparatorLibraryRoots: configuration.comparatorLibraryRoots, exporterPath: configuration.exporterPath,
    bubblewrap: configuration.bubblewrap ?? '/usr/bin/bwrap', localModules: configuration.localModules ?? [],
    timeoutMs: configuration.timeoutMs ?? 120_000,
    moduleCacheBytes: configuration.moduleCacheBytes ?? 128 * 1024 ** 2,
    ...(configuration.resources === undefined ? {} : { resources: { ...configuration.resources } }),
    ...(configuration.projectJobs === undefined ? {} : { projectJobs: configuration.projectJobs }),
    ...(configuration.projectChecks === undefined ? {} : { projectChecks: configuration.projectChecks }),
  };
}

async function artifacts(configuration, expected = null) {
  const { leanRoot, libraryRoots, comparatorLibraryRoots, exporterPath, bubblewrap } = configuration;
  await canonical(leanRoot, 'leanRoot');
  const roots = [
    { label: 'lean-bin', path: join(leanRoot, 'bin'), directory: true },
    { label: 'lean-lib', path: join(leanRoot, 'lib'), directory: true },
    ...libraryRoots.map((path, index) => ({ label: `dependency-${index}`, path, directory: true })),
    ...comparatorLibraryRoots.map((path, index) => ({ label: `comparator-${index}`, path, directory: true })),
    { label: 'lean4export', path: exporterPath },
    { label: 'bubblewrap', path: bubblewrap },
    { label: 'validator', path: harness },
    { label: 'module-checker', path: fileURLToPath(new URL('./lean-module-checker.js', import.meta.url)) },
    { label: 'module-build-driver', path: fileURLToPath(new URL('./lean-module-build.lean', import.meta.url)) },
    { label: 'module-proof-verifier', path: fileURLToPath(new URL('./lean-module-verify.lean', import.meta.url)) },
    { label: 'base64', path: '/usr/bin/base64' },
    { label: 'verifier', path: fileURLToPath(new URL('./lean-final-tree-verifier.js', import.meta.url)) },
    { label: 'lean-source-policy', path: fileURLToPath(new URL('./lean-source-policy.js', import.meta.url)) },
    { label: 'resource-launcher', path: fileURLToPath(new URL('./checker-process-limits.js', import.meta.url)) },
    { label: 'resource-owner', path: fileURLToPath(new URL('./checker-owner.js', import.meta.url)) },
    { label: 'dash', path: '/usr/bin/dash' },
    { label: 'mkdir', path: '/usr/bin/mkdir' },
    { label: 'systemd-run', path: '/usr/bin/systemd-run' },
    { label: 'systemctl', path: '/usr/bin/systemctl' },
    ...hostMounts.map((path, index) => ({ label: `host-library-${index}`, path, host: true, directory: true })),
  ];
  if (expected && (!Array.isArray(expected) || expected.length !== roots.length)) {
    throw failure('Final-tree checker artifact set differs from its lock');
  }
  const locked = [];
  for (const root of roots) {
    if (root.label === 'mkdir' || root.label === 'base64') {
      const observed = await realpath(root.path);
      if (observed !== root.path && !hostMounts.some(mount => within(mount, observed))) {
        throw failure(`System ${root.label} target is outside approved host library mounts`);
      }
      const artifact = await fingerprintFinalTreeArtifact(observed, { label: root.label, directory: false });
      locked.push({ ...artifact, invoked_as: root.path, link: observed === root.path ? null : await readlink(root.path) });
    } else {
      locked.push(await fingerprintFinalTreeArtifact(root.path, { directory: false, ...root }));
    }
    if (expected && stableStringify(locked.at(-1)) !== stableStringify(expected[locked.length - 1])) {
      throw failure(`Final-tree checker artifact content or path drift: ${root.label}`);
    }
  }
  return locked;
}

async function verifyVersion(leanRoot, bubblewrap = null, pins = FINAL_TREE_SOURCE_PINS) {
  const command = bubblewrap ?? join(leanRoot, 'bin/lean');
  const args = bubblewrap ? [
    '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--clearenv',
    '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', '/usr/lib64', '/usr/lib64',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', join(leanRoot, 'bin'), '/toolchain/bin', '--ro-bind', join(leanRoot, 'lib'), '/toolchain/lib',
    '--proc', '/proc', '--dev', '/dev', '/toolchain/bin/lean', '--version',
  ] : ['--version'];
  const { stdout } = await exec(command, args, { env: {}, timeout: 5000, maxBuffer: 4096 });
  if (!stdout.startsWith(`Lean (version ${pins.lean},`) || !stdout.includes(`commit ${pins.lean_commit},`)) {
    throw failure('Observed Lean toolchain differs from the approved build');
  }
}

async function verifySources(configuration, sources) {
  const sourceRoots = {};
  const pins = sourcePins(configuration);
  for (const key of ['comparator', 'lean4export', 'mathlib']) {
    const root = await canonical(sources?.[key], key);
    const { stdout } = await exec('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { env: {}, timeout: 5000, maxBuffer: 4096 });
    const changes = await exec('/usr/bin/git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { env: {}, timeout: 5000, maxBuffer: 64 * 1024 });
    if (stdout.trim() !== pins[key] || changes.stdout.trim()) throw failure(`Unexpected ${key} checkout revision or tracked changes`);
    sourceRoots[key] = root;
  }
  const library = root => join(root, '.lake/build/lib/lean');
  const mathlibDependencies = JSON.parse(await readFile(join(sourceRoots.mathlib, 'lake-manifest.json'), 'utf8')).packages;
  const dependencyPins = {};
  for (const root of configuration.libraryRoots) {
    if (root === library(sourceRoots.mathlib)) continue;
    const match = mathlibDependencies.find(pkg => root === library(resolve(sourceRoots.mathlib, '..', pkg.name)));
    if (!match) throw failure('Checker dependency is not a pinned Mathlib package');
    const checkout = resolve(sourceRoots.mathlib, '..', match.name);
    const { stdout } = await exec('/usr/bin/git', ['-C', checkout, 'rev-parse', 'HEAD'], { env: {}, timeout: 5000, maxBuffer: 4096 });
    const changes = await exec('/usr/bin/git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { env: {}, timeout: 5000, maxBuffer: 64 * 1024 });
    if (stdout.trim() !== match.rev || changes.stdout.trim()) throw failure('Mathlib dependency checkout differs from its locked manifest');
    dependencyPins[match.name] = match.rev;
  }
  if (stableStringify(configuration.comparatorLibraryRoots) !== stableStringify([library(sourceRoots.comparator), library(sourceRoots.lean4export)]) ||
      configuration.exporterPath !== join(sourceRoots.lean4export, '.lake/build/bin/lean4export') ||
      !configuration.libraryRoots.includes(library(sourceRoots.mathlib))) {
    throw failure('Checker artifacts do not come from the configured approved source checkouts');
  }
  return { sourceRoots, dependencyPins };
}

/** Trusted operator tool. This attests to the supplied source/build deployments. */
export async function createFinalTreeArtifactLock({ configuration, sources }) {
  const deployment = selected(configuration);
  await verifyVersion(deployment.leanRoot, null, sourcePins(deployment));
  const { sourceRoots, dependencyPins } = await verifySources(deployment, sources);
  const manifest = {
    version: 1, configuration: deployment, sources: sourcePins(deployment), sourceRoots, dependencyPins,
    artifacts: await artifacts(deployment),
  };
  return { ...manifest, sha256: hash(manifest) };
}

export async function createLockedFinalTreeVerifier({ configuration, problem }) {
  const deployment = selected(configuration);
  const input = configuration.artifactLock;
  if (!input) throw failure('Trusted final-tree artifact lock is required');
  const lock = typeof input === 'string' ? JSON.parse(await readFile(await canonical(input, 'lock'), 'utf8')) : structuredClone(input);
  const { sha256, ...manifest } = lock ?? {};
  if (manifest.version !== 1 || sha256 !== hash(manifest) ||
      stableStringify(manifest.configuration) !== stableStringify(deployment) ||
      stableStringify(manifest.sources) !== stableStringify(sourcePins(deployment))) {
    throw failure('Final-tree artifact lock does not match this checker configuration');
  }
  if (!Array.isArray(manifest.artifacts)) throw failure('Final-tree artifact lock lacks an artifact set');
  await artifacts(deployment, manifest.artifacts);
  await verifyVersion(deployment.leanRoot, deployment.bubblewrap, sourcePins(deployment));
  const resources = await verifyCheckerProcessLimits(deployment.resources);
  const identity = { ...deployment.identity, environment_ref: `${deployment.identity.environment_ref}:sha256:${sha256}` };
  const adapter = new LeanFinalTreeVerifier({
    ...deployment, identity, targetPath: problem.problem_file, declarationName: problem.declaration_name ?? problem.id,
    fixtureSource: problem.source, fixtureSha256: problem.source_hash,
  });
  await adapter.verifyExportCompatibility();
  return { adapter, evidence: { export_compatibility_verified: true, artifact_lock_sha256: sha256, identity, sources: sourcePins(deployment), dependency_pins: manifest.dependencyPins, timeout_ms: adapter.timeoutMs, project_checks: adapter.projectChecks, project_jobs: adapter.projectJobs, resources } };
}
