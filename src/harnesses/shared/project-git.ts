import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FileTree } from '@murm/core';
import { decodeFileSeed, isFileTreePath } from '../../../scripts/core-file-seed.js';
import { WorkspaceRepository } from '../../runtime/workspace-repository.js';
import { projectError } from './project-input.js';

const git = promisify(execFile);

/** Validate before the provisioner makes externally visible changes. */
export function checkGitProject(files: FileTree) {
  for (const path of Object.keys(files)) {
    if (!isFileTreePath(path) || path.split('/').some(part => part.toLowerCase() === '.git')) throw projectError('PROJECT_PATH_INVALID', `Team Git does not admit ${JSON.stringify(path)}`);
  }
}

export async function seedTeamRepository({ files, url, owner, token, signal }: {
  files: FileTree; url: string; owner: string; token: string; signal?: AbortSignal;
}) {
  signal?.throwIfAborted();
  checkGitProject(files);
  const work = await mkdtemp(join(tmpdir(), 'murm-team-git-'));
  try {
    const repository = new WorkspaceRepository();
    const { entries } = decodeFileSeed(files);
    await repository.initialize(work);
    const { commit } = await repository.importTree(work,
      Object.fromEntries(entries.map(({ path, bytes }) => [path, bytes])), [], 'Initial project input',
      Object.fromEntries(entries.map(({ path, mode }) => [path, mode === 0o755 ? 0o755 as const : 0o644 as const])));
    signal?.throwIfAborted();
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'http.extraHeader',
      GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`${owner}:${token}`).toString('base64')}`,
    };
    await git('git', ['-C', work, 'push', '--', url, `${commit}:refs/heads/main`], { env, signal, timeout: 30_000 });
    return commit;
  } catch {
    signal?.throwIfAborted();
    throw projectError('PROJECT_GIT_SEED_FAILED', 'Could not establish the initial team Git revision');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export const seededCheckoutInstruction = 'Your project files are already installed. Before editing, initialize Git in this directory, add RUN_REPOSITORY as origin, fetch main, and create WORK_BRANCH by running git init && git remote add origin "$RUN_REPOSITORY" && git fetch origin main && git switch -c "$WORK_BRANCH" && git reset --mixed "$RUN_INITIAL_COMMIT". If origin and your branch are already configured, keep this checkout and do not repeat initialization. Preserve the installed files. Use your native Git credential helper and keep credentials private.';
