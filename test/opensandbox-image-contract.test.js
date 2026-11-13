import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('OpenSandbox image carries the direct Pi model catalog without NuRouter', async () => {
  const dockerfile = await readFile(new URL('../services/opensandbox-agent/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY services\/opensandbox-agent\/pi-models\.json \/opt\/swarmenv\/pi-agent\/models\.json/);
  assert.match(dockerfile, /PI_CODING_AGENT_DIR=/);
  assert.doesNotMatch(dockerfile, /nu-router|NUROUTER_SHA256|SWARMENV_NUROUTER_VERSION/);
  assert.match(dockerfile, /chmod 0555 \/opt\/swarmenv\/scripts\/swarm\.mjs/);
  assert.match(dockerfile, /mkdir -p \/workspace/);
  assert.match(dockerfile, /COPY src \/opt\/swarmenv\/src/);
});
