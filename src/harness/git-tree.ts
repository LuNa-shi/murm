import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { isFileTreePath } from '../core/files/core-file-seed.js';
import { ERROR_CODES, MurmError } from '../errors.js';

const execFile = promisify(nodeExecFile);
const GIT_IDENTITY = ['-c', 'user.name=murm Runtime', '-c', 'user.email=runtime@murm.invalid'];

export function isGitTreePath(path: unknown): path is string {
  return isFileTreePath(path) && !path.split('/').some(part => part.toLowerCase() === '.git');
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]: any) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', ...extra };
}

async function git(root: string, args: string[], options: any = {}) {
  try { return (await execFile('git', ['-C', root, ...args], { env: gitEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...options })).stdout; }
  catch (error: any) { throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Git tree operation failed', { operation: args[0] }, { cause: error }); }
}

export async function initializeGitRepository(root: string) { await git(root, ['init', '--initial-branch=main', '--template=', root]); }

export async function importGitTree(root: string, files: Readonly<Record<string, string | Uint8Array>>, parentCommits: readonly string[], message: string, modes?: Readonly<Record<string, 0o644 | 0o755>>, stageRoot = join(root, '.swarm-staging')) {
  await mkdir(stageRoot, { recursive: true });
  const stage = await mkdtemp(join(stageRoot, 'tree-'));
  const worktree = join(stage, 'files');
  await mkdir(worktree);
  try {
    const entries: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      const target = join(worktree, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      const blob = String(await git(root, ['hash-object', '--no-filters', '-w', '--', target])).trim();
      entries.push(`${modes?.[path] === 0o755 ? '100755' : '100644'} ${blob}\t${path}\0`);
    }
    const env = gitEnvironment({ GIT_INDEX_FILE: join(stage, 'index') });
    await git(root, ['read-tree', '--empty'], { env });
    await new Promise<void>((resolve, reject) => {
      const child = nodeExecFile('git', ['-C', root, 'update-index', '-z', '--index-info'], { env, timeout: 30_000 }, error => error ? reject(error) : resolve());
      child.stdin!.on('error', reject);
      child.stdin!.end(entries.join(''));
    });
    const tree = String(await git(root, ['write-tree'], { env })).trim();
    return { tree, commit: await commitGitTree(root, tree, parentCommits, message) };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function commitGitTree(root: string, tree: string, parents: readonly string[], message: string) {
  return String(await git(root, [...GIT_IDENTITY, 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message])).trim();
}
