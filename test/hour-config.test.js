import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@swarmenv/core';
import { createPeerProfile } from '../src/environments/agensh/index.js';
import { createAgenshServices } from '../src/environments/agensh/services.js';
import { createSubstrateService } from '../src/environments/scalemas/substrate.js';
import { scaleMASPeerProfile } from '../src/environments/scalemas/index.js';
import { HOUR_BUDGETS } from '../src/environments/endurance/matrix.js';
import { HOUR_QUOTAS } from '../src/environments/endurance/policy.js';
import configuration from '../examples/hour-matrix/config.mjs';

test('shipped hour configuration passes actual production Runtime/Profile validators without allocating or model requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hour-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const module = join(directory, 'programming.mjs');
  await writeFile(module, 'export default {prompt:()=>"controlled task",verify:()=>true};\n');
  const settings = { IMAGE: `sha256:${'a'.repeat(64)}`, WORKLOAD: module, UPSTREAM_URL: 'http://127.0.0.1:1/v1/responses',
    UPSTREAM_HEADERS_JSON: '{}', GITEA_ORIGIN: 'http://172.17.0.1:3000', GITEA_OWNER: 'owner', GITEA_TOKEN: 'PRIVATE-git',
    MATTERMOST_ORIGIN: 'http://127.0.0.1:3001', MATTERMOST_TEAM_ID: 'team', MATTERMOST_TOKEN: 'PRIVATE-mm',
    BOARD_MYSQL_DSN: 'PRIVATE-mysql', BOARD_SOURCE: directory, LIFECYCLE_URL: 'http://127.0.0.1:1/v1' };
  const previous = new Map();
  for (const [key,value] of Object.entries(settings)) { const name = `SWARMENV_HOUR_${key}`; previous.set(name, process.env[name]); process.env[name] = value; }
  t.after(() => { for (const [key,value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  for (const mode of ['scaleMAS','agensh']) {
    const ports = await configuration.configurations[mode]({mode, budgets:HOUR_BUDGETS, quotas:HOUR_QUOTAS});
    let runtime, substrate;
    try {
      let services, profiles;
      if (mode === 'scaleMAS') {
        substrate = createSubstrateService({databasePath:join(directory,'substrate.sqlite'),runId:'config-scale',poolSize:6});
        services = substrate.services; profiles = {peer:scaleMASPeerProfile({image:settings.IMAGE})};
      } else {
        const peers = ['a','b','c','d','e','f','g','h'].map((key,index) => ({key,branch:`branch-${key}`,
          gitea:{username:`peer-${key}`,binding:`git-${key}`,accountId:String(index+1),token:`PRIVATE-git-${key}`},
          message:{binding:`mm-${key}`,accountId:key,token:`PRIVATE-mm-${key}`},board:{binding:`board-${key}`,workerId:`worker-${key}`}}));
        const facilities = {runId:ports.options.runId,repository:{owner:'owner',name:'repo'},repositoryUrl:'http://172.17.0.1:3000/owner/repo.git',
          channelId:'channel',boardId:'board',issueNumber:1,endpoints:{gitea:settings.GITEA_ORIGIN,message:settings.MATTERMOST_ORIGIN,board:'http://127.0.0.1:8660'},peers};
        services = createAgenshServices(facilities).services;
        profiles = Object.fromEntries(peers.map(peer => [`peer-${peer.key}`,createPeerProfile({image:settings.IMAGE,facilities:{...facilities,peer}})]));
      }
      runtime = await createRuntime({backend:ports.options.backend,outputDir:join(directory,mode),services,profiles,maxBots:mode==='agensh'?8:6});
      const close = await runtime.close({timeoutMs:1000});
      assert.equal(close.cleanup,'complete'); assert.deepEqual(close.bots,[]);
      assert.equal(ports.quota.receipt().profile,'endurance'); assert.equal(ports.quota.receipt().forwarded,0);
      assert.equal(ports.quota.receipt().frozenPolicy.maxRequests,96);
    } finally { if(runtime)await runtime.close({timeoutMs:1000}); substrate?.close(); await ports.quota.close(); }
    assert.equal(ports.quota.receipt().closed,true);
  }
});
