async function bounded(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Controlled cleanup observation deadline')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Every Runtime starts closing concurrently; one failure cannot suppress another's cleanup or receipt.
export async function cleanupRuntimes(runtimes, { inspect, resources, timeoutMs = 30_000 }) {
  return Promise.all(runtimes.map(async runtime => {
    const deadlineAt = Date.now() + timeoutMs;
    const row = { runtimeId: runtime.id, cleanup: 'pending', agents: [] };
    const resource = resources[runtime.id] ??= {};
    try {
      const closeMs = Math.max(1, timeoutMs - Math.min(5000, timeoutMs / 2));
      const receipt = await bounded(() => runtime.close({ timeoutMs: closeMs }), closeMs);
      row.cleanup = receipt.cleanup;
      row.agents = receipt.agents.map(agent => ({ agentId: agent.agentId, execution: agent.execution, cleanup: agent.cleanup }));
    } catch { row.cleanup = 'pending'; row.error = 'CLOSE_FAILED'; }
    try {
      resource.empty = (await bounded(() => inspect(runtime.id), Math.max(1, deadlineAt - Date.now()))).length === 0;
    } catch { resource.empty = false; resource.error = 'RESOURCE_INSPECTION_FAILED'; }
    return row;
  }));
}
