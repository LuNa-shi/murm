export function integer(value: any, min: any = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

export function object(value: any) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function fields(value: any, allowed: any) {
  return object(value) && Object.keys(value).every((key: any) => allowed.includes(key));
}

export function optionalText(value: any) {
  return value === undefined || typeof value === 'string';
}

export function localSchemaReferences(schema: any) {
  const pending = [schema];
  while (pending.length) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
    } else if (object(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) &&
            (typeof value !== 'string' || !value.startsWith('#'))) return false;
        pending.push(value);
      }
    }
  }
  return true;
}
