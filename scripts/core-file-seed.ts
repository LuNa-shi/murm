import { createHash } from 'node:crypto';
import type { FileSeed } from '../src/core/types.js';

interface DecodedFile {
  path: string;
  bytes: Buffer;
  mode: number;
}

const maxFileBytes = 2 * 1024 ** 2;
const maxTotalBytes = 16 * 1024 ** 2;
const maxFiles = 10_000;

function invalid(message: string) {
  return Object.assign(new TypeError(message), { code: 'INVALID_CONTRACT' });
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function fileSeedDigest(entries: readonly DecodedFile[]) {
  return hash(JSON.stringify(entries.map(({ path, bytes, mode }) => [path, mode, hash(bytes)])));
}

export function decodeFileSeed(files: unknown) {
  if (!record(files)) throw invalid('FileSeed must be a map of ordinary files');
  const paths = Object.keys(files).sort();
  if (paths.length > maxFiles) throw invalid('FileSeed exceeds the file count limit');

  let total = 0;
  const entries: DecodedFile[] = [];
  for (const path of paths) {
    const parts = path.split('/');
    if (!path.isWellFormed() || /[\\\0]/.test(path) || /^[a-z]:\//i.test(path) ||
        parts.some(part => part === '' || part === '.' || part === '..')) {
      throw invalid('FileSeed requires a normalized relative path inside the Bot workDir');
    }
    for (let depth = 1; depth < parts.length; depth++) {
      if (Object.hasOwn(files, parts.slice(0, depth).join('/'))) throw invalid('FileSeed paths collide with a parent file');
    }

    const file = files[path];
    if (!record(file) || Object.keys(file).some(key => !['encoding', 'data', 'mode'].includes(key)) ||
        typeof file.data !== 'string' || !['utf8', 'base64'].includes(file.encoding as string)) {
      throw invalid('FileSeed entries require utf8 or base64 data for ordinary files');
    }
    const { encoding, data, mode = 0o644 } = file;
    const encodedLimit = encoding === 'base64' ? 4 * Math.ceil(maxFileBytes / 3) : maxFileBytes;
    if (![0o644, 0o755].includes(mode as number) || data.length > encodedLimit || !data.isWellFormed()) {
      throw invalid('FileSeed entry has an unsupported mode, encoding, or byte count');
    }
    const bytes = Buffer.from(data, encoding as 'utf8' | 'base64');
    total += bytes.length;
    if (bytes.length > maxFileBytes || total > maxTotalBytes ||
        (encoding === 'base64' && bytes.toString('base64') !== data)) {
      throw invalid('FileSeed bytes exceed the configured limits or base64 is malformed');
    }
    entries.push({ path, bytes, mode: mode as number });
  }
  return { entries, digest: fileSeedDigest(entries) };
}

export function snapshotFileSeed(files: unknown): { files: FileSeed; digest: string } {
  const { entries, digest } = decodeFileSeed(files);
  return {
    files: Object.fromEntries(entries.map(({ path, bytes, mode }) => [path, { encoding: 'base64', data: bytes.toString('base64'), mode: mode as 0o644 | 0o755 }])),
    digest,
  };
}
