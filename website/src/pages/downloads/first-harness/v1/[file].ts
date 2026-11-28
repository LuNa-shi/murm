import type { APIRoute, GetStaticPaths } from 'astro';
import config from '../../../../../../examples/first-harness/config.ts?raw';
import handoff from '../../../../../../examples/first-harness/handoff.ts?raw';
import main from '../../../../../../examples/first-harness/main.ts?raw';
import tsconfig from '../../../../../../examples/first-harness/tsconfig.json?raw';
import turn from '../../../../../../examples/first-harness/turn.ts?raw';

export const getStaticPaths: GetStaticPaths = () => Object.entries({
  'config.ts': config, 'handoff.ts': handoff, 'main.ts': main, 'tsconfig.json': tsconfig, 'turn.ts': turn,
}).map(([file, source]) => ({ params: { file }, props: { source } }));

export const GET: APIRoute = ({ props }) =>
  new Response(props.source, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
