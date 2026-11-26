#!/bin/sh
set -eu

# A Judge deployment may mount a locked Lean project and toolchain. Prebuild
# only when explicitly requested and retain the result in the service volume;
# ordinary service starts never compile a checker implicitly.
if [ "${MURM_JUDGE_PREBUILD:-false}" = "true" ]; then
  project_root=${MURM_JUDGE_PROJECT_ROOT:?MURM_JUDGE_PROJECT_ROOT is required when prebuilding the Judge}
  lake_command=${MURM_LEAN_COMMAND:-lake}
  marker=${MURM_JUDGE_PREBUILD_MARKER:-/var/lib/murm/.checker-prebuilt}
  key=${MURM_JUDGE_PREBUILD_KEY:-${MURM_JUDGE_FIXTURE_MANIFEST:-default}}
  previous=''
  if [ -f "$marker" ]; then previous=$(cat "$marker"); fi
  if [ "$previous" != "$key" ]; then
    "$lake_command" build --directory "$project_root"
    printf '%s' "$key" > "$marker"
  fi
fi

exec node dist/scripts/service-host.js
