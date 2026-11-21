const rawStringStart = /r(#*)"/y;
const characterLiteral = /'(?:[^'\\]|\\(?:x[\da-fA-F]{2}|u[\da-fA-F]{4}|[^\n]))'/uy;
const identifierCharacter = /[\p{L}\p{N}\p{M}_'!?.»]/u;
const completeProofWords = /\b(?:sorry|sorryAx|admit|axiom)\b/;

function quotedStringEnd(source, start) {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '"') return index + 1;
    // An interpolator can enter term syntax here and use nested quotes.
    // The surrounding grammar can introduce interpolators with any name.
    if (source[index] === '{') return -1;
    if (source[index] === '\\') index++;
  }
  return -1;
}

function blockCommentEnd(source, start) {
  let depth = 1;
  for (let index = start + 2; index < source.length; index++) {
    const pair = source.slice(index, index + 2);
    if (pair === '/-') {
      depth++;
      index++;
    } else if (pair === '-/') {
      depth--;
      if (depth === 0) return index + 2;
      index++;
    }
  }
  return -1;
}

// Scan for policy words outside Lean comments. Keep strings and quoted names
// subject to the existing word policy, but never read their contents as comments.
// Fall back to the literal policy at unfamiliar or unclosed quoting syntax.
export function leanSourcePolicyFinding(source, words = completeProofWords) {
  source = String(source);
  let start = 0;
  function find(end) {
    const match = words.exec(source.slice(start, end));
    if (!match) return null;
    const offset = start + match.index;
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    const line = source.slice(0, lineStart).split('\n').length;
    const column = [...source.slice(lineStart, offset)].length + 1;
    return { word: match[0], line, column };
  }
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    if (pair === '--' || pair === '/-') {
      const finding = find(index);
      if (finding) return finding;
      const end = pair === '--' ? source.indexOf('\n', index + 2) : blockCommentEnd(source, index);
      if (end === -1) return pair === '--' ? null : find(source.length);
      start = index = end;
      continue;
    }
    if (char === '"') {
      const end = quotedStringEnd(source, index);
      if (end === -1) return find(source.length);
      index = end;
      continue;
    }
    if (char === '«') {
      const end = source.indexOf('»', index + 1);
      if (end === -1) return find(source.length);
      index = end + 1;
      continue;
    }
    if (char === 'r' && !identifierCharacter.test(source[index - 1] ?? '')) {
      rawStringStart.lastIndex = index;
      const raw = rawStringStart.exec(source);
      if (raw) {
        const suffix = `"${raw[1]}`;
        const end = source.indexOf(suffix, rawStringStart.lastIndex);
        if (end === -1) return find(source.length);
        index = end + suffix.length;
        continue;
      }
    }
    if (char === "'" && !identifierCharacter.test(source[index - 1] ?? '')) {
      characterLiteral.lastIndex = index;
      if (characterLiteral.test(source)) {
        index = characterLiteral.lastIndex;
        continue;
      }
    }
    index++;
  }
  return find(source.length);
}
