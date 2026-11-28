import type { ServiceManifest } from './service-types.js';

const preamble = [
  'You are a murm agent running in an isolated sandbox.',
  'Use the swarm CLI through bash to access the services granted to this Agent.',
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

export function renderStartupPrompt(services: readonly ServiceManifest[], addedSystemPrompt?: string, executor: string = 'pi', enabledTools?: readonly string[]): string {
  const directory = services.map(({ id, purpose, capabilities }) => [
    `${id} — ${oneLine(purpose)}`,
    ...capabilities.map(({ operation, description }) => `- \`swarm service invoke ${id} ${operation}\` ${oneLine(description)}`),
  ].join('\n')).join('\n\n');
  const toolDescriptions: Record<string, string> = {
    read: 'Read files in the sandbox.', write: 'Create or replace files where you have write access.',
    edit: 'Make targeted changes to files where you have write access.', bash: 'Run shell commands, including swarm commands.',
    grep: 'Search file contents in the sandbox.', find: 'Find files in the sandbox.', ls: 'List directories in the sandbox.',
  };
  const tools = executor === 'codex' ? codexTools : executor === 'pi'
    ? enabledTools === undefined ? piTools : enabledTools.map(name => `- ${name}: ${toolDescriptions[name] ?? 'Explicitly registered Guest tool.'}`).join('\n') : null;
  const sections = [
    executor === 'pi' && enabledTools !== undefined && !enabledTools.includes('bash') ? preamble.split('\n')[0] : preamble,
    ...(tools ? [`<tools>\n${tools}\n</tools>`] : []),
    `<services>\n${serviceHelp}\n\n${directory || 'No Service operations are available to this agent.'}\n</services>`,
  ];
  if (addedSystemPrompt?.trim()) {
    sections.push(`<added_system_prompt>\n${addedSystemPrompt}\n</added_system_prompt>`);
  }
  return sections.join('\n\n');
}
