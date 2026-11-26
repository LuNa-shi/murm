import type { ServiceManifest } from './service-types.js';
import { serviceCommand } from '../cli/service-command.js';

const preamble = [
  'You are a murm agent running in an isolated sandbox.',
  'Use the swarm CLI through bash to access your task and collaboration services.',
].join('\n');

const piTools = [
  '- read: Read files in the sandbox.',
  '- write: Create or replace files where you have write access.',
  '- edit: Make targeted changes to files where you have write access.',
  '- bash: Run shell commands, including swarm commands.',
].join('\n');

const codexTools = [
  '- exec_command: Run shell commands, including swarm commands, in the sandbox.',
  '- write_stdin: Continue a command session when exec_command returns its session ID.',
].join('\n');

const serviceHelp = [
  'Use `swarm service list` to see your available services.',
  'Add `--help` to an operation command for arguments and input formats.',
  'Some operations require an active execution or other authorization. Check the operation help.',
].join('\n');

function oneLine(description: string) {
  return description.replace(/\s+/g, ' ').trim().replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderStartupPrompt(services: readonly ServiceManifest[], addedSystemPrompt?: string, executor: 'pi' | 'codex' = 'pi'): string {
  const directory = services.map(({ id, purpose, capabilities }) => [
    `${id === 'context' ? 'context (CLI: material)' : id} — ${oneLine(purpose)}`,
    ...capabilities.map(({ operation, description }) => `- \`${serviceCommand(id, operation)}\` ${oneLine(description)}`),
  ].join('\n')).join('\n\n');
  const tools = executor === 'codex' ? codexTools : piTools;
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
