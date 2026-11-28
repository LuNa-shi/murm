import type { APIRoute, GetStaticPaths } from 'astro';
import config from '../../../../../../examples/first-harness/config.ts?raw';
import handoff from '../../../../../../examples/first-harness/handoff.ts?raw';
import harness from '../../../../../../examples/first-harness/harness.ts?raw';
import tsconfig from '../../../../../../examples/first-harness/tsconfig.json?raw';
import session from '../../../../../../examples/first-harness/session.ts?raw';

export const getStaticPaths: GetStaticPaths = () => Object.entries({
  'config.ts': config, 'handoff.ts': handoff, 'harness.ts': harness, 'tsconfig.json': tsconfig, 'session.ts': session,
}).map(([file, source]) => ({ params: { file }, props: { source } }));

export const GET: APIRoute = ({ props }) =>
  new Response(props.source, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
