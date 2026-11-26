import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const invalid = () => Object.assign(new Error('Ordered host checkpoints do not establish the scaleMAS collaboration handoff'), { code: 'COLLABORATION_EVIDENCE_INVALID' });
const requireEvidence = (condition: any) => { if (!condition) throw invalid(); };
const digest = (content: any) => createHash('sha256').update(content).digest('hex');

/** Host-only check of Environment §7.5 handoff evidence. Checkpoints must be
 * captured by the trusted host in argument order, after awaiting publisherStop
 * and before publishing the successor. Snapshots contain no stop/publication
 * clock; this function cannot authenticate caller-supplied chronology.
 * Does not alter runSubstrate business completion or evaluate all §7.5 clauses. */
export function verifySubstrateCollaboration({ publisherStop, afterStop, beforeSuccessor, finalSnapshot,
  consumerId, originalAddress, successorAddress }: any = {}) {
  requireEvidence(publisherStop?.execution === 'stopped' && ['complete', 'pending'].includes(publisherStop.cleanup) &&
    typeof publisherStop.agentId === 'string' && publisherStop.agentId && typeof consumerId === 'string' && consumerId &&
    consumerId !== publisherStop.agentId && typeof originalAddress === 'string' && typeof successorAddress === 'string' && originalAddress !== successorAddress);
  const snapshots = [afterStop, beforeSuccessor, finalSnapshot];
  for (const snapshot of snapshots) {
    requireEvidence(typeof snapshot?.runId === 'string' && snapshot.runId && typeof snapshot.runtimeId === 'string' && snapshot.runtimeId &&
      snapshot.runId === afterStop.runId && snapshot.runtimeId === afterStop.runtimeId &&
      Array.isArray(snapshot.contents) && Array.isArray(snapshot.reads));
    requireEvidence(snapshot.contents.every((row: any) => row && typeof row.address === 'string' && typeof row.author === 'string' &&
      row.version === 1 && typeof row.content === 'string' && Array.isArray(row.references)));
    requireEvidence(new Set(snapshot.contents.map((row: any) => row.address)).size === snapshot.contents.length);
  }
  for (let index = 1; index < snapshots.length; index++) {
    const previous = snapshots[index - 1], next = snapshots[index];
    requireEvidence(next.reads.length >= previous.reads.length &&
      isDeepStrictEqual(next.reads.slice(0, previous.reads.length), previous.reads));
    for (const record of previous.contents) requireEvidence(isDeepStrictEqual(next.contents.find((row: any) => row.address === record.address), record));
  }
  const original = afterStop.contents.find((row: any) => row.address === originalAddress);
  const successor = finalSnapshot.contents.find((row: any) => row.address === successorAddress);
  requireEvidence(original?.author === publisherStop.agentId && successor?.author === consumerId &&
    successor.references.includes(originalAddress) && !beforeSuccessor.contents.some((row: any) => row.address === successorAddress));
  const reads = beforeSuccessor.reads;
  const searchReadIndex = reads.findIndex((row: any, index: any) => index >= afterStop.reads.length && row?.author === consumerId &&
    row.operation === 'search' && Array.isArray(row.result) && row.result.some((result: any) => result?.address === originalAddress));
  const visitReadIndex = reads.findIndex((row: any, index: any) => index > searchReadIndex && index >= afterStop.reads.length && row?.author === consumerId &&
    row.operation === 'visit' && row.input?.address === originalAddress && Array.isArray(row.result) && row.result.includes(originalAddress));
  requireEvidence(searchReadIndex >= 0 && visitReadIndex > searchReadIndex);
  return Object.freeze({ accepted: true, scope: 'durable-collaboration-handoff', runId: afterStop.runId, runtimeId: afterStop.runtimeId,
    publisherId: publisherStop.agentId, consumerId, publisherExecution: 'stopped', publisherCleanup: publisherStop.cleanup,
    originalAddress, originalSha256: digest(original.content), successorAddress, successorSha256: digest(successor.content), searchReadIndex, visitReadIndex });
}
