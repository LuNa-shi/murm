import { createSubagentsController } from './controller.mjs';

/** Read the hour result without changing the settled text used for routing and adoption. */
export function readSubagentsStageResult(output) {
  let payload = output.trim();
  let value;
  try { value = JSON.parse(payload); }
  catch (error) {
    const finalLine = payload.lastIndexOf('\n');
    if (finalLine < 0 || /^[ \t]*(?:`{3,}|~{3,})/m.test(payload.slice(0, finalLine))) throw error;
    payload = payload.slice(finalLine + 1).trimStart();
    value = JSON.parse(payload);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Stage result must be a JSON object');
  return { payload, value };
}

/** Optional four-group text adoption gate. The caller owns Runtime lifetime and close. */
export async function createSubagentsStages(runtime, parentId, { childIds } = {}) {
  if (!Array.isArray(childIds) || childIds.length !== 3 || childIds.some(id => typeof id !== 'string' || !id || id === parentId) || new Set(childIds).size !== 3) throw new TypeError('Stages require three original child identities');
  const ids = [...childIds];
  for (const id of [parentId, ...ids]) {
    const bot = await runtime.get(id);
    if (bot.id !== id || !['idle', 'running'].includes(bot.status) || id !== parentId && bot.parentId !== parentId) throw new TypeError('Stages require live direct children of the original parent');
  }
  const controller = createSubagentsController(runtime, parentId, { maxChildren: 3 });
  const stages = []; const history = []; let active = false; let closed = false; let lastParentSeq = 0;
  const fail = code => Object.assign(new Error(code), { code });
  return Object.freeze({
    runStage({ stage, input, expected, verify, timeoutMs, signal } = {}) {
      if (closed || active || stage !== stages.length || !Number.isInteger(stage) || stage < 0 || stage > 3 || typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 64 * 1024 || (expected === undefined ? typeof verify !== 'function' : verify !== undefined || !Array.isArray(expected) || expected.length !== 3 || expected.some(value => typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096) || new Set([...history.map(row => row.quote), ...expected]).size !== history.length + 3) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Stage requires ordered finite work and frozen outputs or a verifier');
      const outputs = expected && [...expected]; const deadline = performance.now() + timeoutMs; const requestId = `stage-${stage}`;
      active = true;
      return (async () => {
        const waiting = new AbortController();
        const waitSignal = signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal;
        let adopted;
        const completed = controller.waitForFinal({ timeoutMs, signal: waitSignal, accept(event, deliveries) {
          if (event.seq <= lastParentSeq) return false;
          const user = deliveries.find(row => row.kind === 'user' && row.requestId === requestId && row.receipt?.status === 'accepted' && typeof row.receipt.inputId === 'string');
          if (!user) return false;
          let final;
          try { final = verify ? readSubagentsStageResult(event.output).value : JSON.parse(event.output); } catch { return false; }
          if (final?.stage !== stage || typeof final.summary !== 'string' || !final.summary.trim() || !Array.isArray(final.conclusions) || final.conclusions.length !== history.length + 3) return false;
          const remaining = [...final.conclusions];
          // Every historical identity and byte string must survive unchanged exactly once.
          for (const old of history) {
            const index = remaining.findIndex(row => row.childId === old.childId && row.eventSeq === old.eventSeq && row.quote === old.quote);
            if (index < 0) return false;
            remaining.splice(index, 1);
          }
          const current = [];
          for (const [index, childId] of ids.entries()) {
            const references = remaining.filter(row => row.childId === childId);
            if (references.length !== 1) return false;
            const reference = references[0];
            const previous = history.filter(row => row.childId === childId).at(-1)?.eventSeq ?? 0;
            if (!Number.isSafeInteger(reference.eventSeq) || reference.eventSeq <= previous || (outputs && reference.quote !== outputs[index])) return false;
            const delivery = deliveries.find(row => row.kind === 'child' && row.result.childId === childId && row.result.eventSeq === reference.eventSeq && row.result.outcome === 'completed' && row.result.output === reference.quote && row.eventOrder > user.dispatchOrder && row.receipt?.status === 'accepted' && typeof row.receipt.inputId === 'string');
            if (!delivery) return false;
            current.push(delivery);
          }
          adopted = { stage, parent: { botId: parentId, requestId, receipt: user.receipt, settled: event }, children: current, conclusions: [...history, ...current.map(row => ({ childId: row.result.childId, eventSeq: row.result.eventSeq, quote: row.result.output }))] };
          return true;
        } });
        completed.catch(() => {});
        try {
          const submission = controller.submitUser(input, { requestId }).then(entry => {
            if (entry.state !== 'accepted') throw fail('INPUT_UNKNOWN');
            return completed;
          });
          await Promise.race([completed, submission]);
          if (verify) {
            let timer, aborted;
            try {
              const remaining = deadline - performance.now();
              if (remaining <= 0) throw fail('WORK_DEADLINE');
              await Promise.race([
                (async () => {
                  for (const [index, row] of adopted.children.entries()) {
                    if (await verify({ stage, index, childId: row.result.childId, output: row.result.output, eventSeq: row.result.eventSeq, signal: waitSignal }) !== true) throw fail('STAGE_RESULT_INVALID');
                  }
                })(),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(fail('WORK_DEADLINE')), remaining);
                  aborted = () => reject(fail('WORK_ABORTED'));
                  waitSignal.addEventListener('abort', aborted, { once: true });
                  if (waitSignal.aborted) aborted();
                }),
              ]);
            } finally { clearTimeout(timer); if (aborted) waitSignal.removeEventListener('abort', aborted); }
          }
          lastParentSeq = adopted.parent.settled.seq;
          history.splice(0, history.length, ...adopted.conclusions);
          stages.push(structuredClone(adopted));
          return structuredClone(adopted);
        } catch (error) {
          closed = true; controller.stop(); throw error;
        } finally { active = false; waiting.abort(); }
      })();
    },
    drain: controller.drain,
    stop() { closed = true; controller.stop(); },
    dispose() { closed = true; controller.dispose(); },
    report: () => ({ ...controller.report(), stages: structuredClone(stages) }),
  });
}
