import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeBackend } from './prepare-native-backend.mjs';
import { startMock } from './mock-provider.mjs';
import { mockPatch } from './mock-config.mjs';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const packageIndex = process.argv.indexOf('--package');
const packedPlugin = packageIndex < 0 ? undefined : resolve(process.argv[packageIndex + 1]);
const id = String(Date.now());
const home = join(root, '.state/native-desktop-' + id);
const userData = join(root, '.state/native-desktop-userdata-' + id);
const workspace = join(root, 'scratch/native-desktop-' + id);
const app = join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness');
const exe = join(app, 'DeepSeek Harness.exe');
const cli = join(app, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
// Electron's singleton is scoped to userData. Only use this unique test profile;
// the Host command line below must confirm the matching isolated DSH_HOME.
async function assertDesktopStopped() {
  const running = await exec('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Where-Object { $_.CommandLine -like ('*' + $env:DSH_NATIVE_EXPECTED_USERDATA + '*') }).Count"], { windowsHide: true, env: { ...process.env, DSH_NATIVE_EXPECTED_USERDATA: userData } });
  const count = Number(running.stdout.trim());
  if (!Number.isInteger(count) || count !== 0) throw new Error('A Desktop instance is already running or its state cannot be verified; exit it from the tray before running this isolated launcher');
}
await assertDesktopStopped();
const backend = packedPlugin ? undefined : await prepareNativeBackend(id);
const mock = await startMock();
const env = { ...process.env, DSH_HOME: home, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: join(userData, 'electron.log'), DSH_WSL_POC_MOCK_KEY: 'poc-local-only', ...(backend ? { DSH_WSL_NATIVE_RUNTIME_PROBE: '1', DSH_WSL_NATIVE_BACKEND_MODULE: backend.module } : {}) };
if (packedPlugin) { delete env.DSH_WSL_NATIVE_RUNTIME_PROBE; delete env.DSH_WSL_NATIVE_BACKEND_MODULE; }
delete env.ELECTRON_RUN_AS_NODE;
try {
  const profile = join(home, 'profiles/desktop');
  await mkdir(profile, { recursive: true }); await mkdir(workspace, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await exec(exe, ['--expose-internals', cli, 'plugin', '--profile', 'desktop', 'add', packedPlugin ?? join(root, 'native-runtime')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 120000 });
  await writeFile(join(profile, 'cordis.patch.yml'), mockPatch(mock.port).replace('- id: tool-bash\n  disabled: false\n', ''));
  await assertDesktopStopped();
  const child = spawn(exe, ['--user-data-dir=' + userData], { env, windowsHide: false, stdio: 'ignore' });
  const launch = { id, home, userData, workspace, backend, installedPackage: packedPlugin, pid: child.pid, mode: 'isolated-native-desktop-local-mock', profileVerified: false, desktopVerified: false };
  await writeFile(join(root, 'artifacts/native-desktop-launch.json'), JSON.stringify(launch, null, 2));
  console.log(JSON.stringify(launch, null, 2));
  let exitCode;
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { exitCode = code; resolve(); }); });
  // If another instance wins the global lock during startup, the spawned
  // process exits instead of hosting this profile. Never automate that window.
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (exitCode !== undefined) {
    launch.startupResult = 'exited-before-profile-verification';
    await writeFile(join(root, 'artifacts/native-desktop-launch.json'), JSON.stringify(launch, null, 2));
    throw new Error('Desktop exited before isolated-profile verification; no native UI acceptance was performed');
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && exitCode === undefined) {
    const verified = await exec('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Where-Object { $_.CommandLine -like ('*' + $env:DSH_NATIVE_EXPECTED_PROFILE + '*') }).Count"], { windowsHide: true, env: { ...process.env, DSH_NATIVE_EXPECTED_PROFILE: join(home, 'profiles/desktop') } });
    if (Number(verified.stdout.trim()) > 0) { launch.profileVerified = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await writeFile(join(root, 'artifacts/native-desktop-launch.json'), JSON.stringify(launch, null, 2));
  if (!launch.profileVerified) {
    if (exitCode === undefined) child.kill('SIGTERM');
    throw new Error('The expected isolated Desktop Host profile was not observed; native UI automation is not authorized against another window');
  }
  console.log('Isolated Desktop Host profile verified; native UI acceptance may begin.');
  await exited;
} finally { mock.server.closeAllConnections(); mock.server.close(); }
