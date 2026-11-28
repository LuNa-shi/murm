import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const examples = [
  ['peermesh', 'peerMeshConfig', 'PEERMESH'],
  ['lead-worker', 'leadWorkerConfig', 'LEAD_WORKER'],
  ['substrate', 'substrateConfiguration', 'SUBSTRATE'],
] as const;

function loadConfiguration(name: string, factory: string, environment: Record<string, string>) {
  const url = new URL(`../examples/${name}/project-config.js`, import.meta.url).href;
  const script = `const module = await import(${JSON.stringify(url)}); const config = module[${JSON.stringify(factory)}](); console.log(JSON.stringify(config));`;
  // Isolate configuration from the invoking developer's model/provider secrets.
  const env = {
    PATH: process.env.PATH,
    MURM_LIFECYCLE_URL: 'https://sandbox.example.test/v1',
    MURM_LIFECYCLE_TOKEN: 'test-lifecycle',
    MURM_ADVERTISE_HOST: '192.0.2.1',
    MURM_PEERMESH_GITEA_ORIGIN: 'http://192.0.2.2:3000',
    MURM_PEERMESH_GITEA_OWNER: 'test-owner', MURM_PEERMESH_GITEA_TOKEN: 'test-gitea',
    MURM_PEERMESH_MATTERMOST_ORIGIN: 'http://192.0.2.3:8065',
    MURM_PEERMESH_MATTERMOST_TEAM_ID: 'test-team', MURM_PEERMESH_MATTERMOST_TOKEN: 'test-chat',
    MURM_PEERMESH_BOARD_MYSQL_DSN: 'mysql://test@localhost/board', MURM_PEERMESH_BOARD_SOURCE: '/unused-board',
    MURM_LEAD_WORKER_GITEA_ORIGIN: 'http://192.0.2.2:3000',
    MURM_LEAD_WORKER_GITEA_OWNER: 'test-owner', MURM_LEAD_WORKER_GITEA_ADMIN_TOKEN: 'test-gitea',
    ...environment,
  };
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env, encoding: 'utf8', timeout: 10_000,
  }));
}

test('project examples honor common model/executor/image settings before scoped fallbacks', () => {
  for (const [name, factory, scope] of examples) {
    const common = loadConfiguration(name, factory, {
      MURM_MODEL_URL: 'https://model.example.test/v1/responses',
      MURM_MODEL_TOKEN: 'common-token', MURM_MODEL_PROVIDER: 'openai',
      MURM_MODEL_ID: 'chosen-model', MURM_EXECUTOR: 'codex', MURM_WORKER_IMAGE: 'custom-worker:tested',
      [`MURM_${scope}_MODEL_URL`]: 'https://unused.example.test/v1/responses',
      [`MURM_${scope}_MODEL_PROVIDER`]: 'unused', [`MURM_${scope}_MODEL_ID`]: 'unused',
      [`MURM_${scope}_EXECUTOR`]: 'pi', [`MURM_${scope}_IMAGE`]: 'unused:latest',
    });
    assert.equal(common.executor, 'codex', name);
    assert.equal(common.image, 'custom-worker:tested', name);
    assert.equal(common.models.default.model, 'chosen-model', name);
    assert.equal(common.models.default.provider, 'openai', name);
    assert.equal(common.models.default.upstream.url, 'https://model.example.test/v1/responses', name);
    assert.equal(common.models.default.upstream.headers.authorization, 'Bearer common-token', name);
    assert.equal(common.connection.modelGateway.maxOutputTokens, null, name);
    const scoped = loadConfiguration(name, factory, {
      [`MURM_${scope}_MODEL_URL`]: 'https://scoped.example.test/v1/responses',
      [`MURM_${scope}_MODEL_PROVIDER`]: 'kimi_proxy', [`MURM_${scope}_MODEL_ID`]: 'k3',
      [`MURM_${scope}_IMAGE`]: 'scoped-worker:tested',
    });
    assert.equal(scoped.models.default.upstream.url, 'https://scoped.example.test/v1/responses', name);
    assert.equal(scoped.models.default.model, 'k3', name);
    assert.equal(scoped.image, 'scoped-worker:tested', name);
    assert.equal(scoped.executor, 'pi', name);
    // Git examples must retain enforced allowlists until the API Provider can
    // supply that capability. Substrate does not need host Docker controls.
    assert.equal(scoped.sandbox.isolation?.network, name === 'substrate' ? undefined : 'local-docker', name);
  }
});


test('scoped endpoint-only configuration preserves its historical model while common endpoints use common defaults', () => {
  for (const [name, factory, scope] of examples) {
    const scopedEnvironment = {
      [`MURM_${scope}_MODEL_URL`]: 'https://legacy.example.test/v1/responses',
      [`MURM_${scope}_MODEL_TOKEN`]: 'legacy-token',
    };
    const legacy = loadConfiguration(name, factory, scopedEnvironment);
    assert.equal(legacy.models.default.provider, 'kimi_proxy', name);
    assert.equal(legacy.models.default.model, 'k3', name);
    assert.equal(legacy.models.default.upstream.url, 'https://legacy.example.test/v1/responses', name);
    assert.equal(legacy.models.default.upstream.headers.authorization, 'Bearer legacy-token', name);
    const common = loadConfiguration(name, factory, {
      ...scopedEnvironment, MURM_MODEL_URL: 'https://common.example.test/v1/responses',
    });
    assert.equal(common.models.default.provider, 'openai', name);
    assert.equal(common.models.default.model, 'gpt-5.4', name);
    assert.equal(common.models.default.upstream.url, 'https://common.example.test/v1/responses', name);
    const explicit = loadConfiguration(name, factory, {
      ...scopedEnvironment,
      [`MURM_${scope}_MODEL_PROVIDER`]: 'chosen-provider',
      [`MURM_${scope}_MODEL_ID`]: 'chosen-model',
    });
    assert.equal(explicit.models.default.provider, 'chosen-provider', name);
    assert.equal(explicit.models.default.model, 'chosen-model', name);
  }
});
