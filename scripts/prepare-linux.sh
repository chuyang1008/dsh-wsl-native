#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$HOME/.local/share/dsh-wsl-poc"
if [ -e "$root" ] && [ ! -f "$root/.poc-owned" ]; then
  printf 'Refusing existing unowned directory: %s\n' "$root" >&2
  exit 2
fi
mkdir -p "$root/cache" "$root/runtimes" "$root/instances"
printf 'dsh-wsl-poc-v1\n' > "$root/.poc-owned"
node_version=24.21.0
dsh_version=0.2.1-rc.3
arch="$(uname -m)"
case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "Unsupported architecture: $arch" >&2; exit 2 ;; esac
node_name="node-v$node_version-linux-$arch"
if [ ! -x "$root/runtimes/$node_name/bin/node" ]; then
  archive="$node_name.tar.xz"
  curl -fSL --retry 2 --connect-timeout 15 --max-time 240 "https://nodejs.org/dist/v$node_version/$archive" -o "$root/cache/$archive.partial"
  curl -fsSL --retry 2 --max-time 60 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$root/cache/SHASUMS256.txt"
  expected="$(awk -v n="$archive" '$2 == n { print $1 }' "$root/cache/SHASUMS256.txt")"
  [[ "$expected" =~ ^[[:xdigit:]]{64}$ ]] || { echo 'Missing official checksum' >&2; exit 2; }
  printf '%s  %s\n' "$expected" "$root/cache/$archive.partial" | sha256sum -c -
  stage="$(mktemp -d "$root/runtimes/.node-stage.XXXXXX")"
  tar -xJf "$root/cache/$archive.partial" -C "$stage"
  mv -- "$stage/$node_name" "$root/runtimes/$node_name"
  rmdir -- "$stage"
fi
export PATH="$root/runtimes/$node_name/bin:/usr/local/bin:/usr/bin:/bin"
export npm_config_cache="$root/cache/npm"
prefix="$root/runtimes/dsh-$dsh_version"
mkdir -p "$prefix"
if [ ! -f "$prefix/package.json" ]; then
  printf '{"name":"dsh-wsl-poc-runtime","private":true,"version":"0.0.0"}\n' > "$prefix/package.json"
fi
npm install --prefix "$prefix" --no-audit --no-fund --save-exact --registry=https://registry.npmjs.org "@deepseek-ai/dsh@$dsh_version" "pnpm@11.28.5"
node "$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js" --version
node -e 'console.log(JSON.stringify({platform:process.platform,node:process.version,arch:process.arch,root:process.argv[1]}))' "$root"
