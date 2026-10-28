import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const { WslController } = await import('../.state/cleanup-validation-plugin/controller.js');
const exec = promisify(execFile);
const app = (process.env.LOCALAPPDATA + '/Programs/DeepSeek Harness');
const root = '/home/chuyang/.local/share/dsh-wsl-poc-validation';
const node = root + '/runtimes/node-v24.21.0-linux-x64/bin/node';
const maintenance = new WslController();
const report = { test: 'active-tool-cleanup-with-owned-official-windows-web-host', runtime: 'separate-validation-root', realModelRequests: 0, cases: [] };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; do { const value = await fn(); if (value) return value; await pause(200); } while (Date.now() < end); throw new Error('Test deadline exceeded'); }
async function linux(script, ...args) {
  const { stdout } = await exec('wsl.exe', ['-d', 'Ubuntu', '--exec', node, '/mnt/d/dsh/wsl-poc/scripts/' + script, ...args], { windowsHide: true, timeout: 15000 });
  return stdout.trim();
}
async function authenticate(url) { const response = await fetch(url, { redirect: 'manual' }); if (response.status !== 303) throw new Error('Auth exchange failed'); return response.headers.get('set-cookie').split(';')[0]; }
async function rpc(base, cookie, method, args) {
  const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!value.result?.ok) throw new Error(method + ' failed'); return value.result.value;
}
for (const scenario of (process.argv[2] ? [process.argv[2]] : ['normal-stop', 'windows-host-crash', 'linux-supervisor-crash', 'normal-stop-detached', 'windows-host-crash-detached', 'linux-supervisor-crash-detached'])) {
  let host, api, runId;
  const result = { scenario }; report.cases.push(result);
  try {
    if ((await maintenance.maintenance({ action: 'status' })).state !== 'absent') throw new Error('Private Linux runtime already owned; test refused');
    const workspace = resolve('wsl-poc/scratch/cleanup-' + scenario + '-' + Date.now()); await mkdir(workspace, { recursive: true });
    result.workspace = workspace;
    host = spawn(app + '/DeepSeek Harness.exe', ['--expose-internals', app + '/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: resolve('wsl-poc/.state/cleanup-validation-home'), DSH_WSL_POC_MOCK_KEY: 'poc-local-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const url = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Host startup deadline')), 30000); let buffer = '';
      const log = chunk => { buffer += chunk; const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (match) { clearTimeout(timer); resolveReady(match[0]); } if (buffer.length > 64000) buffer = buffer.slice(-32000); };
      host.stdout.on('data', log); host.stderr.on('data', log); host.once('error', reject); host.once('exit', code => reject(new Error('Test Host exited ' + code)));
    });
    const base = new URL(url).origin; const cookie = await authenticate(url);
    api = async (path, body) => { const response = await fetch(base + '/api/dsh-wsl-poc/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(95000) }); const value = await response.json(); if (!response.ok) throw new Error(path + ' failed'); return value; };
    await api('start', { distro: 'Ubuntu', workspace, mode: 'mock' });
    runId = (await maintenance.maintenance({ action: 'status' })).runId;
    const guest = await api('open', {}); const guestBase = new URL(guest.url).origin; const guestCookie = await authenticate(guest.url);
    const selected = await rpc(guestBase, guestCookie, 'workspace/create', { request: { path: '/mnt/d/' + workspace.slice(3).replaceAll('\\', '/') } });
    const session = await rpc(guestBase, guestCookie, 'session/create', { request: { workspaceId: selected.workspace.workspaceId } });
    result.sessionId = session.sessionId;
    await rpc(guestBase, guestCookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: scenario.endsWith('-detached') ? 'WSL_POC_DETACHED_TOOL' : 'WSL_POC_LONG_TOOL' }] } });
    const toolPids = await until(async () => { const value = await readFile(resolve(workspace, '.poc-active-tool.pids'), 'utf8').catch(() => ''); const pids = value.trim().split(/\s+/).map(Number); return pids.length === 2 && pids.every(pid => Number.isSafeInteger(pid) && pid > 0) ? pids : null; });
    const tree = JSON.parse(await linux('process-tree-test.mjs', 'snapshot', root, runId));
    if (!toolPids.every(pid => tree.members.some(member => member.pid === pid))) throw new Error('Tool ownership ancestry mismatch');
    if (scenario.endsWith('-detached')) {
      const sleeper = tree.members.find(member => member.pid === toolPids[1]);
      if (sleeper.sessionId !== sleeper.pid || sleeper.processGroupId !== sleeper.pid || !sleeper.ignoresSigterm) throw new Error('Detached/TERM-ignoring fixture not established');
      result.detachedSessionAndIgnoredSigtermConfirmed = true;
    }
    result.activeToolAndSleepConfirmed = true; result.recordedProcessCount = tree.members.length;
    if (scenario.startsWith('normal-stop')) { if ((await api('stop', {})).state !== 'stopped') throw new Error('Graceful stop was not confirmed'); }
    else if (scenario.startsWith('windows-host-crash')) { host.kill('SIGKILL'); await until(() => host.exitCode !== null || host.signalCode !== null); }
    else await linux('fault-inject-owned.mjs', root, runId);
    let status;
    try { status = await until(async () => { const value = JSON.parse(await linux('process-tree-test.mjs', 'status', root, runId)); status = value; return value.alive.length === 0 ? value : null; }, 12000); } catch { /* Record remaining owned identities, then clean only this test's processes. */ }
    result.remainingPids = status?.alive.map(value => value.pid) ?? [];
    result.allRecordedProcessesExited = !!status && status.alive.length === 0;
    if (host.exitCode === null && host.signalCode === null) result.runtimeLogs = (await api('status')).logs;
  } catch (error) { result.error = error.message; }
  finally {
    if (api && host?.exitCode === null && host?.signalCode === null) await api('stop', {}).catch(() => {});
    if (runId) await linux('process-tree-test.mjs', 'cleanup', root, runId).catch(error => { result.cleanupError = error.message; });
    if (host?.exitCode === null && host?.signalCode === null) { host.kill('SIGTERM'); await until(() => host.exitCode !== null || host.signalCode !== null).catch(() => {}); }
    await pause(500);
    const status = await maintenance.maintenance({ action: 'status' }).catch(() => ({ state: 'unknown' }));
    if (status.state === 'stale') await maintenance.maintenance({ action: 'recover' }).catch(error => { result.recoveryError = error.message; });
    result.finalLockState = (await maintenance.maintenance({ action: 'status' }).catch(() => ({ state: 'unknown' }))).state;
    if (runId && result.finalLockState === 'unknown') await linux('process-tree-test.mjs', 'finalize-test', root, runId).catch(error => { result.finalizationError = error.message; });
    console.log(JSON.stringify(result));
  }
}
report.ok = report.cases.every(value => value.allRecordedProcessesExited && !value.error && value.finalLockState === 'absent');
await writeFile(new URL('../artifacts/active-cleanup-evidence.json', import.meta.url), JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
