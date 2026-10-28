import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMock } from './mock-provider.mjs';
import { mockPatch } from './mock-config.mjs';
const app = (process.env.LOCALAPPDATA + '/Programs/DeepSeek Harness');
const workspace = resolve('wsl-poc/scratch/host-bridge-' + Date.now());
const validation = process.argv.includes('--validation');
const home = resolve(validation ? 'wsl-poc/.state/cleanup-validation-home' : 'wsl-poc/.state/windows-home');
await mkdir(workspace, { recursive: true });
const mock = await startMock();
// Test the Windows Host adapter through a local mock endpoint, never real credentials.
const profilePatch = resolve(home, 'profiles/web/cordis.patch.yml');
const previous = await readFile(profilePatch, 'utf8');
await writeFile(profilePatch, mockPatch(mock.port).replace('- id: tool-bash\n  disabled: false\n', ''));
const host = spawn(app + '/DeepSeek Harness.exe', ['--expose-internals', app + '/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_WSL_POC_MOCK_KEY: 'poc-local-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
const report = { test: 'linux-agent-through-windows-public-llm-stdio-bridge', workspace, realModelRequests: 0, checks: [] };
let base, cookie;
async function api(path, data) {
  const response = await fetch(base + '/api/dsh-wsl-poc/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(95000) });
  const value = await response.json(); if (!response.ok) throw new Error(path + ' failed: ' + JSON.stringify(value)); return value;
}
async function authenticate(url) {
  const response = await fetch(url, { redirect: 'manual' });
  if (response.status !== 303) throw new Error('Authentication exchange failed');
  return response.headers.get('set-cookie').split(';')[0];
}
async function rpc(origin, auth, method, args) {
  const rpcId = randomUUID();
  const response = await fetch(origin + '/api/' + method, { method: 'POST', headers: { cookie: auth, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
  const value = await response.json(); if (!response.ok || !value.result?.ok) throw new Error(method + ': ' + JSON.stringify(value)); return value.result.value;
}
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('Verification deadline exceeded');
}
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Windows Host startup timeout')), 30000); let buffer = '';
    const log = x => { buffer += x; const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
    host.stdout.on('data', log); host.stderr.on('data', log); host.once('error', reject); host.once('exit', code => reject(new Error('Host exited ' + code)));
  });
  base = new URL(url).origin; cookie = await authenticate(url);
  const catalog = await api('models');
  if (!catalog.groups.some(x => x.provider === 'wsl-poc' && x.models.some(m => m.id === 'poc-model'))) throw new Error('Host mock model not advertised');
  report.checks.push({ name: 'host-catalog', ok: true });
  const started = await api('start', { distro: 'Ubuntu', workspace, mode: 'host', selection: { provider: 'wsl-poc', model: 'poc-model' } });
  if (started.mode !== 'host' || started.state !== 'running') throw new Error('Host model mode startup failed');
  report.checks.push({ name: 'start-host-mode', ok: true });
  const target = await api('open', {}); const linuxOrigin = new URL(target.url).origin; const linuxCookie = await authenticate(target.url);
  const index = await fetch(linuxOrigin, { headers: { cookie: linuxCookie } }); const html = await index.text();
  if (!html.includes('__DSH_WSL_BOOT__')) throw new Error('Workspace bootstrap missing');
  const registered = await rpc(linuxOrigin, linuxCookie, 'workspace/create', { request: { path: started.linuxWorkspace } });
  if (registered.created) throw new Error('Workspace was not automatically registered');
  report.checks.push({ name: 'auto-register-workspace-and-inject-client-bootstrap', ok: true, workspaceId: registered.workspace.workspaceId });
  const created = await rpc(linuxOrigin, linuxCookie, 'session/create', { request: { workspaceId: registered.workspace.workspaceId } });
  await rpc(linuxOrigin, linuxCookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'WSL_POC_VERIFY' }] } });
  await until(async () => {
    const file = await readFile(resolve(workspace, 'WSL原型 回写验证.txt'), 'utf8').catch(() => null);
    const listed = await rpc(linuxOrigin, linuxCookie, 'session/list', { _request: {} });
    return mock.evidence.requests >= 2 && file === 'Linux DSH 工具回写成功\n' && listed.items.some(x => x.sessionId === created.sessionId && !x.running);
  });
  report.checks.push({ name: 'windows-adapter-stream-tools-linux-execution', ok: true, requests: mock.evidence.requests, file: await readFile(resolve(workspace, 'WSL原型 回写验证.txt'), 'utf8') });
  // Separate session avoids earlier verification tool results in the wait scenario.
  const waitSession = await rpc(linuxOrigin, linuxCookie, 'session/create', { request: { workspaceId: registered.workspace.workspaceId } });
  await rpc(linuxOrigin, linuxCookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: waitSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'WSL_POC_WAIT' }] } });
  await until(() => mock.evidence.waiting > 0);
  await rpc(linuxOrigin, linuxCookie, 'session/cancel', { request: { sessionId: waitSession.sessionId } });
  await until(() => mock.evidence.cancelled > 0);
  report.checks.push({ name: 'linux-cancel-propagates-to-windows-provider-http', ok: true });
  report.ok = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (cookie) { try { report.stopped = await api('stop', {}); } catch { report.stopError = true; } }
  host.kill('SIGTERM'); mock.server.closeAllConnections(); mock.server.close();
  await writeFile(profilePatch, previous);
  await writeFile(resolve(validation ? 'wsl-poc/artifacts/host-bridge-evidence-0.0.4.json' : 'wsl-poc/artifacts/host-bridge-evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
