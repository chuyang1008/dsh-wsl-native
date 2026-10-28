import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const app = (process.env.LOCALAPPDATA + '/Programs/DeepSeek Harness');
const workspace = resolve('wsl-poc/scratch/plugin-run-01');
await mkdir(workspace, { recursive: true });
const host = spawn(app + '/DeepSeek Harness.exe', ['--expose-internals', app + '/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: resolve('wsl-poc/.state/windows-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
const report = { test: 'official-windows-host-authenticated-plugin-to-linux-backend', checks: [] };
let base, cookie;
async function api(path, data, headers = { cookie }) {
  return fetch(base + '/api/dsh-wsl-poc/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...headers, ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(95000) });
}
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Windows Host startup timeout')), 30000); let buf = '';
    const log = x => { buf += x; const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (m) { clearTimeout(timer); resolve(m[0]); } };
    host.stdout.on('data', log); host.stderr.on('data', log); host.once('error', reject); host.once('exit', code => reject(new Error('Host exited ' + code)));
  });
  base = new URL(url).origin;
  const auth = await fetch(url, { redirect: 'manual' }); cookie = auth.headers.get('set-cookie')?.split(';')[0];
  const noAuth = await api('status', undefined, {}); report.checks.push({ name: 'unauthenticated', status: noAuth.status });
  const foreign = await api('status', undefined, { cookie, origin: 'https://example.invalid' }); report.checks.push({ name: 'foreign-origin', status: foreign.status });
  const status = await api('status'); report.checks.push({ name: 'authenticated-registered-route', status: status.status, value: await status.json() });
  if (noAuth.status !== 401 || foreign.status !== 403 || status.status !== 200) throw new Error('Auth boundary failed');
  const start = await api('start', { distro: 'Ubuntu', workspace }); const started = await start.json();
  report.checks.push({ name: 'start-through-plugin', status: start.status, value: started });
  if (!start.ok || started.state !== 'running') throw new Error('Plugin start failed');
  const opened = await api('open', {}); const target = await opened.json();
  const linuxAuth = await fetch(target.url, { redirect: 'manual' });
  const linuxCookie = linuxAuth.headers.get('set-cookie')?.split(';')[0];
  const linuxPage = await fetch(new URL(target.url).origin, { headers: { cookie: linuxCookie } });
  report.checks.push({ name: 'linux-ui-via-owned-auth-url', exchange: linuxAuth.status, status: linuxPage.status });
  if (linuxAuth.status !== 303 || linuxPage.status !== 200) throw new Error('Linux UI failed');
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (cookie) { try { const r = await api('stop', {}); report.stopped = await r.json(); } catch (e) { report.stopError = e.message; } }
  host.kill('SIGTERM');
  report.ok = !report.error && report.stopped?.state === 'stopped';
  if (!report.ok) process.exitCode = 1;
  await writeFile(resolve('wsl-poc/artifacts/plugin-evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
