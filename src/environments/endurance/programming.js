const invalid = () => Object.assign(new Error('HOUR_PROGRAMMING_INVALID'), { code: 'HOUR_PROGRAMMING_INVALID' });

/** Trusted host contract. The verifier sees only the programming payload read
 * from the actual submitted artifact; the host never executes Bot code. */
export function createProgrammingContract(programming) {
  if (programming !== undefined && (typeof programming?.prompt !== 'function' || typeof programming?.verify !== 'function')) throw invalid();
  return Object.freeze({
    prompt(peer, stage) {
      if (!programming) return '';
      const text = programming.prompt({ peer, stage });
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 4096) throw invalid();
      return `\nProgramming task for peer=${peer} stage=${stage}: ${text}\nInclude the complete requested result as the programming field of this same JSON contribution. Implement and test the requested CLI in your private work directory; preserve the existing collaboration fields and work. Do not claim tests ran unless you actually ran them.`;
    },
    async verify(peer, stage, value) {
      if (!programming) return;
      if (!Object.hasOwn(value, 'programming')) throw invalid();
      let timer;
      try {
        const passed = await Promise.race([Promise.resolve().then(() => programming.verify({ peer, stage, submission: value.programming })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(invalid()), 5000); })]);
        if (passed !== true) throw invalid();
      } catch { throw invalid(); } finally { clearTimeout(timer); }
    },
  });
}
