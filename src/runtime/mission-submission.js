import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const required = (v, name) => { if (typeof v !== 'string' || !v) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} is required`); return v; };
const iso = () => new Date().toISOString();

/** Durable Mission final-submission coordinator.
 *
 * A submission snapshots the Workspace main revision and immutable Material
 * IDs before invoking a checker. Only one submission may freeze a Mission at
 * a time; a late result is recorded against its own submission and cannot
 * mutate a newer submission or accepted revision.
 */
export class MissionSubmissionStore {
  constructor({ file = null } = {}) { this.file = file ? resolve(file) : null; this.state = { missions: {} }; this.loaded = false; }
  async #load() { if (this.loaded) return; this.loaded = true; if (!this.file) return; try { this.state = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  async #save() { if (!this.file) return; await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(this.state, null, 2)); }
  async submit({ missionId, workspaceId, mainRevision, materialIds = [], checker, environment, acceptance = {}, actorRef, requestId = randomUUID() }) {
    await this.#load(); required(missionId, 'mission_id'); required(workspaceId, 'workspace_id'); required(mainRevision, 'main_revision'); required(actorRef, 'actor_ref');
    if (!Array.isArray(materialIds) || materialIds.some((id) => typeof id !== 'string' || !id)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must be non-empty strings');
    const current = this.state.missions[missionId] ?? { mission_id: missionId, state: 'open', active_submission_id: null, submissions: [] };
    if (current.state === 'accepted' || current.state === 'stopped') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission is no longer accepting submissions');
    if (current.active_submission_id) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Mission already has an active submission', { submission_id: current.active_submission_id });
    const submission = { submission_id: requestId, mission_id: missionId, workspace_id: workspaceId, main_revision: mainRevision, material_ids: [...new Set(materialIds)], checker: checker ?? null, environment: environment ?? null, acceptance, actor_ref: actorRef, state: 'pending', created_at: iso(), finished_at: null, result: null };
    current.active_submission_id = submission.submission_id; current.submissions.push(submission); current.updated_at = iso(); this.state.missions[missionId] = current; await this.#save(); return structuredClone(submission);
  }
  async finish({ missionId, submissionId, verdict, result = null }) {
    await this.#load(); const mission = this.state.missions[missionId]; if (!mission) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'unknown mission'); const submission = mission.submissions.find((item) => item.submission_id === submissionId); if (!submission) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'unknown submission');
    if (submission.state !== 'pending') return structuredClone(submission);
    submission.state = String(verdict).toLowerCase() === 'pass' ? 'accepted' : (String(verdict).toLowerCase() === 'timeout' ? 'timed_out' : 'failed'); submission.result = result; submission.finished_at = iso(); if (mission.active_submission_id === submissionId) mission.active_submission_id = null; if (submission.state === 'accepted') { mission.state = 'accepted'; mission.accepted_submission_id = submissionId; } mission.updated_at = iso(); await this.#save(); return structuredClone(submission);
  }
  async get({ missionId, submissionId = null }) { await this.#load(); const mission = this.state.missions[missionId]; if (!mission) return null; if (!submissionId) return structuredClone(mission); return structuredClone(mission.submissions.find((item) => item.submission_id === submissionId) ?? null); }
}
