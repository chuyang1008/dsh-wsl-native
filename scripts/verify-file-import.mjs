import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const app = (process.env.LOCALAPPDATA + '/Programs/DeepSeek Harness');
const workspace = resolve('wsl-poc/scratch/file-import-' + Date.now());
await mkdir(workspace, { recursive: true });
const host = spawn(app + '/DeepSeek Harness.exe', ['--expose-internals', app + '/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: resolve('wsl-poc/.state/cleanup-validation-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
const report = { version: '0.0.5', realModelRequests: 0, workspace, checks: [] };
let api;
try {
  const url = await new Promise((ready, reject) => {
    let buffer = ''; const timer = setTimeout(() => reject(new Error('Host startup timeout')), 30000);
    const log = bytes => { buffer += bytes; const found = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (found) { clearTimeout(timer); ready(found[0]); } };
    host.stdout.on('data', log); host.stderr.on('data', log); host.once('error', reject);
  });
  const base = new URL(url).origin;
  const exchange = await fetch(url, { redirect: 'manual' });
  if (exchange.status !== 303) throw new Error('Authentication failed');
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  api = async (path, data, expected = 200) => {
    const response = await fetch(base + '/api/dsh-wsl-poc/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(95000) });
    const value = await response.json(); if (response.status !== expected) throw new Error(path + ': ' + JSON.stringify(value)); return value;
  };
  const unauth = await fetch(base + '/api/dsh-wsl-poc/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (unauth.status !== 401) throw new Error('Unauthenticated import accepted');
  report.checks.push('unauthenticated import rejected');
  await api('import', { files: [] }, 400);
  report.checks.push('stopped environment rejected');
  const started = await api('start', { distro: 'Ubuntu', workspace, mode: 'mock' });
  const bytes = Buffer.concat([Buffer.from('Windows → WSL 中文\r\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
  const payload = { workspace, backendPid: started.backendPid, files: [{ name: '中文 空格.bin', base64: bytes.toString('base64') }] };
  await api('import', { ...payload, backendPid: -1 }, 400);
  report.checks.push('stale panel environment rejected');
  const a = await api('import', payload); const b = await api('import', payload);
  if (a.files[0].linuxPath === b.files[0].linuxPath) throw new Error('Repeated import reused destination');
  const { stdout } = await exec('wsl.exe', ['-d', 'Ubuntu', '--exec', 'python3', '-c', 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())', a.files[0].linuxPath], { windowsHide: true, timeout: 15000 });
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (stdout.trim() !== hash || !(await readFile(a.files[0].windowsPath)).equals(bytes)) throw new Error('Cross-host byte mismatch');
  report.checks.push('Windows API → mapped workspace → WSL Python SHA256 matched', 'repeated names isolated'); report.sha256 = hash;
  const boundary = await api('import', { ...payload, files: [{ name: '10MiB.bin', base64: Buffer.alloc(10 * 1024 * 1024, 0x5a).toString('base64') }] });
  if (boundary.files[0].bytes !== 10 * 1024 * 1024) throw new Error('Advertised size boundary failed');
  report.checks.push('10 MiB payload accepted by actual Host transport');
  await api('import', { ...payload, files: [{ name: '../escape', base64: '' }] }, 400);
  report.checks.push('traversal rejected by live endpoint');
  const guest = await api('open', {}); const guestAuth = await fetch(guest.url, { redirect: 'manual' });
  const guestCookie = guestAuth.headers.get('set-cookie').split(';')[0];
  const page = await fetch(new URL(guest.url).origin, { headers: { cookie: guestCookie } });
  if (!(await page.text()).includes('__DSH_WSL_BOOT__')) throw new Error('Guest bootstrap missing');
  report.checks.push('guest bootstrap available');
  if ((await api('stop', {})).state !== 'stopped') throw new Error('Stop failed');
  await api('import', payload, 400);
  report.checks.push('post-stop import rejected'); report.ok = true;
} catch (error) { report.ok = false; report.error = error.message; }
finally {
  if (api) await api('stop', {}).catch(() => {});
  host.kill('SIGTERM');
  await writeFile(resolve('wsl-poc/artifacts/file-import-evidence-0.0.5.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
if (!report.ok) process.exitCode = 1;
