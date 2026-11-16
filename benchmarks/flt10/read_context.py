#!/usr/bin/env python3
"""Query the complete public statement graph without extracting it to disk."""
import argparse
import hashlib
import json
import lzma
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('query', help='case-insensitive module or statement substring')
parser.add_argument('--limit', type=int, default=20)
parser.add_argument('--cut', action='store_true', help='query the checkpoint proof-cut manifest')
args = parser.parse_args()
if not 1 <= args.limit <= 100:
    parser.error('--limit must be between 1 and 100')
root = Path(__file__).resolve().parent
if args.cut:
    cut = json.loads(lzma.decompress((root / 'dag-cut-manifest.json.xz').read_bytes()))
    found = 0
    for key, value in cut.items():
        for item in value if isinstance(value, list) else [value]:
            if args.query.lower() in str(item).lower():
                print(json.dumps({key: item}, ensure_ascii=False))
                found += 1
                if found == args.limit:
                    raise SystemExit(0)
    raise SystemExit(0)
index = json.loads((root / 'framework-index.json').read_text())
remaining = args.limit
for shard in index['shards']:
    data = (root / shard['path']).read_bytes()
    if hashlib.sha256(data).hexdigest() != shard['sha256']:
        raise SystemExit('public context shard digest mismatch')
    nodes = json.loads(lzma.decompress(data))
    for name, node in nodes.items():
        if args.query.lower() in json.dumps(node, ensure_ascii=False).lower():
            print(json.dumps(node, ensure_ascii=False))
            remaining -= 1
            if remaining == 0:
                raise SystemExit(0)
