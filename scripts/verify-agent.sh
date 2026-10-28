#!/usr/bin/env bash
set -euo pipefail
root="$HOME/.local/share/dsh-wsl-poc"
arch="$(uname -m)"
case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 2 ;; esac
export PATH="$root/runtimes/node-v24.21.0-linux-$arch/bin:$root/runtimes/dsh-0.2.1-rc.3/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec node "$script_dir/verify-agent.mjs" "$1" "$root"
