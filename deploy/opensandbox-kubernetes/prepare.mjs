#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const [sitePath, outputPath] = process.argv.slice(2);
assert.ok(sitePath && outputPath && process.argv.length === 4, 'Usage: node prepare.mjs site.json output-directory');
const site = JSON.parse(await readFile(sitePath, 'utf8'));
const bom = JSON.parse(await readFile(new URL('./bom.json', import.meta.url), 'utf8'));
const lockBytes = await readFile(new URL('../../npm-shrinkwrap.json', import.meta.url));
const lock = JSON.parse(lockBytes.toString('utf8'));
assert.equal(lock.packages['node_modules/@alibaba-group/opensandbox'].version, '1.2.1', 'SDK lockfile must match deployment BOM');
const digestImage = value => typeof value === 'string' && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value);
for (const name of ['workerImage', 'runtimeImage']) assert.ok(digestImage(site[name]), `${name} requires a registry image pinned by digest`);
for (const name of ['storageClassName', 'runtimeConfigSecret', 'apiKeySecret', 'signingKeySecret']) {
  assert.match(site[name], /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, `${name} requires an existing Kubernetes object name`);
  assert.ok(!site[name].includes('REPLACE'), `${name} is a placeholder`);
}
assert.equal(site.trustedPrivateNetwork, true, 'This profile requires an explicitly trusted private cluster network');
assert.match(site.gatewayAddress, /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?$/, 'gatewayAddress is a private DNS name with optional port, without scheme or path');
assert.ok(!['localhost', '127.0.0.1', '0.0.0.0'].includes(site.gatewayAddress.split(':')[0]), 'gatewayAddress must be reachable outside the Controller host');
assert.ok(Array.isArray(site.runtimeCommand) && site.runtimeCommand.length && site.runtimeCommand.every(value => typeof value === 'string' && value), 'runtimeCommand is an explicit application bootstrap/recovery command');
assert.ok(site.sandboxNodeSelector && Object.keys(site.sandboxNodeSelector).length, 'sandboxNodeSelector must select the prepared worker nodes');
for (const name of ['sandboxNodeSelector', 'runtimeNodeSelector']) {
  assert.ok(site[name] && !Array.isArray(site[name]) && Object.values(site[name]).every(value => typeof value === 'string'), `${name} requires a string map`);
}
for (const type of ['cni', ...(site.csiSelector === null ? [] : ['csi'])]) {
  assert.match(site[`${type}Namespace`], /^[a-z0-9-]+$/);
  const selector = site[`${type}Selector`];
  assert.ok(typeof selector === 'string' && selector && !selector.includes('REPLACE'), `${type}Selector must identify installed driver workloads`);
}

const systemNamespace = 'opensandbox-system';
const workloadNamespace = 'opensandbox';
const runtimeNamespace = 'murm';
const pinnedImage = reference => {
  const split = reference.lastIndexOf(':release-');
  assert.ok(split > 0);
  return { repository: reference.slice(0, split), tag: reference.slice(split + 1), pullPolicy: 'IfNotPresent' };
};
const images = bom.opensandbox.images;
const secretEnv = (name, secret, key) => ({ name, valueFrom: { secretKeyRef: { name: secret, key } } });
const values = {
  base: { enabled: true, fastSandbox: { crds: { install: false }, rbac: { create: false }, namespaces: { createSystem: false, create: false } } },
  'fast-sandbox': { enabled: false },
  'opensandbox-node-agent': { enabled: false },
  'opensandbox-controller': { controller: {
    image: pinnedImage(images.controller), replicaCount: 1, namespaces: [workloadNamespace],
    snapshot: { imageCommitterImage: images.imageCommitter },
    resources: { requests: { cpu: '500m', memory: '512Mi' }, limits: { cpu: '2', memory: '2Gi' } },
  } },
  'ingress-gateway': { enabled: true, gateway: {
    image: pinnedImage(images.ingress), replicaCount: 2, providerType: 'batchsandbox', dataplaneNamespace: workloadNamespace,
    gatewayRouteMode: 'uri', secureAccess: { existingSecret: site.signingKeySecret },
    resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '2', memory: '4Gi' } },
    service: { type: 'ClusterIP', port: 80 },
  } },
  'opensandbox-server': {
    server: {
      image: pinnedImage(images.server), replicaCount: 1,
      gateway: { enabled: true, host: site.gatewayAddress, gatewayRouteMode: 'uri', secureAccess: { existingSecret: site.signingKeySecret } },
      env: [secretEnv('OPENSANDBOX_SERVER_API_KEY', site.apiKeySecret, 'api-key')],
      resources: { requests: { cpu: '1', memory: '2Gi' }, limits: { cpu: '2', memory: '4Gi' } },
      volumes: [{ name: 'server-state', persistentVolumeClaim: { claimName: 'opensandbox-server-state' } }, { name: 'sandbox-template', configMap: { name: 'murm-sandbox-template' } }],
      volumeMounts: [{ name: 'server-state', mountPath: '/var/lib/opensandbox' }, { name: 'sandbox-template', mountPath: '/etc/opensandbox/workloads', readOnly: true }],
    },
    configToml: `[server]\nhost = "0.0.0.0"\nport = 80\nmax_sandbox_timeout_seconds = 86400\n\n[log]\nlevel = "INFO"\n\n[runtime]\ntype = "kubernetes"\nexecd_image = "${images.execd}"\n\n[kubernetes]\nkubeconfig_path = ""\nnamespace = "${workloadNamespace}"\nworkload_provider = "batchsandbox"\nbatchsandbox_template_file = "/etc/opensandbox/workloads/template.yaml"\ninformer_resync_seconds = 300\ninformer_watch_timeout_seconds = 60\n\n[store]\ntype = "sqlite"\npath = "/var/lib/opensandbox/opensandbox.db"\n\n[egress]\nimage = "${images.egress}"\nmode = "dns+nft"\n\n[egress.requests]\ncpu = "100m"\nmemory = "128Mi"\n\n[egress.limits]\ncpu = "500m"\nmemory = "512Mi"\n`,
  },
};
const namespace = name => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } });
const pvc = (name, ns, storage) => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: ns }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: site.storageClassName, resources: { requests: { storage } } } });
const workloadTemplate = { metadata: { labels: { 'murm.opensandbox/workload': 'true' } }, spec: { replicas: 1, template: { metadata: { labels: { 'murm.opensandbox/workload': 'true' } }, spec: {
  restartPolicy: 'Never', nodeSelector: site.sandboxNodeSelector,
  topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway', labelSelector: { matchLabels: { 'murm.opensandbox/workload': 'true' } } }],
} } } };
const resources = { apiVersion: 'v1', kind: 'List', items: [
  namespace(systemNamespace), namespace(workloadNamespace), namespace(runtimeNamespace),
  pvc('opensandbox-server-state', systemNamespace, '10Gi'), pvc('murm-run-directory', runtimeNamespace, '20Gi'),
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'murm-sandbox-template', namespace: systemNamespace }, data: { 'template.yaml': JSON.stringify(workloadTemplate) } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'murm-runtime', namespace: runtimeNamespace }, spec: { ipFamilyPolicy: 'SingleStack', ipFamilies: ['IPv4'], selector: { app: 'murm-runtime' }, ports: [{ name: 'callback', port: 3100, targetPort: 3100 }] } },
  { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'murm-runtime', namespace: runtimeNamespace }, spec: {
    replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { app: 'murm-runtime' } }, template: { metadata: { labels: { app: 'murm-runtime' } }, spec: {
      nodeSelector: site.runtimeNodeSelector, automountServiceAccountToken: false, enableServiceLinks: true, terminationGracePeriodSeconds: 120,
      containers: [{ name: 'runtime', image: site.runtimeImage, command: site.runtimeCommand,
        env: [
          secretEnv('OPEN_SANDBOX_API_KEY', site.apiKeySecret, 'api-key'),
          { name: 'OPEN_SANDBOX_ENDPOINT', value: `http://opensandbox-server.${systemNamespace}.svc.cluster.local` },
          { name: 'MURM_RUNTIME_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
          { name: 'MURM_RUNTIME_PUBLIC_URL', value: 'http://$(MURM_RUNTIME_SERVICE_HOST):3100' },
          { name: 'MURM_WORKER_IMAGE', value: site.workerImage },
        ],
        ports: [{ name: 'callback', containerPort: 3100 }],
        resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '2', memory: '4Gi' } },
        volumeMounts: [{ name: 'runs', mountPath: '/var/lib/murm' }, { name: 'runtime-config', mountPath: '/etc/murm', readOnly: true }],
      }],
      volumes: [{ name: 'runs', persistentVolumeClaim: { claimName: 'murm-run-directory' } }, { name: 'runtime-config', secret: { secretName: site.runtimeConfigSecret } }],
    } },
  } },
] };
const dir = resolve(outputPath);
await mkdir(dir, { recursive: true, mode: 0o700 });
const write = (name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await write('values.json', values);
await write('resources.json', resources);
await write('manifest-inputs.json', { schemaVersion: 1, sourceCommit: bom.opensandbox.sourceCommit,
  sdkLockfileSha256: createHash('sha256').update(lockBytes).digest('hex'),
  bomSha256: createHash('sha256').update(JSON.stringify(bom)).digest('hex'), siteSha256: createHash('sha256').update(JSON.stringify(site)).digest('hex'),
  workerImage: site.workerImage, runtimeImage: site.runtimeImage, executor: { pi: bom.murm.piVersion, codex: bom.murm.codexVersion },
  runtime: { replicas: 1, bindHost: '0.0.0.0', bindPort: 3100, runDirectory: '/var/lib/murm' }, status: 'prepared', clusterValidation: 'not-run' });
console.log(`Prepared private deployment inputs in ${dir}`);
