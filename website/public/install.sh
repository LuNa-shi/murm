#!/bin/sh
set -eu

main() {
  if ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' 'Install Node.js 22.19 or later with npm, then run this installer again.' >&2
    exit 1
  fi

  exec npm install --global --ignore-scripts --allow-remote=root \
    https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
}

main
