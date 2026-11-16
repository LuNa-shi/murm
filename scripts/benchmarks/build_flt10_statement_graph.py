#!/usr/bin/env python3
"""Build metadata for a FLT statement/import graph and proof-cone cuts.

The input is a pinned checkout containing the FLT source modules.  The output
is JSON metadata only: source module names, import edges, declaration headers,
source hashes, and per-target proof-cone cut manifests.  This command never
copies, rewrites, or emits Lean source.  In particular, theorem and P2M proof
bodies remain in the operator's source checkout and are represented only by
hashes and statement headers in the metadata.

The cut is the same boundary used by the Prove2yourselves FLT10bench: the
complete statement/import graph is retained as navigational metadata, while a
target theorem and every project proof module reachable below it are removed
from the compilable frontier.  A caller still needs to apply the frontier to a
separate Lean projection; this builder deliberately does not materialize that
projection.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import subprocess
from typing import Any, Iterable, Mapping

PROJECT_NAMESPACES = ("FLT10", "Definitions", "Theorems", "P2M")
PROJECT_PREFIXES = tuple(f"{name}." for name in PROJECT_NAMESPACES)

# These are the public FLT10bench target modules.  The builder also accepts
# arbitrary target specifications, so a future source revision can use the
# same metadata format without editing this script.
TARGETS = {
    10: "FreyPackage_of_counterexample",
    20: "FreyPackage_frey_reducible_hasCofixedLine",
    30: "WeierstrassCurve_exists_atP_filtration_of_multiplicativeReduction",
    40: "WeierstrassCurve_exists_quotientDatum_of_galois_stable_primeCard",
    50: "WeierstrassCurve_mazurStepThree_not_inZeroComponentAt",
    60: "FreyPackage_frey_no_cofixed_large",
    70: "FreyPackage_Mazur_Frey",
    80: "FreyPackage_frey_isModular",
    90: "FreyPackage_level_lowering_to_two",
    100: "fermat_last_theorem",
}
TARGET_MODULES = {
    score: ("Theorems.Thm_fermat_last_theorem" if score == 100
            else f"Theorems.Thm_{target}")
    for score, target in TARGETS.items()
}
STATEMENT_CONTEXT_MODULES: dict[int, tuple[str, ...]] = {
    30: ("Definitions.Def_FLTPrelim_Modularity",),
    40: ("Definitions.Def_FLTPrelim_Modularity",),
}
SCHEMA_VERSION = "contextswarm_flt10_statement_graph_v1"
FRAMEWORK_SCHEMA_VERSION = "contextswarm_flt10_framework_graph_v1"
MANIFEST_SCHEMA_VERSION = "contextswarm_flt10_dag_cut_v1"
DAG_PREFIX = "FLT10.DAG_q"


class GraphBuildError(RuntimeError):
    """Raised when a source graph cannot be safely indexed or cut."""


def _header_line(raw: str, depth: int) -> tuple[str, int]:
    """Strip Lean line/block comments while respecting quoted strings."""
    output: list[str] = []
    index = 0
    quoted = False
    while index < len(raw):
        if depth:
            if raw.startswith("/-", index):
                depth += 1
                index += 2
            elif raw.startswith("-/", index):
                depth -= 1
                index += 2
            else:
                index += 1
            continue
        if not quoted and raw.startswith("/-", index):
            depth = 1
            index += 2
        elif not quoted and raw.startswith("--", index):
            break
        else:
            char = raw[index]
            output.append(char)
            if char == '"' and (index == 0 or raw[index - 1] != "\\"):
                quoted = not quoted
            index += 1
    return "".join(output), depth


_MODULE_NAME = r"[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*"


def source_imports(source: str) -> list[str]:
    """Parse Lean import headers, failing closed on unsupported syntax.

    Only the module names are retained.  Imports from Mathlib or other
    external packages remain as edge labels, while only modules under the
    four project namespaces become graph nodes.
    """
    imports: list[str] = []
    continuation = False
    depth = 0
    for raw in source.splitlines():
        raw, depth = _header_line(raw, depth)
        if depth:
            continue
        line = raw.strip()
        if not line or line in {"module", "prelude"}:
            continue
        match = re.fullmatch(r"(?:(?:public|private|meta)\s+)*import(?:\s+(.*))?", line)
        if match:
            names = (match.group(1) or "").split()
            continuation = not names
            if any(not re.fullmatch(_MODULE_NAME, name) for name in names):
                raise GraphBuildError(f"unsupported import syntax: {line}")
            imports.extend(names)
        elif continuation and re.fullmatch(_MODULE_NAME, line):
            imports.append(line)
            continuation = False
        else:
            # Imports are required to precede declarations in the source graph.
            # Once a non-header line is reached there can be no continuation.
            continuation = False
            break
    if depth:
        raise GraphBuildError("unterminated comment in source import header")
    if continuation:
        raise GraphBuildError("incomplete source import header")
    return imports


def canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def module_path(root: Path, module: str) -> Path:
    return root / (module.replace(".", "/") + ".lean")


def is_project_module(module: str) -> bool:
    return module in PROJECT_NAMESPACES or module.startswith(PROJECT_PREFIXES)


def is_proof_module(module: str) -> bool:
    return module.startswith("Theorems.") or module.startswith("P2M.Sol.")


def _body_start(segment: str) -> int | None:
    """Find a top-level declaration assignment, ignoring type delimiters."""
    depth = 0
    quoted = False
    index = 0
    while index < len(segment):
        char = segment[index]
        if char == '"' and (index == 0 or segment[index - 1] != "\\"):
            quoted = not quoted
            index += 1
            continue
        if quoted:
            index += 1
            continue
        if segment.startswith("/-", index):
            end = segment.find("-/", index + 2)
            if end < 0:
                return None
            index = end + 2
            continue
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth = max(0, depth - 1)
        elif depth == 0 and segment.startswith(":=", index):
            return index
        index += 1
    return None


_DECLARATION = re.compile(
    r"(?m)^(?:(private|protected|scoped)\s+)?"
    r"(theorem|lemma|opaque|def|abbrev|structure|class|inductive|instance)"
    r"(?:\s+([A-Za-z_][A-Za-z0-9_'.]*))?"
)


def statement_headers(source: str) -> list[dict[str, str | None]]:
    """Extract bounded declaration headers without retaining values/bodies."""
    matches = list(_DECLARATION.finditer(source))
    declarations: list[dict[str, str | None]] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = len(source) if index + 1 == len(matches) else matches[index + 1].start()
        segment = source[start:end]
        assignment = _body_start(segment)
        where = segment.find(" where")
        positions = [
            position for position in (assignment, where)
            if position is not None and position >= 0
        ]
        if positions:
            segment = segment[:min(positions)]
        header = " ".join(segment.split())
        # Match Prove2yourselves' canonical `_statement_headers` contract:
        # remove the top-level declaration body, while retaining proof-valued
        # terms nested inside the declaration type.  Those terms are metadata
        # only and never enter the Lean projection; changing them here would
        # give ContextSwarm a stricter information surface than its baseline.
        if len(header) > 8192:
            header = header[:8192] + " …"
        declarations.append({
            "kind": match.group(2),
            "name": match.group(3),
            "visibility": match.group(1),
            "statement": header,
        })
    return declarations


def proof_bearing_definition(source: Path) -> bool:
    """Mark Definitions modules that contain proof-bearing declarations."""
    text = source.read_text(encoding="utf-8")
    return bool(re.search(r"(?m)^\s*(?:theorem|lemma|opaque|axiom|instance)\b", text))


def _lean_files(root: Path) -> Iterable[Path]:
    # SwarmEnv migration: only committed fixture files are public inputs.
    # A clean tracked tree does not rule out untracked or ignored proof files.
    entries = subprocess.check_output([
        'git', '--no-replace-objects', '-C', str(root),
        'ls-tree', '-r', '--name-only', '-z', 'HEAD',
    ]).decode('utf-8').split('\0')
    for name in entries:
        if name.endswith('.lean'):
            path = root / name
            if path.resolve() != path or not path.is_file():
                raise GraphBuildError(f'non-regular committed source: {name}')
            yield path


def framework_graph(root: Path) -> dict[str, Any]:
    """Index project modules as statement/import metadata only."""
    root = root.expanduser().resolve()
    if not root.is_dir() or root.is_symlink():
        raise GraphBuildError(f"source root is not a regular directory: {root}")
    nodes: dict[str, dict[str, Any]] = {}
    for path in sorted(_lean_files(root)):
        relative = path.relative_to(root)
        module = relative.with_suffix("").as_posix().replace("/", ".")
        if not is_project_module(module):
            continue
        try:
            source = path.read_text(encoding="utf-8")
            imports = source_imports(source)
            declarations = statement_headers(source)
        except (OSError, UnicodeError, GraphBuildError) as exc:
            raise GraphBuildError(f"cannot index source module {module}: {exc}") from exc
        declaration_count = len(declarations)
        # Solution files often contain private helper declarations.  Retain
        # only their public solution statement for navigation metadata.
        if module.startswith("P2M.Sol."):
            declarations = [
                item for item in declarations
                if item.get("name") == "solution" and not item.get("visibility")
            ]
        nodes[module] = {
            "module": module,
            "path": relative.as_posix(),
            "imports": imports,
            "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "source_bytes": path.stat().st_size,
            "proof_module": is_proof_module(module),
            "declaration_count": declaration_count,
            "declarations": declarations,
        }
    return {
        "schema_version": FRAMEWORK_SCHEMA_VERSION,
        "source_root": "repository-local",
        "module_count": len(nodes),
        "nodes": nodes,
    }


def proof_dependency_cone(root: Path, start: str) -> set[str]:
    """Walk project imports reachable from a target module."""
    pending = [start]
    seen: set[str] = set()
    while pending:
        module = pending.pop()
        if module in seen:
            continue
        source = module_path(root, module)
        if not source.is_file():
            raise GraphBuildError(f"DAG source module is missing: {module}")
        seen.add(module)
        try:
            imports = source_imports(source.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, GraphBuildError) as exc:
            raise GraphBuildError(f"cannot read imports from {module}: {exc}") from exc
        pending.extend(imported for imported in imports if is_project_module(imported))
    return seen


def _target_theorem(graph: Mapping[str, Any], module: str) -> str | None:
    for declaration in graph.get("nodes", {}).get(module, {}).get("declarations", []):
        name = declaration.get("name")
        if name:
            return str(name)
    return None


def target_cut_manifest(
    root: Path,
    score: int | str,
    target: str,
    *,
    graph: Mapping[str, Any] | None = None,
    statement_context_imports: Iterable[str] = (),
) -> dict[str, Any]:
    """Describe the target proof-cone cut without rendering Lean files."""
    root = root.expanduser().resolve()
    graph = graph or framework_graph(root)
    target_path = module_path(root, target)
    if not target_path.is_file():
        raise GraphBuildError(f"target theorem source is missing: {target}")
    cone = proof_dependency_cone(root, target)
    proof_cone = sorted(module for module in cone if is_proof_module(module))
    definitions = sorted(module for module in cone if module.startswith("Definitions."))
    proof_definitions = sorted(
        module for module in definitions
        if proof_bearing_definition(module_path(root, module))
    )
    direct = source_imports(target_path.read_text(encoding="utf-8"))
    public_imports = [
        module for module in direct
        if not is_proof_module(module) and not module.startswith("FLT10.")
    ]
    contexts = list(statement_context_imports)
    for module in contexts:
        context_cone = proof_dependency_cone(root, module)
        leaked = sorted(item for item in context_cone if is_proof_module(item))
        if leaked:
            raise GraphBuildError(
                f"statement context module reaches cut proof modules: {module}: {leaked[:3]}"
            )
        if module not in public_imports:
            public_imports.append(module)
    for module in public_imports:
        if not module.startswith(("Definitions.", "P2M.")):
            continue
        context_cone = proof_dependency_cone(root, module)
        leaked = sorted(item for item in context_cone if is_proof_module(item))
        if leaked:
            raise GraphBuildError(
                f"frontier import reaches cut proof modules: {module}: {leaked[:3]}"
            )
    canonical_theorem = _target_theorem(graph, target)
    public_theorem = canonical_theorem
    if str(score).isdigit() and TARGET_MODULES.get(int(score)) == target and int(score) in TARGETS:
        public_theorem = f"FLT10Bench.{TARGETS[int(score)]}"
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "checkpoint": int(score) if str(score).isdigit() else str(score),
        "target_module": target,
        "target_theorem": public_theorem,
        "canonical_theorem": canonical_theorem,
        "dag_module": f"{DAG_PREFIX}{score}" if str(score).isdigit() else None,
        "cut_direction": "target_proof_dependency_cone",
        "target_dependency_cone": sorted(cone),
        "cut_modules": proof_cone,
        "definition_dependencies": definitions,
        "proof_bearing_definition_modules": proof_definitions,
        "target_direct_imports": direct,
        "statement_context_imports": contexts,
        "compiled_frontier_imports": public_imports,
        "framework_policy": "full_graph_metadata_with_target_cone_removed_from_Lean",
        "definition_policy": "retain_only_definition_modules_reachable_without_cut_proof_imports",
        "proof_policy": "no_Theorems_or_P2M_non_Util_imports_in_DAG_frontier",
        "source_root": "repository-local",
        "source_revision": None,
    }


def build_statement_graph(
    root: Path,
    targets: Mapping[int | str, str] | None = None,
    *,
    source_revision: str | None = None,
) -> dict[str, Any]:
    """Build a full framework graph plus optional target cut manifests."""
    root = root.expanduser().resolve()
    graph = framework_graph(root)
    cuts: dict[str, dict[str, Any]] = {}
    for score, module in (targets or {}).items():
        context = STATEMENT_CONTEXT_MODULES.get(int(score), ()) if str(score).isdigit() else ()
        cuts[str(score)] = target_cut_manifest(
            root, score, module, graph=graph, statement_context_imports=context,
        )
        cuts[str(score)]["source_revision"] = source_revision
    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        # Keep metadata portable across checkouts; each node carries a
        # relative path and source hash rather than an absolute local path.
        "source_root": "repository-local",
        "source_revision": source_revision,
        "framework": graph,
        "cuts": cuts,
    }
    # Hash a canonical copy after building all metadata.  This is an identity
    # for the metadata contract, not a replacement for source file hashes.
    payload["metadata_sha256"] = digest(payload)
    return payload


def _parse_targets(values: list[str], include_defaults: bool) -> dict[int | str, str]:
    targets: dict[int | str, str] = {}
    if include_defaults:
        targets.update(TARGET_MODULES)
    for value in values:
        if "=" not in value:
            raise GraphBuildError(f"target must use SCORE=MODULE syntax: {value}")
        raw_score, module = value.split("=", 1)
        module = module.strip()
        if not module or not is_project_module(module):
            raise GraphBuildError(f"target module is outside project namespaces: {module}")
        score: int | str
        score = int(raw_score) if raw_score.isdigit() else raw_score.strip()
        targets[score] = module
    return targets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, required=True,
                        help="pinned source checkout containing FLT modules")
    parser.add_argument("--output", type=Path, required=True,
                        help="JSON metadata output path")
    parser.add_argument("--target", action="append", default=[], metavar="SCORE=MODULE",
                        help="target theorem module; repeat for multiple cuts")
    parser.add_argument("--all-default-targets", action="store_true",
                        help="include built-in FLT10bench target modules")
    parser.add_argument("--source-revision", default=None,
                        help="pinned source Git revision recorded in cut metadata")
    args = parser.parse_args(argv)
    try:
        targets = _parse_targets(args.target, args.all_default_targets)
        payload = build_statement_graph(args.project_root, targets, source_revision=args.source_revision)
    except GraphBuildError as exc:
        parser.error(str(exc))
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "output": str(output),
        "module_count": payload["framework"]["module_count"],
        "cut_count": len(payload["cuts"]),
        "metadata_sha256": payload["metadata_sha256"],
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
