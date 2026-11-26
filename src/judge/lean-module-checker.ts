import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDriver = fileURLToPath(new URL('./lean-module-build.lean', import.meta.url));
const verificationDriver = fileURLToPath(new URL('./lean-module-verify.lean', import.meta.url));

// Only header parsing runs here; candidate elaborators and initializers never run.
const importParser = `import Lean
open Lean
def main (args : List String) : IO UInt32 := do
  for path in args do
    let (imports, _, messages) ← Lean.Elab.parseImports (← IO.FS.readFile path) (some path)
    let errors ← if messages.hasErrors then
      messages.toArray.mapM fun message => message.toString
      else pure #[]
    IO.println (Json.compress (Json.mkObj [("path", toJson path),
      ("imports", toJson (imports.map fun i => i.module.toString)), ("errors", toJson errors)]))
  return 0
`;
const hash = (value: any) => createHash('sha256').update(value).digest('hex');
const suffixes = ['olean', 'olean.private', 'olean.server'];

/** Host-owned, bounded, process-local cache; no candidate path is a cache root. */
export class LeanModuleChecker {
  declare libraryPaths: any;
  declare memoryArgument: any;
  declare cacheBytes: any;
  declare environmentKey: any;
  declare sandbox: any;
  declare execute: any;
  declare classify: any;

  #cache: any = new Map<any, any>();
  #bytes: any = 0;

  constructor({ cacheBytes = 128 * 1024 ** 2, environmentKey, sandbox, execute, classify }: any) {
    if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0 || cacheBytes > 1024 ** 3) throw new TypeError('Invalid Lean module cache byte limit');
    Object.assign(this, { cacheBytes, environmentKey, sandbox, execute, classify });
  }

  #get(key: any) {
    const entry = this.#cache.get(key);
    if (entry) { this.#cache.delete(key); this.#cache.set(key, entry); }
    return entry;
  }

  #put(key: any, artifacts: any, warnings: any) {
    const bytes = artifacts.reduce((sum: any, file: any) => sum + file.bytes.length, 0);
    if (!this.cacheBytes || bytes > this.cacheBytes) return;
    const old = this.#cache.get(key);
    if (old) this.#bytes -= old.bytes;
    this.#cache.delete(key);
    while (this.#bytes + bytes > this.cacheBytes) {
      const [oldKey, oldEntry] = this.#cache.entries().next().value;
      this.#bytes -= oldEntry.bytes;
      this.#cache.delete(oldKey);
    }
    this.#cache.set(key, { bytes, artifacts, warnings });
    this.#bytes += bytes;
  }

  async check({ files, sources, path, missionId, tree, budget, startProcess = (launch: any) => launch() }: any) {
    if (typeof missionId !== 'string' || !missionId) throw new TypeError('Module cache requires the bound Mission identity');
    const selected = sources.find((source: any) => source.path === path);
    if (!selected) throw new TypeError('Module check requires one configured Lean source path');
    const directory = await mkdtemp(join(tmpdir(), 'murm-module-check-'));
    const stats = { hits: 0, misses: 0, stored_bytes: 0, byte_limit: this.cacheBytes };
    const result = (verdict: any, diagnostic: any, extra: any = {}) => ({ verdict, diagnostic, checked_tree: tree,
      checked_paths: [], scope: 'module', requested_path: path, cache: { ...stats, stored_bytes: this.#bytes }, ...extra });
    try {
      for (const source of sources) {
        const output = join(directory, source.sourcePath);
        await mkdir(join(output, '..'), { recursive: true });
        await writeFile(output, files[source.path], { signal: budget.signal });
      }
      await writeFile(join(directory, 'Imports.lean'), importParser);
      const parserArgs = this.sandbox();
      parserArgs.push('--ro-bind', directory, '/input', '--chdir', '/input',
        '/toolchain/bin/lean', '-j1', '--run', '/input/Imports.lean', ...sources.map((source: any) => `/input/${source.sourcePath}`));
      const parsed = await startProcess(() => this.execute(parserArgs, { ...budget, maxOutput: 4 * 1024 ** 2 }));
      if (parsed.code !== 0) return result('ERROR', 'Locked Lean import-header parsing did not complete');
      const byModule = new Map<any, any>(sources.map((source: any) => [source.module, source]));
      const graph = new Map<any, any>();
      const headerErrors = new Map<any, any>();
      for (const line of parsed.output.toString().trim().split('\n')) {
        const entry = JSON.parse(line);
        const source = sources.find((candidate: any) => `/input/${candidate.sourcePath}` === entry.path);
        if (!source || !Array.isArray(entry.imports) || entry.imports.some((name: any) => typeof name !== 'string') || graph.has(source.module)) {
          throw new Error('Invalid locked Lean import graph');
        }
        graph.set(source.module, entry.imports.filter((name: any) => byModule.has(name)));
        headerErrors.set(source.module, entry.errors ?? []);
      }
      if (graph.size !== sources.length) throw new Error('Incomplete locked Lean import graph');
      const visiting = new Set();
      const keys = new Map<any, any>();
      const ordered: any[] = [];
      const visit = (module: any) => {
        if (keys.has(module)) return keys.get(module);
        if (visiting.has(module)) throw new TypeError('Lean project imports contain a cycle');
        if (headerErrors.get(module).length) throw new TypeError(headerErrors.get(module).join('\n').slice(0, 2048));
        visiting.add(module);
        const dependencies = graph.get(module).map((name: any) => [name, visit(name)]);
        const source = byModule.get(module);
        const key = hash(JSON.stringify([missionId, this.environmentKey, module, hash(files[source.path]), dependencies]));
        visiting.delete(module);
        keys.set(module, key);
        ordered.push(source);
        return key;
      };
      visit(selected.module);
      const cacheDirectory = join(directory, 'dependencies');
      await mkdir(cacheDirectory);
      const warnings: any[] = [];
      const builtArtifacts = new Map<any, any>();
      let materializedBytes = 0;
      for (const source of ordered) {
        if (budget.signal?.aborted || budget.deadline <= Date.now()) throw new Error('Lean module check deadline elapsed');
        const key = keys.get(source.module);
        const cached = this.#get(key);
        let artifacts = cached?.artifacts;
        let moduleWarnings = cached?.warnings ?? [];
        if (artifacts) stats.hits++;
        else {
          stats.misses++;
          const args = this.sandbox();
          const required = new Set<string>();
          const include = (module: any) => { for (const dependency of graph.get(module)) if (!required.has(dependency)) { required.add(dependency); include(dependency); } };
          include(source.module);
          const dependencyMounts: any[] = [];
          for (const dependency of required) {
            const artifacts = builtArtifacts.get(dependency);
            for (const artifact of artifacts) {
              const relative = `${dependency.replaceAll('.', '/')}.${artifact.suffix}`;
              dependencyMounts.push('--ro-bind', join(cacheDirectory, relative), `/cache/${relative}`);
            }
          }
          args.push('--ro-bind', join(directory, source.sourcePath), `/input/${source.sourcePath}`,
            '--size', '268435456', '--tmpfs', '/cache', ...dependencyMounts, '--remount-ro', '/cache',
            '--size', '268435456', '--tmpfs', '/output',
            '--ro-bind', buildDriver, '/driver/Build.lean', '--ro-bind', '/usr/bin/dash', '/bin/sh',
            '--ro-bind', '/usr/bin/mkdir', '/bin/mkdir', '--ro-bind', '/usr/bin/base64', '/bin/base64',
            '--setenv', 'LEAN_PATH', ['/cache', ...this.libraryPaths].join(':'), '--chdir', '/input',
            '/bin/sh', '-eu', '-c',
            'ulimit -c 0\n/bin/mkdir -p "/output/${1%/*}"\n' +
            ' /toolchain/bin/lean -j1 "$3" --run /driver/Build.lean "$2" "$4" "/output/$1.olean" "$5" >&2 || { status=$?; if [ "$status" = 21 ]; then exit 21; fi; exit 23; }\n' +
            'for suffix in olean olean.private olean.server; do if [ -f "/output/$1.$suffix" ] && [ ! -L "/output/$1.$suffix" ]; then printf "%s\\n" "$suffix"; /bin/base64 -w0 "/output/$1.$suffix"; printf "\\n"; fi; done',
            'murm-module', source.module.replaceAll('.', '/'), `/input/${source.sourcePath}`, this.memoryArgument, source.module, key);
          const built = await startProcess(() => this.execute(args, { ...budget, maxOutput: 192 * 1024 ** 2 }));
          const diagnostic = this.classify(built.stderr);
          if (built.code !== 0) {
            if (built.code === 21 && diagnostic) return result(diagnostic.diagnostic_code ? 'ERROR' : 'FAIL', diagnostic.diagnostic,
              diagnostic.diagnostic_code ? { diagnostic_code: diagnostic.diagnostic_code, checker_process_status: 'completed', retryable: false } : {});
            return result('ERROR', 'Locked Lean module build did not complete');
          }
          if (built.stderrTruncated) return result('ERROR', 'Lean module diagnostics exceeded the retained bound');
          const lines = built.output.toString().trimEnd().split('\n');
          artifacts = [];
          for (let index = 0; index < lines.length; index += 2) {
            if (!suffixes.includes(lines[index]) || !/^[A-Za-z0-9+/]*={0,2}$/.test(lines[index + 1] ?? '') || artifacts.some((file: any) => file.suffix === lines[index])) {
              return result('ERROR', 'Malformed Lean module artifacts', { diagnostic_code: 'module_verification_failed', retryable: false });
            }
            artifacts.push({ suffix: lines[index], bytes: Buffer.from(lines[index + 1], 'base64') });
          }
          if (!artifacts.some((file: any) => file.suffix === 'olean' && file.bytes.length)) return result('ERROR', 'Missing Lean module artifact', { diagnostic_code: 'module_verification_failed', retryable: false });
          // execute resolves only after the cgroup and descendants have settled.
          if (budget.signal?.aborted) throw new Error('Lean module check aborted');
          moduleWarnings = built.stderr.split('\n').flatMap((line: any) => {
            try { const message = JSON.parse(line); return message.severity === 'warning' ? [String(message.data).slice(0, 320)] : []; }
            catch { return []; }
          }).slice(0, 8);
          const verificationDirectory = join(directory, 'verification', source.module.replaceAll('.', '/'));
          await mkdir(verificationDirectory, { recursive: true });
          for (const artifact of artifacts) {
            await writeFile(join(verificationDirectory, `module.${artifact.suffix}`), artifact.bytes);
          }
          const verificationArgs = this.sandbox();
          verificationArgs.push('--ro-bind', verificationDriver, '/driver/Verify.lean',
            '--size', '268435456', '--tmpfs', '/cache', ...dependencyMounts, '--remount-ro', '/cache',
            '--ro-bind', verificationDirectory, '/module',
            '--setenv', 'LEAN_PATH', ['/cache', ...this.libraryPaths].join(':'), '--chdir', '/module',
            '/toolchain/bin/lean', '-j1', this.memoryArgument, '--run', '/driver/Verify.lean',
            '/module/module.olean', source.module, key);
          const verified = await startProcess(() => this.execute(verificationArgs, { ...budget, maxOutput: 8192 }));
          let validation;
          try {
            validation = JSON.parse(verified.output.toString().trim());
          } catch {
            // An incomplete verifier response cannot authorize artifact reuse.
          }
          if (verified.code !== 0 || validation?.status !== 'verified') {
            return result('ERROR', 'Lean module artifact did not pass independent completion and kernel verification', {
              diagnostic_code: 'module_verification_failed', checker_process_status: 'completed', retryable: false,
            });
          }
          for (const name of validation.axioms ?? []) {
            moduleWarnings.push(`Module declares axiom ${name}`);
          }
          this.#put(key, artifacts, moduleWarnings);
        }
        builtArtifacts.set(source.module, artifacts);
        warnings.push(...moduleWarnings);
        for (const artifact of artifacts) {
          materializedBytes += artifact.bytes.length;
          if (materializedBytes > 256 * 1024 ** 2) throw new Error('Lean module dependency artifacts exceed the bounded job limit');
          const output = join(cacheDirectory, `${source.module.replaceAll('.', '/')}.${artifact.suffix}`);
          await mkdir(join(output, '..'), { recursive: true });
          await writeFile(output, artifact.bytes, { flag: 'wx', mode: 0o400 });
        }
      }
      return result('PASS', null, { checked_paths: ordered.map((source: any) => source.path), warnings });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
