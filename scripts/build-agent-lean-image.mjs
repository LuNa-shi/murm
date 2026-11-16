#!/usr/bin/env node
import { readFile, mkdtemp, writeFile, copyFile, rm, realpath, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const [agentImage, leanRootArg, projectArg, outputImage] = process.argv.slice(2);
if (!agentImage || !leanRootArg || !projectArg || !outputImage) {
  throw new Error('Usage: node scripts/build-agent-lean-image.mjs AGENT_IMAGE LEAN_ROOT LEAN_PROJECT OUTPUT_IMAGE');
}
const leanRoot = await realpath(leanRootArg);
const project = await realpath(projectArg);
const toolchain = (await readFile(join(project, 'lean-toolchain'), 'utf8')).trim();
const version = (await exec(join(leanRoot, 'bin/lean'), ['--version'], { timeout: 5000 })).stdout.trim();
if (!toolchain.endsWith(':v4.33.1') || !version.includes('version 4.33.1,') || !version.includes('819816b2e0a3bf405af45ae5c7af2491d8f5bee6')) {
  throw new Error('The diagnostic image currently supports the reviewed Lean 4.33.1 toolchain only');
}
const names = ['mathlib', 'batteries', 'Qq', 'aesop', 'proofwidgets', 'importGraph', 'LeanSearchClient', 'plausible'];
const manifest = JSON.parse(await readFile(join(project, 'lake-manifest.json'), 'utf8'));
const dependencies = [];
for (const name of names) {
  const pin = manifest.packages.find(entry => entry.name === name);
  const path = join(project, '.lake/packages', name);
  const actual = (await exec('git', ['-C', path, 'rev-parse', 'HEAD'], { timeout: 5000 })).stdout.trim();
  if (!pin || actual !== pin.rev || !(await stat(join(path, '.lake/build/lib/lean'))).isDirectory()) {
    throw new Error(`Missing or mismatched prebuilt dependency: ${name}`);
  }
  dependencies.push({ name, revision: actual });
}
if (dependencies.find(entry => entry.name === 'mathlib').revision !== '0df444a360eaa60ab8c11dca51a86af692955474') {
  throw new Error('The diagnostic image requires the reviewed Mathlib revision');
}
const base = JSON.parse((await exec('docker', ['image', 'inspect', agentImage], { timeout: 10000 })).stdout)[0];
const context = await mkdtemp(join(tmpdir(), 'swarmenv-lean-image-'));
try {
  for (const file of ['Dockerfile', 'lean']) await copyFile(new URL(`../services/opensandbox-agent/lean/${file}`, import.meta.url), join(context, file));
  await writeFile(join(context, 'environment.json'), JSON.stringify({ role: 'local-diagnostics', trusted_mission_verdict: false,
    base_image_id: base.Id, lean: version, dependencies, writable_project_required: true,
    automatic_downloads: false, package_rebuilds: false }, null, 2) + '\n');
  const child = spawn('docker', ['build', '--build-arg', `AGENT_IMAGE=${agentImage}`,
    '--build-context', `lean-toolchain=${leanRoot}`, '--build-context', `lean-packages=${join(project, '.lake/packages')}`,
    '-t', outputImage, resolve(context)], { stdio: 'inherit' });
  const status = await new Promise((resolveStatus, reject) => { child.once('error', reject); child.once('exit', resolveStatus); });
  if (status !== 0) throw new Error(`Lean diagnostic image build failed (${status})`);
} finally { await rm(context, { recursive: true, force: true }); }
