#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$HOME/.local/share/dsh-wsl-poc"
test -f "$root/.poc-owned" || { echo 'Run prepare-linux.sh first' >&2; exit 2; }
arch="$(uname -m)"
case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 2 ;; esac
export PATH="$root/runtimes/node-v24.21.0-linux-$arch/bin:$root/runtimes/dsh-0.2.1-rc.3/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
command -v flock >/dev/null || { echo 'Linux flock is required' >&2; exit 2; }
if [ "${1:-}" = '--status' ]; then
  exec node "$script_dir/manage-linux.mjs" "$1" "$root"
elif [ "${1:-}" = '--recover' ]; then
  exec flock -n -E 73 -F "$root/instances/poc.guard" node "$script_dir/manage-linux.mjs" "$1" "$root"
fi
command -v setpriv >/dev/null || { echo 'Linux setpriv is required' >&2; exit 2; }
exec flock -n -E 73 -F "$root/instances/poc.guard" node "$script_dir/runtime-guardian.mjs" "$1" "$root"
