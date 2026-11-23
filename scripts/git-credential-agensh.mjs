#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

// Git receives the credential over its private helper pipe. Never persist it.
export function credentialReply(operation, input, environment) {
  if (operation !== 'get' || input.length > 16_384) return '';
  let repository;
  try { repository = new URL(environment.RUN_REPOSITORY); } catch { return ''; }
  if (!['http:', 'https:'].includes(repository.protocol) || repository.username || repository.password || repository.search || repository.hash) return '';
  const fields = new Map();
  for (const line of input.trim().split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1 || fields.has(line.slice(0, separator))) return '';
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (fields.get('protocol') !== repository.protocol.slice(0, -1) || fields.get('host') !== repository.host ||
      fields.get('path') !== repository.pathname.slice(1) || (fields.has('username') && fields.get('username') !== environment.GITEA_USERNAME)) return '';
  const { GITEA_USERNAME: username, GITEA_TOKEN: token } = environment;
  if (![username, token].every(value => typeof value === 'string' && value && !/[\r\n\0]/.test(value))) return '';
  return `username=${username}\npassword=${token}\n\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 16_384) process.exit(1); }
    process.stdout.write(credentialReply(process.argv[2], input, process.env));
  } catch { process.exitCode = 1; }
}
