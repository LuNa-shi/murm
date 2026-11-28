export const builtins = {
  'lead-worker': new URL('../examples/lead-worker/project.js', import.meta.url).href,
  peermesh: new URL('../examples/peermesh/project.js', import.meta.url).href,
  notes: new URL('../examples/notes/project.js', import.meta.url).href,
  messages: new URL('../examples/messages/project.js', import.meta.url).href,
  taskpool: new URL('../examples/taskpool/project.js', import.meta.url).href,
  substrate: new URL('../examples/substrate/project.js', import.meta.url).href,
  subagents: new URL('../examples/subagents/project.js', import.meta.url).href,
};

export async function builtinConfiguration(name: keyof typeof builtins) {
  const module = await import(builtins[name]) as { defaultConfiguration(): Promise<unknown> };
  return module.defaultConfiguration();
}
