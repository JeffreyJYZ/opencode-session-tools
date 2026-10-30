#!/usr/bin/env sh
# Install the opencode session tools: one symlink into an opencode config directory.
# Usage: ./install.sh [config-dir]   (default: $XDG_CONFIG_HOME/opencode, else ~/.config/opencode)
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config=${1:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}
target="$config/plugin/session-tools.ts"

mkdir -p "$config/plugin"
ln -sfn "$here/src/index.ts" "$target"

printf 'linked %s -> %s\n' "$target" "$here/src/index.ts"
printf 'opencode reloads it on the next config touch; if the tools do not appear, touch %s and check the log for "loading plugin".\n' "$config/opencode.json"
