import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const source = resolve('wsl-poc');
const target = join(source, '.state/cleanup-validation-plugin');
const home = join(source, '.state/cleanup-validation-home');
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
await exec('wsl.exe', ['-d', 'Ubuntu', '--exec', 'bash', '--noprofile', '--norc', '-c', 'set -eu\numask 077\nbase="$HOME/.local/share/dsh-wsl-poc"\ntarget="$HOME/.local/share/dsh-wsl-poc-validation"\ntest "$(cat "$base/.poc-owned")" = dsh-wsl-poc-v1\nif test -e "$target"; then test "$(cat "$target/.poc-owned")" = dsh-wsl-poc-v1; else mkdir -p "$target"; printf "dsh-wsl-poc-v1\\n" > "$target/.poc-owned"; fi\nmkdir -p "$target/instances/poc" "$target/cache"\nif test -L "$target/runtimes"; then test "$(readlink -f "$target/runtimes")" = "$(readlink -f "$base/runtimes")"; elif test -e "$target/runtimes"; then exit 2; else ln -s "$base/runtimes" "$target/runtimes"; fi'], { windowsHide: true, timeout: 15000 });
for (const file of ['package.json', ...manifest.files]) { await mkdir(dirname(join(target, file)), { recursive: true }); await copyFile(join(source, file), join(target, file)); }
const runner = join(target, 'scripts/run-linux.sh');
const original = await readFile(runner, 'utf8');
const expected = 'root="$HOME/.local/share/dsh-wsl-poc"';
if (!original.includes(expected)) throw new Error('Unexpected runner root declaration');
await writeFile(runner, original.replace(expected, 'root="$HOME/.local/share/dsh-wsl-poc-validation"'));
// Use the official carrier directly through Electron, avoiding cmd string composition.
const exe = (process.env.LOCALAPPDATA + '/Programs/DeepSeek Harness/DeepSeek Harness.exe');
const entry = (process.env.LOCALAPPDATA + '/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home };
await exec(exe, ['--expose-internals', entry, 'web', '--dump-config'], { env, windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
await exec(exe, ['--expose-internals', entry, 'plugin', '--profile', 'web', 'add', target], { env, windowsHide: true, timeout: 120000 });
console.log(JSON.stringify({ target, home, onlySourceOverride: 'Linux private runtime root' }));
