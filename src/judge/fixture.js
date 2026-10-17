import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';

export const FIXTURE_REQUIRED_FIELDS = Object.freeze([
  'fixture_id', 'putnambench_commit', 'problem_file', 'problem_file_hash', 'lean_toolchain',
  'mathlib_version', 'checker_ref', 'checker_version', 'environment_ref',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function validateFixtureManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'fixture_manifest is required');
  for (const field of FIXTURE_REQUIRED_FIELDS) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `fixture_manifest.${field} is required`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.putnambench_commit)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'putnambench_commit must be a full commit SHA');
  if (!/^[0-9a-f]{64}$/.test(manifest.problem_file_hash)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'problem_file_hash must be SHA-256');
  return manifest;
}

export async function createFixtureManifest({ fixtureId, putnambenchCommit, problemFile, leanToolchain, mathlibVersion, checkerRef, checkerVersion, environmentRef, projectRoot = null }) {
  const content = await readFile(problemFile);
  return validateFixtureManifest({
    fixture_id: fixtureId,
    putnambench_commit: putnambenchCommit,
    problem_file: problemFile,
    problem_file_hash: sha256(content),
    lean_toolchain: leanToolchain,
    mathlib_version: mathlibVersion,
    checker_ref: checkerRef,
    checker_version: checkerVersion,
    environment_ref: environmentRef,
    project_root: projectRoot,
    manifest_hash: sha256(stableStringify({ fixtureId, putnambenchCommit, problemFile, leanToolchain, mathlibVersion, checkerRef, checkerVersion, environmentRef, projectRoot })),
  });
}
