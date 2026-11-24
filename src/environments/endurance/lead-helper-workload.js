import { createHash } from 'node:crypto';
import { httpClient } from '../agensh/http.js';
import { createProgrammingContract } from './programming.js';
const roles = Object.freeze(['helper1', 'helper2', 'helper3']);
const invalid = () => Object.assign(new Error('HOUR_LEAD_PROGRAM_INVALID'), { code: 'HOUR_LEAD_PROGRAM_INVALID' });
const requireEvidence = value => { if (!value) throw invalid(); };
const hash = value => createHash('sha256').update(value).digest('hex');
const e = encodeURIComponent;

/** Host-only readback of actual public Git objects. Programming correctness is
 * checked by the frozen external verifier; Bot source is never run by the host. */
export function createLeadHelperProgrammingWorkload({ getFacilities, adminToken, programming }) {
  if (typeof getFacilities !== 'function' || typeof adminToken !== 'string' || !adminToken || !programming) throw new TypeError('Lead programming workload requires actual owned Git facilities and an external task verifier');
  const program = createProgrammingContract(programming);
  let facilities, git, scope, team, nextStage = 0;
  const verified = [];
  function initialize(environment) {
    if (!facilities) {
      facilities = structuredClone(getFacilities());
      requireEvidence(facilities?.repository && facilities.origin && Object.keys(facilities.actors ?? {}).sort().join() === 'helper1,helper2,helper3,lead');
      git = httpClient(facilities.origin, `token ${adminToken}`);
      scope = `/api/v1/repos/${e(facilities.repository.owner)}/${e(facilities.repository.name)}`;
      team = structuredClone(environment.team);
    }
    requireEvidence(JSON.stringify(environment.team) === JSON.stringify(team) && environment.runId === facilities.runId);
  }
  function stageInput(stage) {
    const paths = Object.fromEntries(roles.map(role => [role, `hour-${role}-${stage}.json`]));
    const tasks = Object.fromEntries(roles.map((role, index) => [role,
      `Write only ${paths[role]} for this group's delivery. Its JSON must have exactly helper:${JSON.stringify(role)}, stage:${stage}, directionId (the current Board direction sequence), direction (its exact current text), and programming (the requested result). Read Board before claiming. Implement and run the task, retain its program and stdout files. Stage only the delivery with git add -- ${paths[role]} and check that it is the only staged path before committing and pushing. Leave program source, stdout and test files untracked for private collection. Then publish complete proof for the actual pushed JSON file and one task-scoped feedback note. Use one coherent Bash call for read/claim/program/test/Git/publish; finish briefly.${program.prompt(index, stage + 1)}`]));
    if (Object.values(tasks).some(text => Buffer.byteLength(text) > 4096)) throw invalid();
    const text = `LEAD_HELPER_STAGE_${stage}: Create exactly one new ready subtask for each supplied helper path. ${stage ? 'Read and cite exactly the prior three task feedback notes and this registered user supplement.' : 'Create an assignment for each trusted helper identity before work.'} Announce a new short single-line ASCII direction using letters, digits and spaces only; include stage ${stage}. Helpers receive their own frozen programming task directly from the host. Keep all existing owners, history and deliveries. Do not solve their programs or change main.`;
    return { ...(stage ? { supplement: text } : { goal: text }), paths, tasks };
  }
  async function read(task, direction, stage, signal, currentHead) {
    const role = roles.find(role => team[role] === task.owner);
    requireEvidence(role && new RegExp(`^hour-${role}-${stage}(?:-correction-[1-9][0-9]*)?\\.json$`).test(task.path) && task.directionId === direction.seq && task.delivery?.verified);
    const actor = facilities.actors[role];
    requireEvidence(task.delivery.branch === actor.branch && task.delivery.accountId === actor.accountId);
    if (currentHead) {
      const branch = await git('GET', `${scope}/branches/${e(actor.branch)}`, undefined, { signal });
      requireEvidence(branch?.commit?.id === task.delivery.commit);
    }
    const file = await git('GET', `${scope}/contents/${task.path}?ref=${task.delivery.commit}`, undefined, { signal });
    requireEvidence(file?.type === 'file' && file.path === task.path && file.encoding === 'base64' && typeof file.content === 'string' && file.content.length <= 16384);
    const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
    requireEvidence(bytes.length <= 8192 && bytes.length === file.size && bytes.length === task.delivery.bytes && hash(bytes) === task.delivery.sha256);
    let value; try { value = JSON.parse(bytes); } catch { throw invalid(); }
    requireEvidence(value && Object.keys(value).sort().join() === 'direction,directionId,helper,programming,stage' &&
      value.helper === role && value.stage === stage && value.directionId === direction.seq && value.direction === direction.text);
    try { await program.verify(roles.indexOf(role), stage + 1, value); }
    catch (error) {
      if (error.code === 'HOUR_PROGRAMMING_INVALID' && error.rejected === true) error.programming = structuredClone(value.programming);
      throw error;
    }
    return { role, stage, commit: task.delivery.commit, path: task.path, sha256: task.delivery.sha256 };
  }
  async function readRejected(rejected, direction, stage, signal) {
    requireEvidence(rejected.code === 'HOUR_PROGRAMMING_INVALID' && rejected.stage === stage &&
      rejected.reference === `${rejected.task.delivery.commit}:${rejected.task.path}` && rejected.sha256 === rejected.task.delivery.sha256 &&
      rejected.input.botId === rejected.task.owner && rejected.input.state === 'completed' &&
      rejected.input.receipt?.status === 'accepted' && rejected.input.receipt.disposition === 'started' &&
      rejected.input.settled?.outcome === 'completed');
    try { await read(rejected.task, direction, stage, signal, false); }
    catch (error) {
      if (error.code === 'HOUR_PROGRAMMING_INVALID' && error.rejected === true && JSON.stringify(error.programming) === JSON.stringify(rejected.programming)) return;
      throw error;
    }
    throw invalid();
  }
  return Object.freeze({
    stages: Object.freeze(Array.from({ length: 4 }, (_, stage) => stageInput(stage))),
    async verifyCandidate(task, { environment, direction, stage, signal }) {
      initialize(environment);
      requireEvidence(stage === nextStage);
      try { await read(task, direction, stage, signal, true); return true; }
      catch (error) {
        if (error.code !== 'HOUR_PROGRAMMING_INVALID' || error.rejected !== true) throw error;
        return { correction: `The independent checker rejected this programming result. No reference answer is supplied. Recheck the original task and every case, inspect your program and actual stdout, and fix the cause. Preserve the rejected source/stdout under distinct rejected-attempt filenames before editing; retain final corrected source/stdout at the canonical filenames. Stage only the new assigned JSON file and check it is the only staged path before committing and pushing.`,
          rejected: { code: error.code, programming: error.programming, reference: `${task.delivery.commit}:${task.path}`, sha256: task.delivery.sha256 } };
      }
    },
    async verify(receipt, { environment, signal }) {
      requireEvidence(receipt?.stage === nextStage && nextStage < 4 && receipt.deliveries?.length === 3);
      initialize(environment);
      requireEvidence(JSON.stringify(environment.team) === JSON.stringify(team) && environment.runId === facilities.runId &&
        new Set(receipt.deliveries.map(row => row.owner)).size === 3);
      const reads = await Promise.all(receipt.deliveries.map(task => read(task, receipt.direction, receipt.stage, signal, true)));
      for (const rejection of receipt.rejected ?? []) await readRejected(rejection, receipt.direction, receipt.stage, signal);
      verified.push({ stage: receipt.stage, direction: structuredClone(receipt.direction), deliveries: structuredClone(receipt.deliveries), rejected: structuredClone(receipt.rejected ?? []), reads });
      if (receipt.stage === 3) {
        requireEvidence(receipt.pinnedDeliveries?.length === 12);
        for (const prior of verified) {
          await Promise.all(prior.deliveries.map(task => read(task, prior.direction, prior.stage, signal, false)));
          for (const rejection of prior.rejected) await readRejected(rejection, prior.direction, prior.stage, signal);
        }
      }
      nextStage++;
      return true;
    },
  });
}
