#!/usr/bin/env node
import { installPeerLifetime } from './peer-process-lifetime.js';
import { createContextServicePeer } from './context-service-peer.js';
const peer = createContextServicePeer({ database: process.env.MURM_SERVICE_DATABASE,
  token: process.env.MURM_COORDINATOR_TOKEN, host: process.env.MURM_SERVICE_HOST ?? '127.0.0.1',
  publicUrl: process.env.MURM_SERVICE_PUBLIC_URL || null });
const endpoint = await peer.start({ port: Number(process.env.MURM_SERVICE_PORT ?? 0) });
console.log(JSON.stringify({ service_id: endpoint.service_id, url: endpoint.url }));
installPeerLifetime(peer);
