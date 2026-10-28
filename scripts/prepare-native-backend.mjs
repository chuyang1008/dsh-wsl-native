import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function prepareNativeBackend(id) {
  if (!/^[0-9]+$/.test(id)) throw new Error('Invalid isolated backend id');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const target = join(source, '.state/native-backend-' + id);
  const linuxRoot = '.local/share/dsh-wsl-native-' + id;
  await exec('wsl.exe', ['-d', 'Ubuntu', '--exec', 'bash', '--noprofile', '--norc', '-c',
    'set -eu\numask 077\nbase="$HOME/.local/share/dsh-wsl-poc"\ntarget="$HOME/' + linuxRoot + '"\ntest "$(cat "$base/.poc-owned")" = dsh-wsl-poc-v1\ntest ! -e "$target"\nmkdir -p "$target/instances/poc" "$target/cache"\nprintf "dsh-wsl-poc-v1\\n" > "$target/.poc-owned"\nln -s "$base/runtimes" "$target/runtimes"'], { windowsHide: true, timeout: 15000 });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  for (const file of ['package.json', ...manifest.files]) {
    await mkdir(dirname(join(target, file)), { recursive: true }); await copyFile(join(source, file), join(target, file));
  }
  const runner = join(target, 'scripts/run-linux.sh');
  const original = await readFile(runner, 'utf8');
  if (!original.includes('root="$HOME/.local/share/dsh-wsl-poc"')) throw new Error('Runner root declaration changed');
  await writeFile(runner, original.replace('root="$HOME/.local/share/dsh-wsl-poc"', 'root="$HOME/' + linuxRoot + '"'));
  const supervisor = join(target, 'scripts/supervised-backend.mjs');
  const code = await readFile(supervisor, 'utf8');
  const anchor = "  execFileSync('setpriv', guardedArgs(['web', '--dump-config']), { env, cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });";
  if (!code.includes(anchor)) throw new Error('Supervisor configuration anchor changed');
  await writeFile(supervisor, code.replace(anchor, `  if (config.mode !== 'mock') throw new Error('Native feasibility probe supports mock models only');
  const defaultConfig = execFileSync('setpriv', guardedArgs(['web', '--dump-config']), { env, cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  const presetStart = defaultConfig.indexOf('- id: preset-standard\\n');
  const presetEnd = defaultConfig.indexOf('\\n- id:', presetStart + 1);
  if (presetStart < 0 || presetEnd < 0) throw new Error('Standard preset definition not found');
  const standardPreset = defaultConfig.slice(presetStart, presetEnd);
  if (!standardPreset.includes('    id: standard') && !standardPreset.includes('    id: wsl')) throw new Error('Standard preset identity changed');
  patch += standardPreset.replace('    id: standard', '    id: wsl') + '\\n- id: agent-preset-registry\\n  config:\\n    default: wsl\\n';`));
  const mockFile = join(target, 'scripts/mock-provider.mjs');
  await writeFile(mockFile, (await readFile(mockFile, 'utf8')).replace('set -C; uname -s;', 'set -C; uname -s; pwd;'));
  await copyFile(join(source, 'native-runtime/linux-seed.js'), join(target, 'native-seed.js'));
  const linuxHost = join(target, 'linux-host.js');
  await writeFile(linuxHost, "import { applySeedEndpoint } from './native-seed.js';\n" + (await readFile(linuxHost, 'utf8')).replace('export function applyLinux(ctx) {', 'export function applyLinux(ctx) {\n  applySeedEndpoint(ctx);'));
  const copiedManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  copiedManifest.files.push('native-seed.js');
  await writeFile(join(target, 'package.json'), JSON.stringify(copiedManifest, null, 2));
  return { module: join(target, 'controller.js'), linuxRoot, target };
}
