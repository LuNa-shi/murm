import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { execute, preparePackageArchive } from './fixtures/notes-installed-package.js';

const examples = ['subagents', 'taskpool', 'peermesh', 'lead-worker', 'substrate'];

test('each collaboration package builds and runs its own project entry from an exact installed SDK archive', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join('/tmp', 'murm-standalone-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = await realpath(join(import.meta.dirname, '../..'));
  const offset = relative(checkout, await realpath(directory));
  assert.ok(offset.startsWith('..') || isAbsolute(offset));
  const { archive } = await preparePackageArchive(directory);
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const config = join(directory, 'invalid-config.mjs');
  await writeFile(config, 'export default {};\n');
  await execute('tar', ['-xzf', archive, ...examples.map(example => `package/examples/${example}`)], { cwd: directory, timeout: 30_000 });

  for (const example of examples) {
    await t.test(example, async () => {
      const cwd = join(directory, 'package', 'examples', example);
      await execute('npm', ['install', '--prefer-offline', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', archive], {
        cwd, env, timeout: 60_000,
      });
      await execute('npm', ['run', 'check'], { cwd, env, timeout: 30_000 });
      await execute('npm', ['run', 'build'], { cwd, env, timeout: 30_000 });

      async function run(launch: string, args: string[], fromExample: boolean) {
        const source = fromExample ? join(cwd, 'sample-project') : launch;
        const prompt = `Check ${example} from ${fromExample ? 'its own directory' : 'the input directory'}`;
        const options = ['--cwd', source, '--prompt', prompt, '--config', config, '--output-dir', join(directory, 'runs')];
        let record;
        await assert.rejects(execute(args[0], [...args.slice(1), ...options], { cwd: launch, env, timeout: 15_000 }),
          error => {
            assert.equal(error.code, 2, error.stdout || error.stderr);
            record = JSON.parse(error.stdout.trim());
            return true;
          });
        assert.equal(record.type, 'result');
        assert.equal(record.result.harness.id, example);
        assert.equal(record.result.cwd, source);
        assert.equal(record.result.failure.code, 'INVALID_RUN_CONFIGURATION');
        assert.equal(record.result.cleanup.status, 'complete');
        assert.equal(await readFile(record.result.prompt.path, 'utf8'), prompt);
        const manifest = JSON.parse(await readFile(record.result.initial.manifestPath, 'utf8'));
        const file = manifest.find(item => item.path === 'seed.bin');
        assert.deepEqual({ mode: file.mode, sha256: file.sha256 }, {
          mode: 0o755, sha256: createHash('sha256').update(await readFile(join(source, 'seed.bin'))).digest('hex'),
        });
      }

      const input = join(directory, `project-${example}`);
      const sample = join(cwd, 'sample-project');
      await Promise.all([mkdir(input), mkdir(sample)]);
      await writeFile(join(input, 'seed.bin'), Buffer.from([0, 255]));
      await writeFile(join(sample, 'seed.bin'), Buffer.from([1, 254]));
      await Promise.all([chmod(join(input, 'seed.bin'), 0o755), chmod(join(sample, 'seed.bin'), 0o755)]);
      await run(cwd, ['npm', 'run', '--silent', 'start', '--'], true);
      await run(input, [join(cwd, 'node_modules/.bin/murm'), '--harness', join(cwd, 'dist/project.js')], false);
    });
  }
});
