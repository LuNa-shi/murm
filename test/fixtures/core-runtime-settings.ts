import type { CreateRuntimeOptions, SandboxConfig } from '@murm/core';
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
  const { createSandbox } = require('@murm/core') as typeof import('@murm/core');
  return { sandbox: createSandbox({ ...sandbox, isolation }), executor, models, connection: { bridge, modelGateway } };
}
