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
export const OPENAI_MATH_SOURCE_PINS = Object.freeze({
  lean: '4.34.1',
  lean_commit: '5045d0056413266e57c625dcd7c365b10e377c52',
  comparator: '3927ad383f208ae977c340a91c48ac9b497d2097',
  lean4export: '15f6055e299ad5b89345e533cc2192f4cc00f659',
  mathlib: 'd13f23b723b8a846827a245b89c10fc7d3f11612',
});
const fltContractPath = fileURLToPath(new URL('../../benchmarks/flt10/projection-contract.json', import.meta.url));
const fltPins = Object.freeze({ ...FINAL_TREE_SOURCE_PINS,
  mathlib: 'db584cd6d46c92f209a44c0f1c829460d327499d',
  flt: 'aa2d8b34692b16c70f699536de0d8e75b9a3e9ef',
});
function sourcePins(configuration) {
  if (configuration.benchmarkProfile == null) return FINAL_TREE_SOURCE_PINS;
  if (['flt10-dag-v1', 'flt10-subtree-v1'].includes(configuration.benchmarkProfile)) return fltPins;
  if (configuration.benchmarkProfile === 'openai-math-v1') return OPENAI_MATH_SOURCE_PINS;
  throw failure('Unknown checker benchmark profile');
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
    ...(configuration.benchmarkProfile == null ? {} : {
      benchmarkProfile: configuration.benchmarkProfile, checkpoint: configuration.checkpoint,
      projectionRoot: configuration.projectionRoot,
      ...(configuration.benchmarkProfile === 'flt10-subtree-v1'
        ? { foundationSha256: configuration.foundationSha256, requireCompleteProject: true }
        : configuration.benchmarkProfile === 'openai-math-v1'
          ? { requireCompleteProject: true, projectChecks: true }
        : { preserveFixturePrefix: true }),
    }),
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
    { label: 'resource-launcher', path: fileURLToPath(new URL('./checker-process-limits.js', import.meta.url)) },
    { label: 'resource-owner', path: fileURLToPath(new URL('./checker-owner.js', import.meta.url)) },
    { label: 'dash', path: '/usr/bin/dash' },
    { label: 'mkdir', path: '/usr/bin/mkdir' },
    { label: 'systemd-run', path: '/usr/bin/systemd-run' },
    { label: 'systemctl', path: '/usr/bin/systemctl' },
    ...hostMounts.map((path, index) => ({ label: `host-library-${index}`, path, host: true, directory: true })),
    ...(configuration.benchmarkProfile === 'flt10-dag-v1' ? [{ label: 'flt-contract', path: fltContractPath }] : []),
    ...(configuration.benchmarkProfile === 'flt10-subtree-v1' ? [{ label: 'flt-foundation', path: join(configuration.projectionRoot, 'foundation-manifest.json') }] : []),
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
  for (const key of ['comparator', 'lean4export', 'mathlib', ...(pins.flt ? ['flt'] : [])]) {
    const root = await canonical(sources?.[key], key);
    const { stdout } = await exec('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { env: {}, timeout: 5000, maxBuffer: 4096 });
    const changes = await exec('/usr/bin/git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { env: {}, timeout: 5000, maxBuffer: 64 * 1024 });
    if (stdout.trim() !== pins[key] || changes.stdout.trim()) throw failure(`Unexpected ${key} checkout revision or tracked changes`);
    sourceRoots[key] = root;
  }
  const library = root => join(root, '.lake/build/lib/lean');
  const mathlibDependencies = JSON.parse(await readFile(join(sourceRoots.mathlib, 'lake-manifest.json'), 'utf8')).packages;
  const dependencyPins = {};
  const projectionLibrary = pins.flt ? await verifyFltProjection(configuration, sourceRoots.flt) : null;
  for (const root of configuration.libraryRoots) {
    if (root === projectionLibrary) continue;
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

async function verifyFltProjection(configuration, sourceRoot) {
  if (configuration.benchmarkProfile === 'flt10-subtree-v1') return verifyFltFoundation(configuration);
  const contract = JSON.parse(await readFile(fltContractPath, 'utf8'))[configuration.checkpoint];
  if (!contract || !Number.isInteger(configuration.checkpoint)) throw failure('Unknown FLT checkpoint');
  const root = await canonical(configuration.projectionRoot, 'FLT projection');
  const library = join(root, 'lib');
  if (!configuration.libraryRoots.includes(library)) throw failure('FLT projection library is missing');
  const expected = new Set();
  for (const [path, expectedHash] of Object.entries(contract.sources)) {
    const original = await readFile(join(sourceRoot, path));
    const projected = await readFile(join(root, 'source', path));
    if (!original.equals(projected) || createHash('sha256').update(projected).digest('hex') !== expectedHash) {
      throw failure(`FLT definition differs from the pinned cut: ${path}`);
    }
    expected.add(path.replace(/\.lean$/, '.olean'));
  }
  const frontier = `FLT10/DAG_q${configuration.checkpoint}.lean`;
  if (await readFile(join(root, 'source', frontier), 'utf8') !== contract.frontier) throw failure('FLT frontier differs from the pinned cut');
  expected.add(frontier.replace(/\.lean$/, '.olean'));
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
      else if (!entry.isFile() || !expected.delete(path)) throw failure(`Unexpected artifact in FLT projection: ${path}`);
    }
  }
  await visit(library);
  if (expected.size) throw failure('FLT projection lacks compiled safe modules');
  return library;
}

async function verifyFltFoundation(configuration) {
  const root = await canonical(configuration.projectionRoot, 'FLT foundation');
  const bytes = await readFile(join(root, 'foundation-manifest.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== configuration.foundationSha256) {
    throw failure('FLT foundation manifest differs from its configured digest');
  }
  const manifest = JSON.parse(bytes);
  if (manifest.profile !== 'flt10-subtree-v1' || manifest.checkpoint !== configuration.checkpoint ||
      !/^([1-9]0|100)$/.test(String(manifest.checkpoint)) ||
      !manifest.sources || !Object.hasOwn(manifest.sources, 'FLTFoundation.lean')) {
    throw failure('Invalid FLT root-only foundation manifest');
  }
  const library = join(root, 'lib');
  if (!configuration.libraryRoots.includes(library)) throw failure('FLT foundation library is missing');
  const expected = new Set();
  for (const [path, sha] of Object.entries(manifest.sources)) {
    if (!/^(?:FLTFoundation|Definitions\/[A-Za-z_][A-Za-z0-9_]*)\.lean$/.test(path) ||
        !/^[a-f0-9]{64}$/.test(sha) || await realpath(join(root, 'source', path)) !== join(root, 'source', path) ||
        createHash('sha256').update(await readFile(join(root, 'source', path))).digest('hex') !== sha) {
      throw failure('FLT foundation source differs from its manifest');
    }
    expected.add(path.replace(/\.lean$/, '.olean'));
  }
  const visit = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path + '/');
      else if (!entry.isFile() || !expected.delete(path)) throw failure('Unexpected artifact in FLT root-only foundation');
    }
  };
  await visit(library);
  if (expected.size) throw failure('FLT root-only foundation lacks compiled modules');
  return library;
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
  if (sourcePins(deployment).flt && problem?.checkpoint !== deployment.checkpoint) {
    throw failure('FLT problem checkpoint does not match the locked projection');
  }
  if (deployment.benchmarkProfile === 'flt10-subtree-v1') {
    const bytes = await readFile(join(deployment.projectionRoot, 'foundation-manifest.json'));
    const foundation = JSON.parse(bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== deployment.foundationSha256 ||
        foundation.target_sha256 !== problem.source_hash ||
        foundation.declaration_name !== (problem.declaration_name ?? problem.id)) {
      throw failure('FLT problem does not match the locked foundation target');
    }
  }
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
  return { adapter, evidence: { artifact_lock_sha256: sha256, identity, sources: sourcePins(deployment), dependency_pins: manifest.dependencyPins, timeout_ms: adapter.timeoutMs, project_checks: adapter.projectChecks, project_jobs: adapter.projectJobs, resources } };
}
