export function leadHelperRoles(helperCount = 2) {
  if (!Number.isSafeInteger(helperCount) || helperCount < 2 || helperCount > 7) {
    throw new TypeError('Lead-helper requires between two and seven helpers');
  }
  return ['lead', ...Array.from({ length: helperCount }, (_, index) => `helper${index + 1}`)];
}

export function matchesRoles(roles, entries) {
  return Boolean(entries && typeof entries === 'object' && !Array.isArray(entries) && Object.keys(entries).length === roles.length &&
    roles.every(role => Object.hasOwn(entries, role)));
}

export function matchesTeam(roles, identities) {
  if (!matchesRoles(roles, identities)) return false;
  const ids = roles.map(role => identities[role]);
  return ids.every(id => typeof id === 'string' && id.length > 0) && new Set(ids).size === roles.length;
}
