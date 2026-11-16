#!/usr/bin/env python3
"""Prepare FLT10 benchmark inputs for SwarmEnv; never launch research Agents.

Only the public statement graph and safe definition closure cross the benchmark
boundary. ContextSwarm's orchestration, Judge and provider setup are not used.
"""
import argparse
import hashlib
import json
import lzma
import os
from pathlib import Path
import shutil
import subprocess

from build_flt10_statement_graph import build_statement_graph, TARGET_MODULES, is_project_module, is_proof_module

SOURCE_REVISION = 'aa2d8b34692b16c70f699536de0d8e75b9a3e9ef'
MATHLIB_REVISION = 'db584cd6d46c92f209a44c0f1c829460d327499d'
FRAMEWORK_SHA256 = '9b04c849247cf72c29ab84dbf941f3ea21fa4eeaa77c7d4b1af0d95550dca987'
REPO = Path(__file__).resolve().parents[2]


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def closure(graph, imports):
    result = []
    active = set()
    seen = set()
    def visit(module):
        if not is_project_module(module):
            return
        if is_proof_module(module) or module.startswith('FLT10.'):
            raise ValueError(f'proof module in public frontier: {module}')
        if module in active:
            raise ValueError(f'cyclic definition imports: {module}')
        if module in seen:
            return
        active.add(module)
        for dep in graph['nodes'][module]['imports']:
            visit(dep)
        active.remove(module)
        seen.add(module)
        result.append(module)
    for module in imports:
        visit(module)
    return result


def write_context_manifests(output):
    """Bind portable public context to each problem; no host configuration leaks."""
    config = json.loads((REPO / 'config/flt10.json').read_text())
    contracts = json.loads((REPO / 'benchmarks/flt10/projection-contract.json').read_text())
    for problem in config['problems']:
        score = problem['checkpoint']
        project = output / f'q{score}'
        cut = (project / 'dag-cut-manifest.json').read_bytes()
        if sha(cut) != contracts[str(score)]['cut_sha256']:
            raise ValueError('generated cut differs from reviewed benchmark contract')
        (project / 'dag-cut-manifest.json.xz').write_bytes(lzma.compress(cut))
        files = []
        def add(path, source):
            data = source.read_bytes()
            if len(data) > 2 * 1024 * 1024:
                raise ValueError('public context file exceeds Workspace limit')
            files.append({'path': path, 'source_path': source.relative_to(output).as_posix(), 'sha256': sha(data)})
        for source in sorted((output / 'public').iterdir()):
            add(f'benchmark/{source.name}', source)
        add('benchmark/dag-cut-manifest.json.xz', project / 'dag-cut-manifest.json.xz')
        for path in contracts[str(score)]['sources']:
            add(f'benchmark/definitions/{path}.txt', project / 'source' / path)
        instructions = (REPO / f'benchmarks/flt10/q{score}/problem.md').read_text()
        instructions += f'\n## SwarmEnv input\n\nThe fixed target file is `{problem["problem_file"]}`. '
        instructions += 'Only replace its proof placeholder; keep its imports and theorem statement. '
        instructions += 'Use the existing Workspace and Judge commands for all compilation and verification.\n\n'
        instructions += 'The complete public statement graph is compressed in independent shards. Query it with '
        instructions += '`python3 benchmark/read_context.py FreyPackage --limit 20`. '
        instructions += 'Inspect the cut with `python3 benchmark/read_context.py --cut FreyPackage --limit 20`. '
        instructions += 'Retained definition source text is in `benchmark/definitions/`; it is reference material, not editable trusted libraries. '
        instructions += 'Compressed references need not be extracted onto the Bot disk.\n'
        (project / 'README.md').write_text(instructions)
        add('benchmark/README.md', project / 'README.md')
        if sum((output / f['source_path']).stat().st_size for f in files) > 14 * 1024 * 1024:
            raise ValueError('public references exceed reserved Workspace capacity')
        manifest = encode({'source_revision': SOURCE_REVISION, 'checkpoint': score, 'files': files})
        (project / 'context-manifest.json').write_bytes(manifest)
        problem['context_manifest'] = f'q{score}/context-manifest.json'
        problem['context_sha256'] = sha(manifest)
    config['benchmark_context_root'] = str(output)
    (output / 'benchmark-config.json').write_text(json.dumps(config, indent=2) + '\n')


def prepare(args):
    source = args.source.resolve(strict=True)
    output = args.output.absolute()
    if output.exists():
        raise ValueError('output already exists; use a fresh directory')
    if git(source, 'rev-parse', 'HEAD') != SOURCE_REVISION or git(source, 'status', '--porcelain', '--untracked-files=no'):
        raise ValueError('FLT source must be the clean pinned checkout')
    packages = source / '.lake/packages'
    if git(packages / 'mathlib', 'rev-parse', 'HEAD') != MATHLIB_REVISION:
        raise ValueError('unexpected Mathlib revision')
    graph = build_statement_graph(source, TARGET_MODULES, source_revision=SOURCE_REVISION)
    if sha(encode(graph['framework'])) != FRAMEWORK_SHA256:
        raise ValueError('public statement graph differs from the pinned source graph')
    output.mkdir(parents=True)
    public = output / 'public'
    public.mkdir()
    # Independent compressed shards keep the full graph below Workspace limits
    # and let the reader query it without inflating 169 MB onto the Bot disk.
    shard = {}
    shard_bytes = 0
    shards = []
    def flush():
        nonlocal shard, shard_bytes
        if not shard:
            return
        name = f'framework-{len(shards):04d}.json.xz'
        data = lzma.compress(encode(shard), preset=6)
        (public / name).write_bytes(data)
        shards.append({'path': name, 'sha256': sha(data), 'bytes': len(data), 'modules': len(shard)})
        shard = {}
        shard_bytes = 0
    for name, node in sorted(graph['framework']['nodes'].items()):
        size = len(encode(node))
        if shard_bytes + size > 2_000_000:
            flush()
        shard[name] = node
        shard_bytes += size
    flush()
    (public / 'framework-index.json').write_bytes(encode({'source_revision': SOURCE_REVISION,
        'metadata_sha256': graph['metadata_sha256'], 'module_count': len(graph['framework']['nodes']), 'shards': shards}))
    shutil.copyfile(REPO / 'benchmarks/flt10/read_context.py', public / 'read_context.py')
    total = sum(p.stat().st_size for p in public.iterdir())
    if total > 14 * 1024 * 1024:
        raise ValueError(f'compressed public graph exceeds reserved Workspace capacity: {total}')
    library_paths = [str((p / '.lake/build/lib/lean').resolve()) for p in sorted(packages.iterdir())
                     if (p / '.lake/build/lib/lean').is_dir()]
    contracts = {}
    for score, cut in graph['cuts'].items():
        modules = closure(graph['framework'], cut['compiled_frontier_imports'])
        frontier = ''.join(f'import {name}\n' for name in cut['compiled_frontier_imports'])
        contracts[score] = {'checkpoint': int(score), 'source_revision': SOURCE_REVISION,
            'cut': cut, 'sources': {graph['framework']['nodes'][m]['path']: graph['framework']['nodes'][m]['source_sha256'] for m in modules},
            'frontier': frontier, 'frontier_sha256': sha(frontier.encode())}
        project = output / f'q{score}'
        lib = project / 'lib'
        src = project / 'source'
        src.mkdir(parents=True)
        lib.mkdir()
        (project / 'dag-cut-manifest.json').write_bytes(encode(cut))
        for module in modules:
            path = Path(module.replace('.', '/') + '.lean')
            data = (source / path).read_bytes()
            if sha(data) != contracts[score]['sources'][path.as_posix()]:
                raise ValueError('source changed during projection')
            (src / path).parent.mkdir(parents=True, exist_ok=True)
            (src / path).write_bytes(data)
        frontier_path = Path(f'FLT10/DAG_q{score}.lean')
        (src / frontier_path).parent.mkdir(parents=True, exist_ok=True)
        (src / frontier_path).write_text(frontier)
        if not args.no_build:
            for module in [*modules, f'FLT10.DAG_q{score}']:
                path = Path(module.replace('.', '/'))
                artifact = lib / path.with_suffix('.olean')
                artifact.parent.mkdir(parents=True, exist_ok=True)
                result = subprocess.run([str(args.lean.resolve()), '-j1', '-o', str(artifact), str(path.with_suffix('.lean'))],
                    cwd=src, env={**os.environ, 'LEAN_PATH': ':'.join([str(lib), *library_paths])},
                    capture_output=True, text=True, timeout=180)
                if result.returncode:
                    (project / 'build-error.log').write_text(result.stdout + result.stderr)
                    raise ValueError(f'frontier build failed for q{score}: {module}; inspect local build-error.log')
        print(json.dumps({'checkpoint': int(score), 'safe_modules': len(modules), 'compiled': not args.no_build}), flush=True)
    for contract in contracts.values():
        contract['cut_sha256'] = sha(encode(contract.pop('cut')))
    approved = json.loads((REPO / 'benchmarks/flt10/projection-contract.json').read_text())
    if contracts != approved:
        raise ValueError('source projection differs from reviewed benchmark contract')
    (output / 'projection-contract.json').write_bytes(encode(contracts))
    write_context_manifests(output)
    print(json.dumps({'output': str(output), 'public_bytes': total, 'shards': len(shards)}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--lean', type=Path, required=True)
    parser.add_argument('--no-build', action='store_true', help='prepare source and metadata only; not a runnable checker')
    prepare(parser.parse_args())
