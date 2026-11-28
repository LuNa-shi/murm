import type { CreateRuntimeOptions, SandboxConfig } from '@luna-shi/murm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type Settings = Pick<CreateRuntimeOptions, 'sandbox' | 'executor' | 'models' | 'connection'>;

export function runtimeSettings({ sandbox, isolation, bridge, modelGateway, models, executor }: {
  sandbox: Omit<SandboxConfig, 'isolation'>;
  isolation: SandboxConfig['isolation'];
  bridge?: NonNullable<Settings['connection']>['bridge'];
  modelGateway?: NonNullable<Settings['connection']>['modelGateway'];
  models: Settings['models'];
  executor?: Settings['executor'];
}): Settings {
  const { createSandbox } = require('@luna-shi/murm') as typeof import('@luna-shi/murm');
  const address = bridge?.publicUrl;
  const isDynamic = address?.includes('{port}');
  const advertiseHost = isDynamic ? new URL(address!.replace('{port}', '1')).hostname : modelGateway?.advertiseHost;
  return { sandbox: createSandbox({ ...sandbox, isolation }), executor, models, connection: {
    advertiseHost, bindHost: bridge?.host ?? modelGateway?.host,
    ...(address && !isDynamic ? { publicUrl: address } : {}),
    modelGateway: modelGateway && {
      requestTimeoutMs: modelGateway.requestTimeoutMs, maxOutputTokens: modelGateway.maxOutputTokens,
      maxRequests: modelGateway.maxRequests,
    },
  } };
}
