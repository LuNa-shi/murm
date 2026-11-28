#!/bin/sh
set -eu

can_write() {
  directory=$1
  while [ ! -e "$directory" ] && [ ! -L "$directory" ]; do
    directory=${directory%/*}
    directory=${directory:-/}
  done
  [ -d "$directory" ] && [ -w "$directory" ] && [ -x "$directory" ]
}

main() {
  if ! command -v npm >/dev/null 2>&1 || ! node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1);
  ' >/dev/null 2>&1; then
    printf '%s\n' 'Install Node.js 22.19 or later with npm, then run this installer again.' >&2
    printf '%s\n' 'https://nodejs.org/en/download' >&2
    exit 1
  fi

  prefix=$(npm prefix --global)
  modules=$(npm root --global)
  if ! can_write "$prefix/bin" || ! can_write "$modules/@luna-shi"; then
    prefix="$HOME/.local"
  fi
  npm install --global --prefix "$prefix" --ignore-scripts --allow-remote=root \
    https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz

  if [ "$(command -v murm || true)" != "$prefix/bin/murm" ]; then
    printf '%s\n' 'To run the installed CLI in this shell, add its bin directory to PATH:' >&2
    if [ "$prefix" = "$HOME/.local" ]; then
      printf '%s\n' '  export PATH="$HOME/.local/bin:$PATH"' >&2
    else
      quoted_bin=$(printf '%s' "$prefix/bin" | sed "s/'/'\\\\''/g")
      printf "  export PATH='%s':\$PATH\n" "$quoted_bin" >&2
    fi
  fi
}

main
