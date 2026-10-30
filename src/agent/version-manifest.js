import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SwarmEnvError, ERROR_CODES } from '../errors.js';

const execFileAsync = promisify(execFile);
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

function exactVersion(value, field) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} must be an exact semantic version`, { value });
  }
  return value;
}

export async function resolveNpmLatestVersion({ packageName = PI_PACKAGE, runner = execFileAsync } = {}) {
  const { stdout } = await runner('npm', ['view', packageName, 'version', '--json'], { encoding: 'utf8' });
  const value = String(stdout).trim().replace(/^"|"$/g, '');
  return exactVersion(value, `${packageName} latest version`);
}

export async function resolveCommandVersion(command, { runner = execFileAsync } = {}) {
  const { stdout } = await runner(command, ['--version'], { encoding: 'utf8' });
  const match = String(stdout).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  if (!match) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `could not parse ${command} version`, { stdout });
  return match[0];
}

export async function createVersionManifest({
  piVersion,
  nurouterVersion,
  nodeVersion = process.versions.node,
  launchArgs,
  resolver = {},
} = {}) {
  // Resolve the installed executable by default. Looking up the npm latest
  // tag makes every Agent startup depend on registry connectivity and can
  // record a version that is different from the binary actually launched.
  // `resolveNpmLatestVersion` remains available for an explicit catalog check,
  // but it is not part of the runtime startup path.
  const resolvedPi = exactVersion(piVersion ?? await resolveCommandVersion('pi', resolver), 'pi_version');
  const resolvedNuRouter = exactVersion(nurouterVersion ?? await resolveCommandVersion('nurouter', resolver), 'nurouter_version');
  const resolvedNode = exactVersion(nodeVersion, 'node_version');
  if (!Array.isArray(launchArgs) || launchArgs.length === 0) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'launch_args must be a non-empty array');
  }
  return Object.freeze({
    pi_package: PI_PACKAGE,
    pi_version: resolvedPi,
    nurouter_version: resolvedNuRouter,
    node_version: resolvedNode,
    launch_args: [...launchArgs],
    created_at: new Date().toISOString(),
  });
}
