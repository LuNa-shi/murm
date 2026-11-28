import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ERROR_CODES, MurmError } from '../../errors.js';
import { stableStringify } from '../../persistence/envelope.js';

export const FIXTURE_REQUIRED_FIELDS = Object.freeze([
  'fixture_id', 'problem_file', 'problem_file_hash', 'lean_toolchain',
  'mathlib_version', 'checker_ref', 'checker_version', 'environment_ref',
]);

function sha256(value: any) {
  return createHash('sha256').update(value).digest('hex');
}

export function validateFixtureManifest(manifest: any) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'fixture_manifest is required');
  for (const field of FIXTURE_REQUIRED_FIELDS) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, `fixture_manifest.${field} is required`);
  }
  const commit = manifest.fixture_commit ?? manifest.putnambench_commit;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'fixture_commit (or putnambench_commit) must be a full commit SHA');
  if (!/^[0-9a-f]{64}$/.test(manifest.problem_file_hash)) throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'problem_file_hash must be SHA-256');
  return manifest;
}

export async function createFixtureManifest({ fixtureId, fixtureCommit, putnambenchCommit, problemFile, leanToolchain, mathlibVersion, checkerRef, checkerVersion, environmentRef, projectRoot = null }: any) {
  const commit = fixtureCommit ?? putnambenchCommit;
  const content = await readFile(problemFile);
  return validateFixtureManifest({
    fixture_id: fixtureId,
    fixture_commit: commit,
    problem_file: problemFile,
    problem_file_hash: sha256(content),
    lean_toolchain: leanToolchain,
    mathlib_version: mathlibVersion,
    checker_ref: checkerRef,
    checker_version: checkerVersion,
    environment_ref: environmentRef,
    project_root: projectRoot,
    manifest_hash: sha256(stableStringify({ fixtureId, fixtureCommit: commit, problemFile, leanToolchain, mathlibVersion, checkerRef, checkerVersion, environmentRef, projectRoot })),
  });
}
