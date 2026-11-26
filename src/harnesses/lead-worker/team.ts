export function leadWorkerRoles(helperCount: any = 2) {
  if (!Number.isSafeInteger(helperCount) || helperCount < 2 || helperCount > 7) {
    throw Object.assign(new TypeError('Lead–Worker requires between two and seven helpers'), { code: 'INVALID_RUN_CONFIGURATION' });
  }
  return ['lead', ...Array.from({ length: helperCount }, (_: any, index: any) => `helper${index + 1}`)];
}

export function matchesRoles(roles: any, entries: any) {
  return Boolean(entries && typeof entries === 'object' && !Array.isArray(entries) && Object.keys(entries).length === roles.length &&
    roles.every((role: any) => Object.hasOwn(entries, role)));
}

export function matchesTeam(roles: any, identities: any) {
  if (!matchesRoles(roles, identities)) return false;
  const ids = roles.map((role: any) => identities[role]);
  return ids.every((id: any) => typeof id === 'string' && id.length > 0) && new Set(ids).size === roles.length;
}
