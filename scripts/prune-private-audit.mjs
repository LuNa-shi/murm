#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { prunePrivateAudit } from '../src/observability/private-audit-retention.js';

const [flag, root, ...extra] = process.argv.slice(2);
if (flag !== '--root' || !root || !isAbsolute(root) || extra.length) {
  throw new Error('Usage: node scripts/prune-private-audit.mjs --root ABSOLUTE_EXPERIMENT_ROOT');
}
process.stdout.write(JSON.stringify(await prunePrivateAudit({ root })) + '\n');
