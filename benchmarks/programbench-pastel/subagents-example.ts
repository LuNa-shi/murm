import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runSubagentsHarness } from '../../dist/examples/subagents/main.js';

const exec = promisify(execFile);
const referenceImage = 'programbench/sharkdp_1776_pastel.b60e899@sha256:e75597f4307bf02746598d2b7eb8ae136b9978f0c2551e04b065b14e9e5f9c4e';
const buildImage = 'node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90';
const initial = [
  'Implement a small offline subset of Pastel: pastel format FORMAT COLOR.',
  'Support hex and rgb output for opaque #RRGGBB (case insensitive) and rgb(R, G, B) inputs with integer channels from 0 to 255.',
  'Match the Pastel reference stdout on this scope. Reject malformed colors with a nonzero exit.',
  'Reference executable: /opt/programbench/executable. Public docs are in /opt/programbench.',
  'Use the available Subagents to work on meaningful independent parts in parallel. Inspect the collaboration Service early. Choose the assignments and team size yourself, work on a complementary part while the children work, and use their concrete findings, tests, or patches in the delivery.',
  'Keep each assignment focused on a distinct deliverable. Ask children to send a first usable result as soon as it is verified so you can use it before their final reply. Probe representative cases for the stated formats. Ship the buildable, tested solution when it meets the stated scope and describe any remaining uncertainty. The task does not require an exhaustive sweep of the color space.',
  'Deliver delivery/compile.sh, delivery/README.md, delivery/pastel.js and delivery/test.js.',
  'Make an initial buildable delivery with its tests early, then improve it using verified child contributions. Run the build and tests again before the final reply.',
  'compile.sh must build an executable named pastel in that directory using available Node.js and shell tools, offline.',
  'Clean rebuilds and execution use a container with Node.js and no Pastel executable.',
].join('\n');
const supplement = [
  'New requirement: also support hsl output from the already supported inputs.',
  'Match the same Pastel reference formatting, including hue rounding, decimal digits and percentages.',
  'If this affects work you delegated, tell the affected members so their contributions account for it.',
  'Keep the original behavior and update the tests and README.',
  'Use a small set of representative HSL probes for verification and avoid duplicating the same broad investigation across the team.',
].join('\n');
const probes = [
  ['rgb', '#fF4080'], ['hex', 'rgb(12, 34, 56)'], ['rgb', 'rgb(0, 255, 0)'],
  ['hex', '#00FF01'], ['hsl', '#ff0000'], ['hsl', '#7455a9'], ['hsl', 'rgb(34, 101, 76)'],
] as const;

async function docker(args: string[]) {
  return exec('docker', args, { timeout: 30_000, maxBuffer: 64 * 1024 });
}

export async function checkPastelExample(candidate: string) {
  const directory = resolve(candidate);
  for (const path of ['compile.sh', 'README.md', 'pastel.js', 'test.js']) {
    if (!(await stat(join(directory, path))).isFile()) throw new Error('Missing required delivery file ' + path);
  }
  const expected = await Promise.all(probes.map(([format, color]) => docker([
    'run', '--rm', '--pull=never', '--network', 'none', '--entrypoint', '/workspace/executable',
    referenceImage, 'format', format, color,
  ]).then(result => result.stdout)));
  const script = `set -eu
cp -R /candidate/. /tmp/build
cd /tmp/build
rm -f pastel
sh ./compile.sh >&2
test -x pastel
node --test test.js >&2
while [ "$#" -gt 0 ]; do
  ./pastel format "$1" "$2"
  shift 2
done
if ./pastel format hex 'not-a-color' >/dev/null 2>&1; then exit 10; fi`;
  const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  const { stdout } = await docker(['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
    '--user', user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m',
    '--tmpfs', '/tmp:exec,size=32m', '--mount', `type=bind,source=${directory},target=/candidate,readonly`,
    '--entrypoint', '/usr/bin/timeout', buildImage, '--kill-after=1s', '20s', '/bin/sh', '-c', script, 'check', ...probes.flat()]);
  if (stdout !== expected.join('')) throw new Error('Candidate output differs from the pinned Pastel reference');
  return { referenceCases: probes.length, invalidColorRejected: true };
}

async function modelRequestExists(directory: string, rootId: string, requiredText?: string) {
  const entries = await readdir(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  for (const name of entries) {
    const raw = await readFile(join(directory, name, 'request.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (!raw.endsWith('\n')) continue;
    const recorded = JSON.parse(raw);
    if (recorded.botId === rootId && (!requiredText || recorded.after?.input?.some(item => item.role === 'user' &&
      item.content?.some(part => part.type === 'input_text' && part.text.includes(requiredText))))) return true;
  }
  return false;
}

export async function runPastelExample(config: Parameters<typeof runSubagentsHarness>[0], signal?: AbortSignal) {
  let injected = false;
  let rootId: string | undefined;
  const report = await runSubagentsHarness({ ...config, goal: initial,
    collect: { paths: ['delivery'], required: true, includeGit: false, maxBytes: 2 * 1024 * 1024 },
  }, signal, async (env, work) => {
    rootId = env.rootId;
    const traces = join(config.outputDir, env.id, 'model-trace');
    for (;;) {
      work.throwIfAborted();
      if (env.lastReply()) throw new Error('Root finished before the in-flight input');
      if (await modelRequestExists(traces, env.rootId) &&
          (await env.status()).some(bot => bot.id === env.rootId && bot.status === 'running')) break;
      await delay(25, undefined, { signal: work });
    }
    const admission = await env.input(supplement, 'pastel-hsl');
    if (!admission || Array.isArray(admission) || typeof admission !== 'object' || admission.status !== 'accepted') {
      throw new Error('The HSL requirement was not confirmed');
    }
    injected = true;
    const reply = await env.waitForReply({ signal: work });
    if (reply.type !== 'settled' || reply.outcome !== 'completed') throw new Error('Root failed');
    return { rootId: env.rootId, eventSeq: reply.seq };
  });
  const root = report.cleanup?.bots?.find(bot => bot.botId === rootId);
  const files = root?.artifacts.find(path => path.endsWith('/artifacts/files'));
  let independentCheck;
  if (files && !report.cleanupFailure) {
    try { independentCheck = await checkPastelExample(join(files, 'delivery')); }
    catch (error) { independentCheck = { error: error instanceof Error ? error.message : String(error) }; }
  }
  const seenByRoot = rootId
    ? await modelRequestExists(join(config.outputDir, report.runtimeId, 'model-trace'), rootId, supplement)
    : false;
  return { report, injected, seenByRoot, independentCheck, assessment: {
    task: !report.businessFailure && seenByRoot && independentCheck && !('error' in independentCheck) ? 'passed' : 'failed',
    collaboration: { status: 'needs-trace-review', review: 'Check autonomous delegation, overlap and actual contribution adoption' },
    cleanup: report.cleanup?.cleanup === 'complete' && !report.cleanupFailure && !report.reportSaveFailure ? 'passed' : 'failed',
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , argument, value] = process.argv;
  if (!argument || (argument === '--check' && !value)) throw new Error('Usage: node subagents-example.ts <config.js> | --check <delivery>');
  if (argument === '--check') process.stdout.write(JSON.stringify(await checkPastelExample(value)) + '\n');
  else {
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const config = (await import(pathToFileURL(resolve(argument)).href)).default;
      const result = await runPastelExample(config, abort.signal);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = result.assessment.task === 'passed' && result.assessment.cleanup === 'passed' ? 2 : 1;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}
