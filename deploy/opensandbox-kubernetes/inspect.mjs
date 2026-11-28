#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const [sitePath, outputPath] = process.argv.slice(2);
assert.ok(sitePath && outputPath && process.argv.length === 4, 'Usage: node inspect.mjs site.json private-evidence-directory');
const site = JSON.parse(await readFile(sitePath, 'utf8'));
for (const type of ['cni', ...(site.csiSelector === null ? [] : ['csi'])]) {
  assert.match(site[`${type}Namespace`], /^[a-z0-9-]+$/);
  assert.ok(typeof site[`${type}Selector`] === 'string' && site[`${type}Selector`] && !site[`${type}Selector`].includes('REPLACE'));
}
assert.ok(site.sandboxNodeSelector && !Array.isArray(site.sandboxNodeSelector) && Object.keys(site.sandboxNodeSelector).length);
assert.match(site.storageClassName, /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
const output = resolve(outputPath);
await mkdir(output, { recursive: true, mode: 0o700 });
const run = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  let bytes = 0;
  const chunks = [];
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
  child.stderr.resume();
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(JSON.parse(Buffer.concat(chunks).toString())) : reject(new Error(`Inventory command failed (${file}, exit ${code})`)));
});
const selector = Object.entries(site.sandboxNodeSelector).map(([key, value]) => `${key}=${value}`).join(',');
const queries = {
  version: ['version', '-o', 'json'],
  nodes: ['get', 'nodes', '-l', selector, '-o', 'json'],
  cni: ['get', 'pods', '-n', site.cniNamespace, '-l', site.cniSelector, '-o', 'json'],
  csi: ['get', 'csidrivers', '-o', 'json'],
  ...(site.csiSelector ? { csiWorkloads: ['get', 'pods', '-n', site.csiNamespace, '-l', site.csiSelector, '-o', 'json'] } : {}),
  storage: ['get', 'storageclass', site.storageClassName, '-o', 'json'],
  system: ['get', 'pods', '-n', 'opensandbox-system', '-o', 'json'],
  runtime: ['get', 'pods', '-n', 'murm', '-l', 'app=murm-runtime', '-o', 'json'],
  serverVolumes: ['get', 'pvc', '-n', 'opensandbox-system', '-o', 'json'],
  runtimeVolumes: ['get', 'pvc', '-n', 'murm', '-o', 'json'],
};
const values = Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, args]) => {
  const value = await run('kubectl', args);
  await writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return [name, value];
})));
const hash = value => createHash('sha256').update(value).digest('hex');
const ready = values.nodes.items.filter(node => node.status.conditions.some(row => row.type === 'Ready' && row.status === 'True'));
assert.ok(ready.length >= 2, 'At least two Ready selected worker nodes are required');
const machineIds = ready.map(node => node.status.nodeInfo.machineID || node.status.nodeInfo.systemUUID);
assert.ok(machineIds.every(Boolean) && new Set(machineIds).size >= 2, 'Worker node machine identities must be present and distinct');
assert.ok(values.cni.items.length, 'The CNI selector returned no workload Pods');
assert.ok(!values.csi.items.length || values.csiWorkloads?.items.length, 'Installed CSI drivers require a matching csiSelector to record their running image IDs');
const images = pods => pods.items.flatMap(pod => (pod.status.containerStatuses ?? []).map(container => ({ image: container.image, imageID: container.imageID ?? null })));
const system = values.system.items;
const servers = system.filter(pod => pod.metadata.labels?.['app.kubernetes.io/name'] === 'opensandbox-server' && !pod.metadata.deletionTimestamp);
assert.equal(servers.length, 1, 'There must be exactly one active Lifecycle Server Pod');
const gateways = system.filter(pod => pod.metadata.labels?.['app.kubernetes.io/name'] === 'opensandbox-ingress-gateway' && !pod.metadata.deletionTimestamp);
assert.equal(gateways.length, 2, 'The pinned gateway profile requires two ingress Pods');
assert.equal(values.runtime.items.filter(pod => !pod.metadata.deletionTimestamp).length, 1, 'There must be exactly one Runtime Pod');
const privateSummary = {
  schemaVersion: 1, observedAt: new Date().toISOString(), kubernetes: values.version.serverVersion.gitVersion,
  nodes: ready.map((node, index) => ({ anonymousId: hash(machineIds[index]), kubelet: node.status.nodeInfo.kubeletVersion,
    runtime: node.status.nodeInfo.containerRuntimeVersion, operatingSystem: node.status.nodeInfo.osImage, architecture: node.status.nodeInfo.architecture })),
  cni: images(values.cni), csi: values.csiWorkloads ? images(values.csiWorkloads) : [], csiDrivers: values.csi.items.map(driver => ({ name: driver.metadata.name, spec: driver.spec })),
  storage: { provisioner: values.storage.provisioner, binding: values.storage.volumeBindingMode ?? 'Immediate', reclaimPolicy: values.storage.reclaimPolicy },
  systemImages: images(values.system), runtimeImages: images(values.runtime),
  evidence: { vmTopology: 'operator must attach independent worker VM/host instance evidence', packetIsolation: 'not-run', bidirectionalSmoke: 'not-run', capacity: 'not-run' },
};
await writeFile(join(output, 'cluster-manifest.json'), JSON.stringify(privateSummary, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Cluster inventory saved privately. VM identity, smoke, fault and capacity acceptance remain separately measured.');
