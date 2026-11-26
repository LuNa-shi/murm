import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('offline archive ships the native Agensh host configuration and declared foreground entries', {
  timeout: 180_000
}, async t => {
  const installed = await installNotesExample();
  t.after(() => installed.close());
  const root = join(installed.directory, 'node_modules/@murm/core');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(metadata.exports['./backends/pi-opensandbox']);

  for (const path of [
    'dist/test/fixtures/peermesh-installed-host.js',
    'dist/test/fixtures/peermesh-team-upstream.js',
    'dist/scripts/run-harness.js',
    'dist/scripts/read-harness-result.js'
  ]) {
    await execute(process.execPath, ['--check', join(root, path)], {
      cwd: installed.directory,
      env: installed.env,
      timeout: 10_000
    });
  }

  const help = await execute(process.execPath, [join(root, 'dist/scripts/run-harness.js'), '--help'], {
    cwd: installed.directory,
    env: installed.env,
    timeout: 10_000
  });

  assert.match(help.stdout, /--config <host-module.mjs>/);
  assert.match(help.stdout, /status, kickoff, input, wait or stop/);

  for (const entry of ['run-harness', 'read-harness-result']) {
    await assert.rejects(access(join(root, 'dist/scripts', entry + '.js')), { code: 'ENOENT' });
  }

  const config = pathToFileURL(join(root, 'dist/examples/peermesh/config.js'));
  const project = join(installed.directory, 'project.json');
  await writeFile(project, JSON.stringify({ title: 'Installed project', body: 'Develop the project together' }));
  const settings = {
    PROJECT_FILE: project,
    RUN_ID: 'installed-fixture',
    IMAGE: 'no-allocation',
    MODEL_URL: 'http://127.0.0.1:1/v1/responses',
    GITEA_ORIGIN: 'http://127.0.0.1:1',
    GITEA_OWNER: 'fixture-owner',
    GITEA_TOKEN: 'fixture-token',
    MATTERMOST_ORIGIN: 'http://127.0.0.1:1',
    MATTERMOST_TEAM_ID: 'fixture-team',
    MATTERMOST_TOKEN: 'fixture-token',
    BOARD_SOURCE: 'unused-board',
    BOARD_MYSQL_DSN: 'mysql://fixture:unused@127.0.0.1/board',
  };
  const imported = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import config from ${JSON.stringify(config.href)};
    assert.equal(config.mode, 'peermesh');
    assert.equal(config.options.runId, 'installed-fixture');
    assert.equal(config.options.project.title, 'Installed project');
    assert.ok(config.options.backend);
    assert.equal(typeof config.options.startBoard, 'function');
  `], {
    cwd: installed.directory,
    env: {
      ...installed.env,
      ...Object.fromEntries(Object.entries(settings).map(([name, value]) => [`MURM_PEERMESH_${name}`, value])),
    },
    timeout: 10_000,
  });
  assert.equal(imported.stdout, '');
});
