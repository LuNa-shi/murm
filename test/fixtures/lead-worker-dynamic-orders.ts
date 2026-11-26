// The controlled model uses these bytes only for native infrastructure evidence.
export const calculation = `
export function summarize(input, originalLine = (index, valid, errors) => valid.length + errors.length + 1) {
  const valid = [], totals = {}, errors = [], ids = new Set();
  let records = 0;
  const lines = input.split('\\n');
  for (let index = 0; index < lines.length; index++) {
    if (/^[ \\t\\r]*$/.test(lines[index])) continue;
    if (++records > 1000) return { code: 'INPUT_LIMIT' };
    const line = originalLine(index, valid, errors);
    let row;
    try { row = JSON.parse(lines[index]); }
    catch { errors.push({ line, code: 'INVALID_JSON' }); continue; }
    const { id, currency, amount_cents } = row ?? {};
    const code = typeof id !== 'string' || !id || typeof currency !== 'string' || typeof amount_cents !== 'number' ? 'INVALID_FIELDS'
      : !['EUR', 'GBP', 'USD'].includes(currency) ? 'INVALID_CURRENCY'
      : !Number.isSafeInteger(amount_cents) || amount_cents < 0 || amount_cents > 9000000000000 ? 'INVALID_AMOUNT'
      : ids.has(id) ? 'DUPLICATE_ID' : null;
    if (code) { errors.push({ line, code }); continue; }
    valid.push({ id, currency, amount_cents });
    totals[currency] = (totals[currency] ?? 0) + amount_cents;
    ids.add(id);
  }
  return { valid, totals, errors };
}
`;
export const ordersCli = `
import { readFileSync } from 'node:fs';
import { summarize } from './orders-lib.mjs';
const args = process.argv.slice(2);
let result;
if (args.length > 1) result = { code: 'USAGE' };
else {
  try { result = summarize(readFileSync(args[0] ?? 0, 'utf8')); }
  catch { result = { code: 'FILE_ERROR' }; }
}
if (result.code) { console.error(JSON.stringify(result)); process.exitCode = 2; }
else { console.log(JSON.stringify(result)); process.exitCode = result.errors.length ? 1 : 0; }
`;
export const corrected = calculation.replace('valid.length + errors.length + 1', 'index + 1');
export const generatedService = corrected + `
import { createServer } from 'node:http';
createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && request.url === '/health') { response.end('{}'); return; }
  if (request.method !== 'POST' || request.url !== '/v2/check_orders') { response.writeHead(404).end('{}'); return; }
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const { input } = JSON.parse(raw);
    response.end(JSON.stringify({ ok: true, result: summarize(input.jsonl) }));
  } catch { response.writeHead(400).end('{}'); }
}).listen(8080, '127.0.0.1');
`;
