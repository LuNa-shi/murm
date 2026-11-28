export default function sessionProof(pi) {
  pi.on('before_agent_start', async () => ({ message: {
    customType: 'session-proof-extension', content: 'EXTENSION_RESOURCE_MARKER', display: false,
  } }));
}
