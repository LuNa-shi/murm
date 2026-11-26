const rawBase = import.meta.env.BASE_URL || '/';
const normalizedBase = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

export function withBase(path: string): string {
  if (!path) return normalizedBase;
  if (/^https?:\/\//.test(path) || path.startsWith('#') || path.startsWith('mailto:')) {
    return path;
  }
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${normalizedBase}${clean}`;
}
