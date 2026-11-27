export interface FileBudget {
  maxBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxEntries: number;
  timeoutMs: number;
}

export interface FilePolicy {
  initial?: Partial<FileBudget>;
  snapshot?: Partial<FileBudget>;
  replace?: Partial<FileBudget>;
  export?: Partial<FileBudget>;
  session?: Partial<FileBudget>;
  controllerSpoolBytes?: number;
  workerSpoolBytes?: number;
}

const tree = Object.freeze({ maxBytes: 16 * 1024 ** 2, maxFileBytes: 2 * 1024 ** 2, maxFiles: 10_000,
  maxEntries: 50_000, timeoutMs: 30_000 });
const archive = Object.freeze({ maxBytes: 256 * 1024 ** 2, maxFileBytes: 256 * 1024 ** 2,
  maxFiles: 16_384, maxEntries: 16_384, timeoutMs: 30_000 });
const defaults = Object.freeze({
  initial: tree, snapshot: tree, replace: tree,
  export: archive, session: Object.freeze({ ...archive, timeoutMs: 600_000 }),
  controllerSpoolBytes: 256 * 1024 ** 2, workerSpoolBytes: 512 * 1024 ** 2,
});
export type ResolvedFilePolicy = {
  readonly [Phase in 'initial' | 'snapshot' | 'replace' | 'export' | 'session']: Readonly<FileBudget>;
} & { readonly controllerSpoolBytes: number; readonly workerSpoolBytes: number };

function positive(value: unknown, limit = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= limit;
}

export function resolveFilePolicy(input: FilePolicy = {}): ResolvedFilePolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new TypeError('Invalid project file policy');
  const controllerSpoolBytes = input.controllerSpoolBytes ?? defaults.controllerSpoolBytes;
  const workerSpoolBytes = input.workerSpoolBytes ?? defaults.workerSpoolBytes;
  if (!positive(controllerSpoolBytes) || !positive(workerSpoolBytes)) throw new TypeError('File spool budgets must be positive byte counts');
  const budget = (stage: 'initial' | 'snapshot' | 'replace' | 'export' | 'session') => {
    const supplied = input[stage];
    if (supplied !== undefined && (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
        Object.keys(supplied).some(key => !Object.hasOwn(tree, key)))) throw new TypeError(`Invalid ${stage} file budget`);
    const result = { ...defaults[stage], ...supplied };
    if (!positive(result.maxBytes) || !positive(result.maxFileBytes) || !positive(result.maxFiles, 1_000_000) ||
        !positive(result.maxEntries, 1_000_000) || !positive(result.timeoutMs, 2_147_483_647)) {
      throw new TypeError(`Invalid bounds for the ${stage} file budget`);
    }
    return Object.freeze({ ...result, maxFileBytes: Math.min(result.maxFileBytes, result.maxBytes),
      maxFiles: Math.min(result.maxFiles, result.maxEntries) });
  };
  return Object.freeze({ initial: budget('initial'), snapshot: budget('snapshot'), replace: budget('replace'),
    export: budget('export'), session: budget('session'), controllerSpoolBytes, workerSpoolBytes });
}

export const DEFAULT_FILE_POLICY = resolveFilePolicy();
