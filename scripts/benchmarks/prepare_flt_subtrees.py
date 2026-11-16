#!/usr/bin/env python3
"""Build root-only FLT tasks using pinned Prove2Me Lean extraction tools.

Extraction facts and proof provenance are operator-private. Only the target,
statement foundation source and a neutral README enter the public manifest.
No proof search, model calls or formal benchmark launch occurs here.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
from build_flt10_statement_graph import source_imports

REPO = Path(__file__).resolve().parents[2]
TOOLS_REVISION = '79097e0d1fbab732ebf38ac23e7e5a700080c9c4'
SCORES = tuple(range(10, 101, 10))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def run(command, cwd, env=None, timeout=180):
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{command[0]} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}')
    return result.stdout


def subtract(source, spans):
    """Ranges come exclusively from the Lean parser, never declaration regexes."""
    for start, end in sorted(spans, reverse=True):
        if not 0 <= start <= end <= len(source):
            raise ValueError('invalid Lean source range')
        source = source[:start] + b'\n' + source[end:]
    return source


def closure(rows, target, spans):
    by_name = {row['name']: row for row in rows}
    needed = set()
    todo = list(by_name[target]['typeDeps'])
    while todo:
        name = todo.pop()
        if name in needed or name not in by_name:
            continue
        needed.add(name)
        row = by_name[name]
        todo.extend(row['typeDeps'] + row['valueDeps'])
        if row['kind'] == 'inductive':
            todo.extend(n for n, child in by_name.items() if child['kind'] == 'ctor' and n.startswith(name + '.'))
        # Elaborator instances can disappear from the final expression. Keep
        # instances only in participating statement modules, not the proof DAG.
        todo.extend(n for n, other in by_name.items() if other['module'] == row['module'] and other['isInstance'])
        for fact in spans.get(row['module'], []):
            if fact['kind'] == 'ref' and not any(
                d['declStart']['offset'] <= fact['start']['offset'] < d['declEnd']['offset']
                for d in spans[row['module']] if d['kind'] == 'decl'
            ):
                todo.append(fact['const'])
    if target in needed or any(by_name[n]['module'].startswith(('Theorems.', 'P2M.Sol.')) for n in needed):
        raise ValueError('statement foundation reaches the hidden proof subtree')
    return needed


def prepare_one(score, args, contract, config, spans):
    root = args.output / f'q{score}'
    private = root / 'private'
    source = root / 'source'
    lib = root / 'lib'
    for path in (private, source, lib):
        path.mkdir(parents=True)
    problem = next(p for p in config['problems'] if p['checkpoint'] == score)
    baseline = (REPO / f'benchmarks/flt10/q{score}/baseline/q{score}.lean').read_bytes()
    if digest(baseline) != problem['source_sha256']:
        raise ValueError('original root fixture changed')
    env = {**os.environ, 'LEAN_PATH': ':'.join([str(private), str(args.seed_lib), *args.dependency_roots])}
    (private / 'Root.lean').write_bytes(baseline)
    run([str(args.lean), '-j1', '-o', 'Root.olean', 'Root.lean'], private, env)
    extractor = (args.extractors / 'scripts/extract_decl_graph.lean').read_text()
    extractor = extractor.replace('import SumSquares', 'import Root').replace(
        'let isProj : Name → Bool := fun m => projPrefix.isPrefixOf m',
        'let isProj : Name → Bool := fun m => (`Definitions).isPrefixOf m || (`P2M).isPrefixOf m || m == `Root')
    extractor = extractor.replace('let env ← getEnv',
        f'let env ← getEnv\n  let some target := env.find? `{problem["declaration_name"]} | throwError "missing target"\n'
        '  IO.FS.writeFile "root-type.txt" (reprStr target.type)')
    (private / 'Extract.lean').write_text(extractor)
    run([str(args.lean), '-j1', 'Extract.lean'], private, env)
    original_type = (private / 'root-type.txt').read_bytes()
    rows = [json.loads(line) for line in (private / 'decl_graph.jsonl').read_text().splitlines()]
    write_json(private / 'original-declarations.json', rows)
    needed = closure(rows, problem['declaration_name'], spans)
    modules = {r['module'] for r in rows if r['name'] in needed}
    kept = {}
    for module in sorted(modules):
        path = Path(module.replace('.', '/') + '.lean')
        original = (args.source / path).read_bytes()
        if digest(original) != contract[str(score)]['sources'][path.as_posix()]:
            raise ValueError('source does not match the pinned seed foundation')
        selected = [r for r in rows if r['module'] == module and r['name'] in needed]
        remove = []
        for fact in spans[module]:
            if fact['kind'] != 'decl':
                continue
            if not any(fact['declStart']['line'] <= r['startLine'] <= fact['declEnd']['line'] and r['startLine'] > 0 for r in selected):
                remove.append((fact['declStart']['offset'], fact['declEnd']['offset']))
        reduced = subtract(original, remove).decode()
        # Source imports have already been parsed fail-closed by the pinned
        # graph reader. Their simple one-line headers are the only text rewrite.
        for imported in source_imports(reduced):
            if imported.startswith(('Definitions.', 'P2M.')) and imported not in modules:
                line = f'import {imported}\n'
                if reduced.count(line) != 1:
                    raise ValueError('unsupported import header; do not guess a rewrite')
                reduced = reduced.replace(line, '')
        destination = source / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(reduced)
        kept[path.as_posix()] = digest(destination.read_bytes())
    frontier = 'import Mathlib\n' + ''.join(f'import {m}\n' for m in sorted(modules))
    (source / 'FLTFoundation.lean').write_text(frontier)
    kept['FLTFoundation.lean'] = digest(frontier.encode())
    # Remove unused source-preamble openings. The actual elaborated root type
    # is compared below, so a change in name resolution fails preparation.
    target = baseline.decode().replace(f'import FLT10.DAG_q{score}', 'import FLTFoundation')
    if score != 90:
        target = target.replace('open CuspForm ModularFormClass UpperHalfPlane\n', '')
    if 'Definitions.Def_FLTPrelim_Modularity' not in modules:
        target = target.replace(' hiding card', '')
    public = args.output / 'public' / f'q{score}'
    public.mkdir(parents=True)
    (public / 'Target.lean').write_text(target)
    build_env = {**os.environ, 'LEAN_PATH': ':'.join([str(lib), *args.dependency_roots])}
    built = set()
    def compile_module(module):
        if module in built:
            return
        path = Path(module.replace('.', '/') + '.lean')
        for imported in source_imports((source / path).read_text()):
            if imported in modules:
                compile_module(imported)
        output = lib / path.with_suffix('.olean')
        output.parent.mkdir(parents=True, exist_ok=True)
        run([str(args.lean), '-j1', '-o', str(output), str(path)], source, build_env)
        built.add(module)
    compile_module('FLTFoundation')
    (private / 'Root.lean').write_text(target)
    env = {**build_env, 'LEAN_PATH': str(private) + ':' + build_env['LEAN_PATH']}
    diagnostic = run([str(args.lean), '-j1', '-o', 'Root.olean', 'Root.lean'], private, env)
    run([str(args.lean), '-j1', 'Extract.lean'], private, env)
    if (private / 'root-type.txt').read_bytes() != original_type:
        raise ValueError('root elaborated type changed during extraction')
    context = []
    for path in kept:
        data = (source / path).read_bytes()
        dest = public / 'foundation' / (path + '.txt')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        context.append({'path': 'benchmark/foundation/' + path + '.txt',
            'source_path': f'q{score}/foundation/{path}.txt', 'sha256': digest(data)})
    readme = (REPO / 'benchmarks/flt10/subtree-instructions.md').read_text().replace('{{target_path}}', f'q{score}/Target.lean')
    (public / 'README.md').write_text(readme)
    context.append({'path': 'benchmark/README.md', 'source_path': f'q{score}/README.md', 'sha256': digest(readme.encode())})
    license_data = (REPO / 'benchmarks/flt10/LICENSE').read_bytes()
    # Supply applicable notices without publishing the complete upstream
    # attribution table: that table itself inventories hidden proof modules.
    attribution = (REPO / 'benchmarks/flt10/ATTRIBUTION.md').read_text().splitlines()
    applicable = [line for line in attribution if any(line.startswith(f'| `{path}` |') for path in kept)]
    notice = ('# Source notices\n\nReduced source derived from Fermat\'s Last Theorem in Lean 4.\n'
        'Copyright 2026 Anthropic, PBC. Licensed under Apache License 2.0; see LICENSE.\n'
        'SwarmEnv has removed declarations not required by the selected statement foundation.\n'
        'Existing source-file copyright notices are retained. The following upstream\n'
        'attributions apply to the retained source files (some original content was removed).\n\n'
        '| File | Original relationship | Original source and authors |\n|---|---|---|\n' + '\n'.join(applicable) + '\n')
    for name, data in [('LICENSE', license_data), ('NOTICE.md', notice.encode())]:
        (public / name).write_bytes(data)
        context.append({'path': 'benchmark/' + name, 'source_path': f'q{score}/{name}', 'sha256': digest(data)})
    write_json(public / 'context-manifest.json', {'files': context})
    # This manifest is checker/operator input; it never appears in the public
    # Workspace. It binds the reduced source, including its proof-bearing basis.
    manifest = {'profile': 'flt10-subtree-v1', 'checkpoint': score, 'sources': kept,
        'root_type_sha256': digest(original_type), 'original_target_sha256': digest(baseline),
        'target_sha256': digest(target.encode()), 'declaration_name': problem['declaration_name'],
        'extractors_revision': TOOLS_REVISION}
    write_json(root / 'foundation-manifest.json', manifest)
    write_json(private / 'extraction.json', {'retained_declarations': sorted(needed),
        'initial_compilation': True, 'root_type_identical': True, 'diagnostic': diagnostic,
        'complete_witness': 'NOT_VALIDATED', 'formal_launch_allowed': False})
    result = {**problem, 'problem_file': f'q{score}/Target.lean', 'source_sha256': digest(target.encode()),
        'context_manifest': f'q{score}/context-manifest.json',
        'context_sha256': digest((public / 'context-manifest.json').read_bytes()),
        'readiness': 'requires_private_witness'}
    print(json.dumps({'checkpoint': score, 'foundation_modules': len(modules), 'retained_declarations': len(needed),
        'initial_compile': True, 'root_type_identical': True, 'witness': 'NOT_VALIDATED'}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'extractors', 'lean', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=4, choices=range(1, 5))
    parser.add_argument('--checkpoints', type=int, nargs='+', choices=SCORES, default=[20])
    args = parser.parse_args()
    args.checkpoints = sorted(set(args.checkpoints))
    for name in ('source', 'extractors', 'lean'):
        setattr(args, name, getattr(args, name).resolve(strict=True))
    args.output = args.output.absolute()
    if args.output.exists():
        raise ValueError('output already exists; use a fresh directory')
    if run(['git', 'rev-parse', 'HEAD'], args.extractors).strip() != TOOLS_REVISION or run(['git', 'status', '--porcelain'], args.extractors).strip():
        raise ValueError('Prove2Me extraction tools must be clean at the pinned revision')
    contract = json.loads((REPO / 'benchmarks/flt10/projection-contract.json').read_text())
    config = json.loads((REPO / 'config/flt10.json').read_text())
    if run(['git', 'rev-parse', 'HEAD'], args.source).strip() != 'aa2d8b34692b16c70f699536de0d8e75b9a3e9ef' or run(['git', 'status', '--porcelain', '--untracked-files=no'], args.source).strip():
        raise ValueError('FLT source must match the clean pinned checkout')
    packages = args.source / '.lake/packages'
    if run(['git', 'rev-parse', 'HEAD'], packages / 'mathlib').strip() != config['mathlib_version']:
        raise ValueError('Mathlib source revision differs')
    args.dependency_roots = [str(p / '.lake/build/lib/lean') for p in sorted(packages.iterdir()) if (p / '.lake/build/lib/lean').is_dir()]
    args.output.mkdir(parents=True, mode=0o700)
    facts = args.output / 'private-facts'
    facts.mkdir()
    seed_source = args.output / 'private-seed/source'
    args.seed_lib = args.output / 'private-seed/lib'
    seed_source.mkdir(parents=True)
    args.seed_lib.mkdir()
    originals = {p: h for score in args.checkpoints for p, h in contract[str(score)]['sources'].items()}
    for path, expected in originals.items():
        data = (args.source / path).read_bytes()
        if digest(data) != expected:
            raise ValueError('seed definition differs from the pinned source')
        dest = seed_source / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    for score in args.checkpoints:
        path = f'FLT10/DAG_q{score}.lean'
        (seed_source / path).parent.mkdir(exist_ok=True)
        (seed_source / path).write_text(contract[str(score)]['frontier'])
    env = {**os.environ, 'LEAN_PATH': ':'.join([str(args.seed_lib), *args.dependency_roots])}
    built = set()
    def build_seed(module):
        if module in built:
            return
        path = Path(module.replace('.', '/') + '.lean')
        for dep in source_imports((seed_source / path).read_text()):
            if (seed_source / (dep.replace('.', '/') + '.lean')).is_file():
                build_seed(dep)
        dest = args.seed_lib / path.with_suffix('.olean')
        dest.parent.mkdir(parents=True, exist_ok=True)
        run([str(args.lean), '-j1', '-o', str(dest), str(path)], seed_source, env)
        built.add(module)
    for score in args.checkpoints:
        build_seed(f'FLT10.DAG_q{score}')
    paths = sorted(p for p in originals if p.startswith('Definitions/'))
    def extract(path):
        module = path[:-5].replace('/', '.')
        data = run([str(args.lean), '-j1', '--run', str(args.extractors / 'scripts/extract_sketch_info.lean'), str(args.source / path)], facts, env)
        (facts / (module + '.jsonl')).write_text(data)
        return module, [json.loads(line) for line in data.splitlines()]
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        spans = dict(pool.map(extract, paths))
        problems = list(pool.map(lambda score: prepare_one(score, args, contract, config, spans), args.checkpoints))
    public = args.output / 'public'
    # A small dedicated fixture checkout pins only public task inputs, never
    # operator facts or reference proofs. Its Git history is not sent to Bots.
    run(['git', 'init', '-q'], public)
    run(['git', 'add', '.'], public)
    git_env = {**os.environ, 'GIT_AUTHOR_DATE': '2000-01-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2000-01-01T00:00:00Z'}
    run(['git', '-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'Pin root-only FLT inputs'], public, git_env)
    config.update(benchmark='flt10-subtree-v1', environment_ref='flt10-subtree-v1', fixture_commit=run(['git', 'rev-parse', 'HEAD'], public).strip(),
        benchmark_context_root=str(public), problems=problems, instructions_path='benchmark/README.md', validation_required=True)
    write_json(args.output / 'benchmark-config.json', config)


if __name__ == '__main__':
    main()
