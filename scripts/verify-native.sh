#!/usr/bin/env bash
set -euo pipefail
root="$HOME/.local/share/dsh-wsl-poc"
export PATH="$root/runtimes/node-v24.21.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec node "$script_dir/verify-native.mjs" "$root"
