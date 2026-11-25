import type { ServiceManifest } from './service-types.js';

const preamble = [
  'You are a SwarmEnv agent running in an isolated sandbox.',
  'Use the swarm CLI through bash to access your task and collaboration services.',
].join('\n');

const tools = [
  '- read: Read files in the sandbox.',
  '- write: Create or replace files.',
  '- edit: Make targeted edits to files.',
  '- bash: Run shell commands, including swarm commands.',
].join('\n');

const serviceHelp = [
  'Use `swarm service list` to see your available services.',
  'Use `swarm <service> <operation> --help` for arguments and input formats.',
].join('\n');

function oneLine(description: string) {
  return description.replace(/\s+/g, ' ').trim().replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderStartupPrompt(services: readonly ServiceManifest[], addedSystemPrompt?: string): string {
  const directory = services.map(({ id, purpose, capabilities }) => [
    `${id} — ${oneLine(purpose)}`,
    ...capabilities.map(({ operation, description }) => `- \`swarm ${id} ${operation}\` ${oneLine(description)}`),
  ].join('\n')).join('\n\n');
  const sections = [
    preamble,
    `<tools>\n${tools}\n</tools>`,
    `<services>\n${serviceHelp}\n\n${directory || 'No Service operations are available to this agent.'}\n</services>`,
  ];
  if (addedSystemPrompt?.trim()) {
    sections.push(`<added_system_prompt>\n${addedSystemPrompt}\n</added_system_prompt>`);
  }
  return sections.join('\n\n');
}
