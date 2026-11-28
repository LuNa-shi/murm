import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Check private run registration before reserving output or invoking a hosted model. */
export async function verifyPutnamRegistration({
  registryPath, experimentId, repository, model, requireModel = false, cwd = process.cwd(),
}: {
  registryPath?: string;
  experimentId: string;
  repository: string;
  model: { provider: string; model: string };
  requireModel?: boolean;
  cwd?: string;
}) {
  if (!registryPath?.trim()) {
    throw new Error('MURM_EXPERIMENT_REGISTRY must name the private experiment registry');
  }
  if (!/^EXP-\d{8}-\d{2}$/.test(experimentId)) throw new Error('Invalid formal run ID');
  const registry = resolve(cwd, registryPath);
  const index = await readFile(registry, 'utf8');
  const rows = index.split('\n').filter(line => line.startsWith(`| \`${experimentId}\` |`));
  if (rows.length !== 1) throw new Error('The formal run ID must have one entry in the experiment registry');
  const [, , issue, status, pinnedCode, report] = rows[0].split('|').map(value => value.trim());
  if (!issue?.includes('/issues/200)') || !status?.startsWith('**REGISTERED') || !/^`[a-f0-9]{7,40}`$/.test(pinnedCode ?? '')) {
    throw new Error('Register the Putnam run under #200 and pin its code before launch');
  }
  const reportName = report?.match(/\(([a-z0-9-]+\.md)\)$/i)?.[1];
  if (!reportName) throw new Error('The registry entry must link a sibling Markdown report');
  const reportPath = join(dirname(registry), reportName);
  const reportBody = await readFile(reportPath, 'utf8');
  const models = [...reportBody.matchAll(/^Model · `([^\n`]+)`$/gm)].map(match => match[1]);
  const registeredModel = models[0];
  if (models.length > 1 || ((registeredModel || requireModel) && registeredModel !== model.provider + '/' + model.model)) {
    throw new Error('The selected Putnam model pair must match the registered report');
  }
  const git = async (args: string[]) => (await execute('git', args, { cwd: repository, timeout: 10_000 })).stdout.trim();
  const [code, head, changed] = await Promise.all([
    git(['rev-parse', `${pinnedCode.slice(1, -1)}^{commit}`]),
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain']),
  ]);
  if (code !== head || changed) throw new Error('The checkout differs from the registered implementation');
  return { code, registryPath: registry, reportPath };
}
