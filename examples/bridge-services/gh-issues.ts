import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInProcessAdapter, type ServiceRegistration } from '@murm/core/services';

const execute = promisify(execFile);
const repositoryName = '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$';

export function createGhIssuesService({ repository, token }: { repository: string; token: string }): ServiceRegistration {
  if (!new RegExp(repositoryName).test(repository) || !token?.trim()) throw new TypeError('A GitHub repository and host credential are required');
  return {
    manifest: {
      id: 'github', title: 'GitHub issues', purpose: 'List issues from the configured repository', provider_version: '1', contract_version: '2',
      endpoint: { transport: 'in-process' },
      capabilities: [{
        name: 'list_issues', operation: 'list_issues', description: 'List open issues with GitHub CLI', side_effect: 'read', idempotent: true,
        help: { when: 'Read issue numbers and titles in the allowed repository' }, errors: [{ code: 'NOT_ALLOWED', retryable: false }],
        timeout_ms: 12_000,
        input_schema: { type: 'object', properties: { repository: { type: 'string', pattern: repositoryName }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
          required: ['repository', 'limit'], additionalProperties: false },
        output_schema: { type: 'array', maxItems: 20, items: { type: 'object', properties: { number: { type: 'integer', minimum: 1 }, title: { type: 'string', maxLength: 1024 } },
          required: ['number', 'title'], additionalProperties: false } },
      }],
    },
    adapter: createInProcessAdapter({ async invoke({ capability, input, signal, assertAuthorized }) {
      const query = input as { repository: string; limit: number };
      if (capability.operation !== 'list_issues' || query.repository.toLowerCase() !== repository.toLowerCase()) {
        throw Object.assign(new Error('This GitHub operation or repository is outside the allowed scope'), { code: 'NOT_ALLOWED' });
      }
      assertAuthorized();
      // An argument vector and a small subprocess environment keep shell access and other host credentials outside this operation.
      const { stdout } = await execute('gh', ['issue', 'list', '--repo', `github.com/${repository}`, '--limit', String(query.limit),
        '--json', 'number,title'], { env: { PATH: process.env.PATH, GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' }, signal, timeout: 10_000, maxBuffer: 256 * 1024 });
      // Core sanitizes undeclared subprocess failures. Never return the child's stderr or environment.
      return JSON.parse(stdout.replaceAll(token, '[redacted]'));
    } }),
  };
}
