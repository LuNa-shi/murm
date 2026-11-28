#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# != 2 ]]; then
  echo 'Usage: chart.sh source-directory private-render-directory' >&2
  exit 64
fi
source_dir=$1
render_dir=$2
commit=db708c218771a8d311356f0e96552c15df6e097a
for binary in git helm; do
  command -v "$binary" >/dev/null || { echo "Missing deployment tool $binary" >&2; exit 69; }
done
[[ -f "$render_dir/values.json" ]] || { echo 'Run prepare.mjs first' >&2; exit 64; }
if [[ ! -d "$source_dir" ]]; then
  mkdir -p "$source_dir"
  git -C "$source_dir" init --quiet
  git -C "$source_dir" remote add origin https://github.com/opensandbox-group/OpenSandbox.git
  git -C "$source_dir" fetch --depth 1 origin "$commit"
  git -C "$source_dir" checkout --detach --quiet FETCH_HEAD
fi
[[ $(git -C "$source_dir" rev-parse HEAD) == "$commit" ]] || { echo 'Source commit does not match pinned BOM' >&2; exit 65; }
[[ -z $(git -C "$source_dir" status --porcelain --untracked-files=no) ]] || { echo 'Pinned source contains tracked edits' >&2; exit 65; }
chart="$source_dir/manifests/charts/opensandbox"
helm dependency build "$chart"
helm lint "$chart" --values "$render_dir/values.json"
helm template opensandbox "$chart" --namespace opensandbox-system --values "$render_dir/values.json" > "$render_dir/chart.yaml"
node --input-type=module - "$render_dir/chart.yaml" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const text = await readFile(process.argv[2], 'utf8');
const images = [...text.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)].map(match => match[1]);
assert.ok(images.length >= 3, 'Server, Controller and Ingress must render');
assert.ok(images.every(image => /@sha256:[a-f0-9]{64}$/.test(image)), 'All rendered images must have pinned digests');
assert.match(text, /replicas: 2/);
assert.match(text, /type: Recreate/);
assert.match(text, /mode = "dns\+nft"/);
assert.match(text, /gateway\.route\.mode = "uri"/);
assert.match(text, /OPENSANDBOX_SECURE_ACCESS_ACTIVE_KEY/);
assert.doesNotMatch(text, /kind: DaemonSet/);
console.log('Rendered official chart with pinned images and authenticated gateway');
JS
