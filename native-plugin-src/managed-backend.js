import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('./', import.meta.url));
export const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
export async function prepareManagedBackend(distro) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(distro) || /^docker-desktop/i.test(distro)) throw new Error('Choose a normal WSL development distribution');
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const fingerprint = pkg.dshWslNative.backendHash;
  const owner = createHash('sha256').update(dshHome.toLowerCase() + '\n' + distro).digest('hex').slice(0, 20);
  const linuxRoot = '.local/share/dsh-wsl-native/profiles/' + owner;
  const target = join(dshHome, 'native-wsl/backends', fingerprint + '-' + owner);
  const backend = join(packageRoot, 'backend');
  const manifest = JSON.parse(await readFile(join(backend, 'package.json'), 'utf8'));
  let stamp = await readFile(join(target, '.complete'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
  if (stamp !== fingerprint) {
    for (const file of ['package.json', ...manifest.files]) {
      await mkdir(dirname(join(target, file)), { recursive: true });
      await copyFile(join(backend, file), join(target, file));
    }
    const runner = join(target, 'scripts/run-linux.sh');
    const code = await readFile(runner, 'utf8');
    if (!code.includes('root="$HOME/.local/share/dsh-wsl-poc"')) throw new Error('Packaged runner root marker is missing');
    await writeFile(runner, code.replace('root="$HOME/.local/share/dsh-wsl-poc"', 'root="$HOME/' + linuxRoot + '"'));
    await writeFile(join(target, '.complete'), fingerprint);
  }
  const map = async path => (await exec('wsl.exe', ['-d', distro, '--exec', 'wslpath', '-a', '-u', path], { windowsHide: true, timeout: 20000 })).stdout.trim();
  const bootstrap = await map(join(target, 'scripts/bootstrap-native.sh'));
  await exec('wsl.exe', ['-d', distro, '--exec', 'bash', '--noprofile', '--norc', bootstrap, linuxRoot], { windowsHide: true, timeout: 900000, maxBuffer: 4 * 1024 * 1024 });
  return { module: join(target, 'controller.js'), target, linuxRoot };
}
