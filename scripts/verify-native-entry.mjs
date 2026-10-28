import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { startMock } from './mock-provider.mjs';
import { mockPatch } from './mock-config.mjs';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const home = join(root, '.state/native-entry-' + Date.now());
const workspace = join(root, 'scratch/native-entry-' + Date.now());
const app = join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness');
const exe = join(app, 'DeepSeek Harness.exe');
const cli = join(app, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_WSL_POC_MOCK_KEY: 'poc-local-only', DSH_WSL_NATIVE_ENTRY_PROBE: '1' };
const report = { test: 'native-preset-official-windows-host', home, workspace, checks: [], desktopVerified: false, linuxRoutingImplemented: false };
let host, mock, cookie, base;
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Verification deadline exceeded');
}
async function prompt(sessionId) {
  return rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Native entry probe.' }] } });
}
async function guardEvidence() {
  const response = await fetch(base + '/api/dsh-wsl-native-probe/evidence', { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function rpc(method, args = {}, auth = cookie) {
  const response = await fetch(base + '/api/' + method, {
    method: 'POST', headers: { ...(auth ? { cookie: auth } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  assert.equal(response.status, 200, method);
  assert.equal(value.result?.ok, true, JSON.stringify(value));
  return value.result.value;
}
async function start() {
  host = spawn(exe, ['--expose-internals', cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Host startup timeout')), 30000);
    const log = chunk => { buffer = (buffer + chunk).slice(-65536); const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
    host.stdout.on('data', log); host.stderr.on('data', log);
    host.once('error', error => { clearTimeout(timer); reject(error); });
    host.once('exit', code => { clearTimeout(timer); reject(new Error('Host exited ' + code)); });
  });
  base = new URL(url).origin;
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 303);
  cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
}
async function stop() {
  if (!host || host.exitCode !== null) return;
  const exited = new Promise(resolve => host.once('exit', resolve));
  host.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Owned Host shutdown timeout')), 10000); timer.unref(); })]);
}
try {
  await mkdir(workspace, { recursive: true });
  await exec(exe, ['--expose-internals', cli, 'web', '--dump-config'], { env, cwd: workspace, windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  await exec(exe, ['--expose-internals', cli, 'plugin', '--profile', 'web', 'add', join(root, 'native-probe')], { env, windowsHide: true, timeout: 120000 });
  mock = await startMock();
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), mockPatch(mock.port).replace('- id: tool-bash\n  disabled: false\n', ''));
  await start();
  const unauth = await fetch(base + '/api/agentPresets/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  report.checks.push({ name: 'unauthenticated-roster', status: unauth.status });
  const roster = await rpc('agentPresets/list');
  const wsl = roster.presets.find(row => row.id === 'wsl');
  assert.equal(wsl?.name, 'WSL 模式'); assert.equal(wsl.broken, undefined);
  assert.ok(roster.presets.some(row => row.id === 'standard' && row.isDefault));
  report.checks.push({ name: 'roster-preserves-standard-and-adds-wsl', presets: roster.presets });
  const created = await rpc('session/create', { request: { cwd: workspace, agentPreset: 'wsl' } });
  assert.equal(created.agentPreset, 'wsl');
  report.checks.push({ name: 'create-accepts-selected-preset', request: { cwd: workspace, agentPreset: 'wsl' }, result: created });
  const before = mock.evidence.requests;
  await prompt(created.sessionId);
  await until(async () => (await rpc('session/list', { _request: {} })).items.some(row => row.sessionId === created.sessionId && !row.running && !row.blank));
  assert.equal((await guardEvidence()).blocked[0]?.sessionId, created.sessionId);
  assert.equal(mock.evidence.requests, before);
  report.checks.push({ name: 'wsl-does-not-fall-back-to-windows-model', modelRequests: mock.evidence.requests - before });
  await stop();
  await start();
  const restored = await rpc('session/list', { _request: {} });
  const restoredSession = restored.items.find(row => row.sessionId === created.sessionId);
  assert.equal(restoredSession?.projections?.values.agentPreset, 'wsl');
  await prompt(created.sessionId);
  await until(async () => (await guardEvidence()).blocked.some(row => row.sessionId === created.sessionId));
  assert.equal(mock.evidence.requests, before);
  report.checks.push({ name: 'session-preset-and-guard-survive-host-restart', sessionId: created.sessionId });
  const standard = await rpc('session/create', { request: { cwd: workspace, agentPreset: 'standard' } });
  assert.equal(standard.agentPreset, 'standard');
  const switched = await rpc('session/create', { request: { cwd: workspace, agentPreset: 'standard' } });
  assert.equal(await rpc('agentPresets/select', { agentId: switched.sessionId, agentPreset: 'wsl' }), 'wsl');
  await prompt(switched.sessionId);
  await until(async () => (await guardEvidence()).blocked.some(row => row.sessionId === switched.sessionId));
  assert.equal(mock.evidence.requests, before);
  report.checks.push({ name: 'blank-session-preset-switch-uses-current-projection', sessionId: switched.sessionId });
  await prompt(standard.sessionId);
  await until(async () => mock.evidence.requests > before && (await rpc('session/list', { _request: {} })).items.some(row => row.sessionId === standard.sessionId && !row.running && !row.blank));
  report.checks.push({ name: 'standard-session-model-roundtrip-unaffected', sessionId: standard.sessionId, mockRequests: mock.evidence.requests - before });
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack; process.exitCode = 1; }
finally {
  try { await stop(); } catch (error) { report.cleanupError = error.message; report.ok = false; process.exitCode = 1; }
  mock?.server.closeAllConnections(); mock?.server.close();
  await writeFile(join(root, 'artifacts/native-entry-evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
