import { createRuntime } from '../../dist/src/core/index.js';
import { ServiceRegistry, type ServiceRegistration } from '../../dist/src/core/services.js';
import { createSubagentsController } from '../../dist/test-support/subagents/communication-fixture-controller.js';
import { sha256 } from './case.ts';
import { checkpointSource } from './source-checkpoint.ts';

const parentInstructions = `Spawn two child Bots with complementary Pastel work using swarm bot spawn.
Ask each child for a useful source file and a reference observation. Child results are delivered as JSON with childId, eventSeq, outcome and output.
Use the actual child results to write a source tree, test it with compile.sh and publish checkpoints using swarm candidate publish --stdin.
The payload is {"files":{"relative-path":"UTF-8 source text"},"used_children":[{"child_id":"actual UUID","event_seq":1,"file":"relative-path"}]}.
For each included child, preserve at least one whole source file it supplied, or explain your changes in your output. Keep extending the candidate within the available window.`;
const childInstructions = `Work on the assigned Pastel component. Follow the provided task and return plain JSON with this shape:
{"files":{"relative-path":"UTF-8 source text"},"observation":"reference command and result"}. Include a source file the parent can use directly.`;

function decodeChild(text) {
  try {
    const trimmed = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/, '').replace(/\s*\x60\x60\x60$/, '');
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function publishService(publish: ServiceRegistration['adapter']['invoke']): ServiceRegistration {
  return { manifest: { id: 'candidate', title: 'Pastel candidate', purpose: 'Freeze candidate source during the run.',
    endpoint: { transport: 'in-process' }, contract_version: '2', provider_version: '1',
    capabilities: [{ name: 'publish', operation: 'publish', description: 'Publish a buildable source tree and child references.',
      side_effect: 'write', idempotent: true, help: { when: 'After writing a runnable candidate or integrating child work.' }, errors: [],
      input_schema: { type: 'object', required: ['files'], additionalProperties: false,
        properties: { files: { type: 'object', minProperties: 1, maxProperties: 256,
          additionalProperties: { type: 'string', maxLength: 131_072 } },
        used_children: { type: 'array', maxItems: 2, items: {
          type: 'object', required: ['child_id', 'event_seq', 'file'], additionalProperties: false,
          properties: { child_id: { type: 'string', maxLength: 128 }, event_seq: { type: 'integer', minimum: 0 },
            file: { type: 'string', maxLength: 512 } },
        } } } },
      output_schema: { type: 'object', required: ['sha256', 'verified_children'], additionalProperties: false,
        properties: { sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          verified_children: { type: 'integer', minimum: 0, maximum: 2 } } } }] },
    adapter: { invoke: publish } };
}

export async function runOpenSubagents({ state, task, window, start, deadline, image, backend, outputDir, capacity }) {
  if (capacity < 3) throw new Error('Subagents requires one parent and two child slots');
  const services = new ServiceRegistry();
  const operations = new Map();
  let runtime, parent, controller;
  services.registerService(publishService(({ caller, envelope, input, assertAuthorized }) => {
    if (caller.botId !== parent.id) throw new Error('Candidate publication requires the parent Bot');
    // The Bridge checks this shape against the publish schema before calling the adapter.
    const submission = input as {
      files: Record<string, string>;
      used_children?: { child_id: string; event_seq: number; file: string }[];
    };
    const fingerprint = sha256(JSON.stringify(input));
    const prior = operations.get(envelope.operation_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Candidate operation payload changed');
      return prior.work;
    }
    const work = (async () => {
      const deliveries = controller.report().deliveries.filter(row => row.kind === 'child' && row.state === 'accepted');
      const adopted = new Map();
      for (const child of submission.used_children ?? []) {
        const source = deliveries.find(row => row.result.childId === child.child_id &&
          row.result.eventSeq === child.event_seq && row.result.outcome === 'completed');
        const content = decodeChild(source?.result.output)?.files;
        if (!content || !Object.hasOwn(content, child.file) || typeof content[child.file] !== 'string' ||
            !Object.hasOwn(submission.files, child.file) || submission.files[child.file] !== content[child.file]) continue;
        adopted.set(child.child_id, { botId: child.child_id, eventSeq: child.event_seq,
          parentInputId: source.receipt.inputId, file: child.file, sha256: sha256(content[child.file]) });
      }
      const checkpoint = await checkpointSource({ window, outputDir, files: submission.files, assertAuthorized,
        sourceRevision: `parent:${parent.id}:${sha256(envelope.operation_id)}` });
      const evidence = { candidateSha256: checkpoint.sha256, by: parent.id, adopted: [...adopted.values()] };
      state.evidence.push(evidence);
      return { sha256: checkpoint.sha256, verified_children: evidence.adopted.length };
    })();
    operations.set(envelope.operation_id, { fingerprint, work });
    return work;
  }));
  try {
    state.stage = 'subagents-startup';
    const common = { image, writable: true, model: 'default' };
    runtime = await createRuntime({ backend, outputDir, maxBots: capacity, services, profiles: {
      parent: { ...common, prompt: parentInstructions, services: { bot: ['spawn', 'get', 'send', 'stop'], candidate: ['publish'] }, spawnProfiles: ['child'] },
      child: { ...common, prompt: `${task}\n\n${childInstructions}`, services: {} },
    } });
    state.runtimeId = runtime.id;
    parent = await runtime.spawn({ profile: 'parent', requestId: 'pastel-parent' });
    state.parentId = parent.id;
    controller = createSubagentsController({ get: runtime.get, send: runtime.send, onEvent(listener) {
      return runtime.onEvent(event => {
        if (event.type === 'settled' || event.type === 'exit' || (event.type === 'error' && event.fatal)) listener(event);
      });
    } }, parent.id);
    state.stage = 'subagents-work';
    start();
    const dispatch = await controller.submitUser(`${task}\n\n${parentInstructions}`, { requestId: 'pastel-open-task' });
    if (dispatch.state !== 'accepted') throw new Error('Parent task admission failed');
    state.initialInputId = dispatch.receipt.inputId;
    await deadline;
  } finally {
    if (runtime) {
      controller?.stop();
      state.cleanup = (await runtime.close({ timeoutMs: 35_000 })).cleanup;
      await controller?.drain();
      const report = controller?.report();
      if (report) {
        state.childIds = report.childIds;
        state.routingErrors = report.errors;
      }
      controller?.dispose();
    }
  }
}
