#!/usr/bin/env bash
set -euo pipefail
umask 077
relative="${1:?profile root required}"
[[ "$relative" =~ ^\.local/share/dsh-wsl-native/profiles/[a-f0-9]{20}$ ]] || { echo 'Invalid native runtime owner' >&2; exit 2; }
target="$HOME/$relative"
if test -e "$target"; then
  test "$(cat "$target/.poc-owned")" = dsh-wsl-poc-v1 || { echo 'Unowned runtime directory' >&2; exit 2; }
fi
mkdir -p "$target/instances/poc" "$target/cache"
printf 'dsh-wsl-poc-v1\n' > "$target/.poc-owned"
arch="$(uname -m)"
case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo 'Unsupported WSL architecture' >&2; exit 2 ;; esac
valid_runtime() { test -x "$1/node-v24.21.0-linux-$arch/bin/node" && test -f "$1/dsh-0.2.1-rc.3/node_modules/@deepseek-ai/dsh/lib/bin.js"; }
if test -L "$target/runtimes"; then
  valid_runtime "$target/runtimes" || { echo 'Managed runtime link is incomplete' >&2; exit 2; }
elif test -e "$target/runtimes"; then
  echo 'Refusing unexpected runtime directory' >&2; exit 2
else
  shared="$HOME/.local/share/dsh-wsl-native/shared"
  legacy="$HOME/.local/share/dsh-wsl-poc"
  if test -f "$legacy/.poc-owned" && test "$(cat "$legacy/.poc-owned")" = dsh-wsl-poc-v1 && valid_runtime "$legacy/runtimes"; then
    runtime="$legacy/runtimes"
  else
    script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
    bash "$script_dir/prepare-linux.sh"
    valid_runtime "$shared/runtimes" || { echo 'Runtime installation is incomplete' >&2; exit 2; }
    runtime="$shared/runtimes"
  fi
  ln -s "$runtime" "$target/runtimes"
fi
printf 'Native WSL runtime ready\n'
