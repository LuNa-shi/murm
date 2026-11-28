import { runtimeSettings } from './core-runtime-settings.js';

import { createLocalPeerMeshStack } from './node_modules/@luna-shi/murm/dist/test/fixtures/peermesh-local-stack.js';
import { createCleanupBudget } from './node_modules/@luna-shi/murm/dist/test/fixtures/peermesh-deadline.js';
import { httpClient } from './node_modules/@luna-shi/murm/dist/src/harness/http.js';
import { teamFact, teamInputs } from './node_modules/@luna-shi/murm/dist/test/fixtures/peermesh-team-upstream.js';
import { readFile } from 'node:fs/promises';
const input = JSON.parse(await readFile(process.env.MURM_PEERMESH_HOST_INPUT, 'utf8'));

const stack = await createLocalPeerMeshStack({
  directory: input.directory,
  advertiseHost: input.host
});

process.on('message', async message => {
  if (message.type === 'verify-facilities') {
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(10000, message.deadlineAt - Date.now())));

      const boardPath = `/board/board-${input.runId}/read?viewer=worker-${input.runId}-b`;
      const board = await httpClient(stack.boardOrigin)('GET', boardPath, undefined, { signal });

      const messageClient = httpClient(
        configuration.mattermost.origin,
        `Bearer ${configuration.mattermost.adminToken}`
      );
      const channelPath = `/api/v4/teams/${configuration.mattermost.teamId}/channels/name/run-${input.runId}`;

      const channel = await messageClient('GET', channelPath, undefined, { signal });
      const postsPath = `/api/v4/channels/${channel.id}/posts?page=0&per_page=50`;
      const posts = await messageClient('GET', postsPath, undefined, { signal });

      process.send({
        type: 'facilities-verified',

        proof: {
          boardFact: board.rendered.includes(teamFact),
          negotiation: Object.values(posts.posts).some(row => row.message.includes(teamInputs[2])),
          confirmation: Object.values(posts.posts).some(row => row.message.includes(teamInputs[3]))
        }
      });
    } catch {
      process.send({
        type: 'facilities-verification-failed'
      });
    }

    return;
  }

  if (message.type !== 'close-facilities') return;

  const budget = createCleanupBudget(Math.max(1, message.deadlineAt - Date.now())).start();

  try {
    const receipt = await stack.close(budget);

    process.send({
      type: 'facilities-closed',
      receipt,
      resources: stack.receipt()
    });
  } finally {
    budget.dispose();
    process.disconnect();
  }
});

let configuration;

try {
  configuration = await stack.start();
} catch {
  process.send({
    type: 'setup-failed'
  });

  throw Object.assign(new Error('LOCAL_SETUP_FAILED'), {
    code: 'LOCAL_SETUP_FAILED'
  });
}

process.send({
  type: 'facilities',

  configuration: {
    gitea: configuration.gitea,
    mattermost: configuration.mattermost
  }
});

export default {
  mode: 'peermesh',
  timeoutMs: 180000,

  options: {
    ...configuration,
    runId: input.runId,
    image: input.image,
    peerKeys: ['a', 'b'],
    outputDir: input.outputDir,
    closeTimeoutMs: 60000,

    router: {
      workTimeoutMs: 180000,
      turnTimeoutMs: 80000,
      maxBatches: 8,
      maxNudges: 0,

      events: {
        pollIntervalMs: 1000,
        maxPolls: 180
      }
    },

    ...runtimeSettings({
      sandbox: {
        lifecycleBaseUrl: input.lifecycle,
        apiKey: input.apiKey,
        commandTimeoutMs: 20000,

        resourceLimits: {
          cpu: '1',
          memory: '1Gi'
        }
      },

      bridge: {
        host: '0.0.0.0',
        publicUrl: 'http://' + input.host + ':{port}'
      },

      modelGateway: {
        host: '0.0.0.0',
        advertiseHost: input.host,
        maxOutputTokens: 128,
        requestTimeoutMs: 85000
      },

      models: {
        default: {
          provider: 'kimi_proxy',
          model: 'k3',

          upstream: {
            url: input.upstream,
            headers: {}
          }
        }
      },

      isolation: { network: 'api' }
    })
  }
};
