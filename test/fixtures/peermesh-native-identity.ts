import { AGENT_UID, PROJECT_DIR } from '../../scripts/sandbox-project.js';

const codes = new Set([
  'LIVE_IDENTITY_INVALID_OPTIONS', 'LIVE_IDENTITY_OBSERVER_UID',
  'LIVE_IDENTITY_PROC_UNREADABLE', 'LIVE_IDENTITY_COUNT',
  'LIVE_IDENTITY_CWD', 'LIVE_IDENTITY_START', 'LIVE_IDENTITY_GIT',
  'LIVE_IDENTITY_BRANCH', 'LIVE_IDENTITY_COMMAND_FAILED', 'LIVE_IDENTITY_RESPONSE',
]);

// Fixed host-controlled code. Only finite diagnostics and selected identity fields
// leave the observer. Same-UID inspection needs no CAP_SYS_PTRACE or Git override.
export const nativeIdentityProgram = `
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [uidText, cwd, branchesText] = process.argv.slice(1);
const fail = code => { throw Object.assign(new Error(code), { code }); };
try {
  const uid = Number(uidText), branches = JSON.parse(branchesText);
  if (!Number.isSafeInteger(uid) || uid < 0 || typeof cwd !== 'string' || !cwd.startsWith('/') ||
      !Array.isArray(branches) || !branches.length || branches.some(branch => typeof branch !== 'string' || !branch)) fail('LIVE_IDENTITY_INVALID_OPTIONS');
  if (process.getuid() !== uid) fail('LIVE_IDENTITY_OBSERVER_UID');
  const peers = [];
  for (const name of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    let status;
    try { status = readFileSync('/proc/' + name + '/status', 'utf8'); }
    catch { continue; }
    const owner = /^Uid:\\s+(\\d+)\\s+(\\d+)/m.exec(status);
    if (!owner || Number(owner[1]) !== uid || Number(owner[2]) !== uid || /^State:\\s+[ZX]/m.test(status)) continue;
    let raw;
    try { raw = readFileSync('/proc/' + name + '/stat', 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; fail('LIVE_IDENTITY_PROC_UNREADABLE'); }
    const end = raw.lastIndexOf(')'), comm = raw.slice(raw.indexOf('(') + 1, end);
    if (!['pi', 'pi-rpc'].includes(comm)) continue;
    const fields = raw.slice(end + 2).split(' '), start = fields[19];
    if (!/^[1-9][0-9]*$/.test(start)) fail('LIVE_IDENTITY_START');
    let actualCwd;
    try { actualCwd = readlinkSync('/proc/' + name + '/cwd'); }
    catch { fail('LIVE_IDENTITY_PROC_UNREADABLE'); }
    if (actualCwd !== cwd) fail('LIVE_IDENTITY_CWD');
    peers.push({ pid: Number(name), start, cwd: actualCwd });
  }
  if (peers.length !== 1) fail('LIVE_IDENTITY_COUNT');
  let branch;
  try { branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000, maxBuffer: 512, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { fail('LIVE_IDENTITY_GIT'); }
  if (!branches.includes(branch)) fail('LIVE_IDENTITY_BRANCH');
  process.stdout.write(JSON.stringify({ ok: true, identity: { ...peers[0], branch } }));
} catch (error) {
  const code = /^LIVE_IDENTITY_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'LIVE_IDENTITY_RESPONSE';
  process.stdout.write(JSON.stringify({ ok: false, code }));
}
`;

export async function observeNativeIdentity(container, execute, { stage, branches }) {
  const failed = (code, error) => {
    const diagnostic = { stage, code, timeout: error?.killed === true };
    if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255) diagnostic.exitStatus = error.code;
    return Object.assign(new Error(code), { code, identityDiagnostic: diagnostic });
  };
  if (!['identity-initial', 'identity-final'].includes(stage) || !Array.isArray(branches) || !branches.length || branches.some(branch => typeof branch !== 'string' || !branch)) {
    throw failed('LIVE_IDENTITY_INVALID_OPTIONS');
  }
  let result;
  try {
    result = await execute('docker', ['exec', '--user', `${AGENT_UID}:${AGENT_UID}`, container,
      'node', '--input-type=module', '-e', nativeIdentityProgram, String(AGENT_UID), PROJECT_DIR, JSON.stringify(branches)]);
  } catch (error) { throw failed('LIVE_IDENTITY_COMMAND_FAILED', error); }
  let observed;
  try {
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 4096) throw new Error();
    observed = JSON.parse(result.stdout);
  } catch { throw failed('LIVE_IDENTITY_RESPONSE'); }
  if (observed?.ok !== true) throw failed(codes.has(observed?.code) ? observed.code : 'LIVE_IDENTITY_RESPONSE');
  const identity = observed.identity;
  if (!identity || Object.keys(identity).sort().join(',') !== 'branch,cwd,pid,start' || !Number.isSafeInteger(identity.pid) || identity.pid < 1 ||
      typeof identity.start !== 'string' || !/^[1-9][0-9]*$/.test(identity.start) || identity.cwd !== PROJECT_DIR || !branches.includes(identity.branch)) {
    throw failed('LIVE_IDENTITY_RESPONSE');
  }
  return identity;
}
