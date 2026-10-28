import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startMock } from './mock-provider.mjs';
import { mockPatch } from './mock-config.mjs';
import { prepareNativeBackend } from './prepare-native-backend.mjs';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const home = join(root, '.state/native-runtime-' + Date.now());
const workspace = join(root, 'scratch/native-runtime-' + Date.now());
const app = join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness');
const exe = join(app, 'DeepSeek Harness.exe');
const cli = join(app, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_WSL_POC_MOCK_KEY: 'poc-local-only', DSH_WSL_NATIVE_RUNTIME_PROBE: '1' };
if (!process.versions.electron) {
  const child = spawnSync(exe, ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const { RemoteClient } = await import('../native-runtime/remote-client.js');
const packageIndex = process.argv.indexOf('--package');
const packedPlugin = packageIndex < 0 ? undefined : resolve(process.argv[packageIndex + 1]);
const hostModel = process.argv.includes('--host-model');
const lateEnable = process.argv.includes('--late-enable');
if (hostModel && !packedPlugin) throw new Error('--host-model requires an installed package test');
if (packedPlugin) { delete env.DSH_WSL_NATIVE_RUNTIME_PROBE; delete env.DSH_WSL_NATIVE_BACKEND_MODULE; }
const report = { test: 'replacement-session-controller-with-native-gateway', home, workspace, checks: [], desktopVerified: false, fullLifecycleImplemented: false, scope: 'single-project, Ubuntu, local mock model, text-only; official Gateway and mux, no Desktop UI acceptance' };
let host, mock, base, cookie, hostLogs = '', backendInfo, earlyBlank;
const collectors = [];
function collect(endpoint, args) {
  const abort = new AbortController(), frames = [];
  const client = new RemoteClient(base, cookie);
  const item = { frames, abort, error: undefined };
  item.done = (async () => { try { for await (const frame of client.stream(endpoint, args, abort.signal)) frames.push(frame); } catch (error) { item.error = error; } finally { client.close(); } })();
  collectors.push(item); return item;
}
async function prompt(sessionId, text) { return rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } }); }
async function rpc(method, args = {}) {
  const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(95000) });
  const result = await response.json();
  assert.ok(response.ok && result.result?.ok, method + ': ' + JSON.stringify(result));
  return result.result.value;
}
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Verification deadline exceeded');
}
async function start() {
  host = spawn(exe, ['--expose-internals', cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Host startup timeout: ' + buffer.replace(/([?&]token=)[\w-]+/g, '$1[redacted]').slice(-6000))), 30000);
    const log = chunk => { buffer = (buffer + chunk).slice(-65536); hostLogs = buffer.replace(/([?&]token=)[\w-]+/g, '$1[redacted]'); const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
    host.stdout.on('data', log); host.stderr.on('data', log);
    host.once('error', error => { clearTimeout(timer); reject(error); });
    host.once('exit', code => { clearTimeout(timer); reject(new Error('Host exited ' + code + ': ' + buffer.replace(/([?&]token=)[\w-]+/g, '$1[redacted]').slice(-6000))); });
  });
  base = new URL(url).origin;
  const auth = await fetch(url, { redirect: 'manual' });
  assert.equal(auth.status, 303); cookie = auth.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
}
async function stop() {
  if (!host || host.exitCode !== null) return;
  let shutdownError;
  try {
    if (base && cookie) {
      const response = await fetch(base + '/api/dsh-wsl-native-runtime/shutdown', { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(25000) });
      if (response.status !== 404) { assert.equal(response.status, 200); assert.equal((await response.json()).stopped, true); }
    }
  } catch (error) { shutdownError = error; }
  const exited = new Promise(resolve => host.once('exit', resolve)); host.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Owned Host shutdown timeout')), 20000); timer.unref(); })]);
  if (shutdownError) throw shutdownError;
}
try {
  await mkdir(workspace, { recursive: true });
  if (!packedPlugin) {
    backendInfo = await prepareNativeBackend(String(Date.now()));
    env.DSH_WSL_NATIVE_BACKEND_MODULE = backendInfo.module;
    report.backendIsolation = backendInfo;
  } else {
    report.installedPackage = packedPlugin;
    report.test = 'installed-native-plugin-package';
    report.probeEnvironmentRemoved = true;
    report.modelMode = hostModel ? 'host' : 'mock';
  }
  await exec(exe, ['--expose-internals', cli, 'web', '--dump-config'], { env, cwd: workspace, windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  await exec(exe, ['--expose-internals', cli, 'plugin', '--profile', 'web', 'add', packedPlugin ?? join(root, 'native-runtime')], { env, windowsHide: true, timeout: 120000 });
  mock = await startMock();
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), mockPatch(mock.port).replace('- id: tool-bash\n  disabled: false\n', '') + (packedPlugin && !hostModel ? '- id: wsl-native-session-controller\n  config:\n    modelMode: mock\n' : ''));
  if (lateEnable) {
    assert.ok(packedPlugin, '--late-enable requires an installed package');
    const manifestPath = join(home, 'profiles/web/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-wsl-native');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  await start();
  if (lateEnable) {
    earlyBlank = await rpc('session/create', { request: { cwd: workspace, agentPreset: 'standard' } });
    await rpc('pluginManager/setBundleEnabled', { name: 'dsh-wsl-native', enabled: true });
    await until(async () => (await fetch(base + '/api/dsh-wsl-native-runtime/status', { headers: { cookie } })).status === 200);
    report.checks.push({ name: 'blank-agent-created-before-plugin-activation', sessionId: earlyBlank.sessionId });
  }
  const statusResponse = await fetch(base + '/api/dsh-wsl-native-runtime/status', { headers: { cookie } });
  assert.equal(statusResponse.status, 200, hostLogs); report.checks.push({ name: 'replacement-service-active', status: await statusResponse.json() });
  const standard = await rpc('session/create', { request: { cwd: workspace, agentPreset: 'standard' } });
  await rpc('session/prompt', { request: { sessionId: standard.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Standard mode coexistence probe.' }] } });
  await until(async () => mock.evidence.requests > 0 && (await rpc('session/list', { _request: {} })).items.some(row => row.sessionId === standard.sessionId && !row.running && !row.blank));
  report.checks.push({ name: 'original-standard-agent-roundtrip', sessionId: standard.sessionId, mockRequests: mock.evidence.requests });
  const ws = await rpc('workspace/create', { request: { path: workspace } });
  const created = await rpc('session/create', { request: { workspaceId: ws.workspace.workspaceId, agentPreset: 'wsl' } });
  if (packedPlugin) {
    const status = await fetch(base + '/api/dsh-wsl-native-runtime/status', { headers: { cookie } }).then(response => response.json());
    backendInfo = status.managedBackend; report.backendIsolation = backendInfo;
    assert.ok(backendInfo?.module.startsWith(home));
    assert.equal(status.backend.mode, hostModel ? 'host' : 'mock');
    report.checks.push({ name: 'installed-package-provisions-own-backend-without-source-path-or-probe-env', version: status.pluginVersion, modelMode: status.backend.mode });
    if (hostModel) {
      const catalog = await rpc('session/modelCatalog', {});
      assert.ok(catalog.groups.some(group => group.id === 'wsl-host' && group.models.some(model => model.id === 'poc-model')));
      const selected = await rpc('session/selectModel', { request: { sessionId: created.sessionId, provider: 'wsl-poc', model: 'poc-model' } });
      assert.equal(selected.selected.provider, 'wsl-host');
      report.checks.push({ name: 'native-model-catalog-and-windows-selection-map-to-linux-bridge' });
    }
  }
  assert.equal(created.agentPreset, 'wsl');
  const stream = collect('session/follow', { request: { address: { kind: 'session', sessionId: created.sessionId }, assistantStream: true } });
  await until(() => { if (stream.error) throw stream.error; return stream.frames.some(frame => frame.type === 'snapshot'); });
  assert.equal(stream.frames[0].header.id, created.sessionId);
  assert.equal(stream.frames[0].header.agentPreset, 'wsl');
  report.checks.push({ name: 'linux-session-created-through-windows-gateway', sessionId: created.sessionId, linuxCwd: stream.frames[0].header.cwd });
  await prompt(created.sessionId, 'WSL_POC_VERIFY');
  await until(async () => {
    if (stream.error) throw stream.error;
    const file = await readFile(join(workspace, 'WSL原型 回写验证.txt'), 'utf8').catch(() => null);
    return file === 'Linux DSH 工具回写成功\n' && stream.frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end');
  }, 40000);
  const events = stream.frames.filter(frame => frame.type === 'event').map(frame => frame.event);
  assert.ok(JSON.stringify(events).includes('Linux'));
  assert.ok(JSON.stringify(events).includes('/mnt/d/'));
  assert.ok(events.some(event => event.type === 'tool/result'));
  assert.ok(stream.frames.some(frame => frame.type === 'assistant-stream'));
  for (let index = 1; index < events.length; index++) assert.equal(events[index].seq, events[index - 1].seq + 1);
  report.checks.push({ name: 'linux-uname-pwd-tool-trace-and-assistant-stream-via-native-mux', eventTypes: events.map(event => event.type), contiguousEvents: events.length, toolResults: events.filter(event => event.type === 'tool/result') });
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: created.sessionId }, throughSeq: events.at(-1).seq } });
  assert.ok(JSON.stringify(page).includes('Linux'));
  report.checks.push({ name: 'native-history-page-uses-linux-authoritative-log', records: page.records.length });
  const control = collect('session/control', {});
  await until(() => { if (control.error) throw control.error; return control.frames.some(frame => frame.type === 'baseline' && frame.value.projections[created.sessionId]); });
  report.checks.push({ name: 'native-control-baseline-includes-linux-projections' });
  const blank = earlyBlank ?? await rpc('session/create', { request: { workspaceId: ws.workspace.workspaceId, agentPreset: 'standard' } });
  const blankFollow = collect('session/follow', { request: { address: { kind: 'session', sessionId: blank.sessionId }, assistantStream: true } });
  await until(() => { if (blankFollow.error) throw blankFollow.error; return blankFollow.frames.some(frame => frame.type === 'snapshot'); });
  assert.equal(await rpc('agentPresets/select', { agentId: blank.sessionId, agentPreset: 'wsl' }), 'wsl');
  await prompt(blank.sessionId, 'Switch this unused session to Linux.');
  await until(() => { if (blankFollow.error) throw blankFollow.error; return blankFollow.frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'); });
  assert.equal(blankFollow.frames.filter(frame => frame.type === 'snapshot').length, 1);
  const blankEvents = blankFollow.frames.filter(frame => frame.type === 'event').map(frame => frame.event);
  for (let index = 1; index < blankEvents.length; index++) assert.equal(blankEvents[index].seq, blankEvents[index - 1].seq + 1);
  const selected = await rpc('session/projections', { request: { sessionId: blank.sessionId } });
  assert.equal(selected.values.agentPreset, 'wsl');
  report.checks.push({ name: 'standard-blank-switches-to-linux-with-same-id-and-existing-follow', sessionId: blank.sessionId, openingSnapshots: 1, continuousEvents: blankEvents.length });
  const waiting = await rpc('session/create', { request: { workspaceId: ws.workspace.workspaceId, agentPreset: 'wsl' } });
  const waitStream = collect('session/follow', { request: { address: { kind: 'session', sessionId: waiting.sessionId } } });
  await until(() => { if (waitStream.error) throw waitStream.error; return waitStream.frames.some(frame => frame.type === 'snapshot'); });
  await prompt(waiting.sessionId, 'WSL_POC_WAIT');
  await until(() => waitStream.frames.some(frame => frame.type === 'event' && frame.event.type === 'request/header'));
  await rpc('session/cancel', { request: { sessionId: waiting.sessionId } });
  await until(() => waitStream.frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'));
  const end = waitStream.frames.find(frame => frame.type === 'event' && frame.event.type === 'turn/end').event;
  assert.notEqual(end.data.reason?.kind, 'completed');
  await prompt(created.sessionId, 'Continue this Linux session without using tools.');
  await until(() => stream.frames.filter(frame => frame.type === 'event' && frame.event.type === 'turn/end').length >= 2);
  report.checks.push({ name: 'cancel-is-per-session-and-does-not-stop-linux-host', cancelled: waiting.sessionId, continued: created.sessionId, end: end.data });
  for (const item of collectors) item.abort.abort();
  await Promise.all(collectors.map(item => item.done));
  await stop();
  // EOF-driven shutdown is asynchronous across wsl.exe; wait for its owned lock.
  const { WslController } = await import(pathToFileURL(backendInfo.module).href);
  const maintenance = new WslController();
  await until(async () => { const state = await maintenance.maintenance({ distro: 'Ubuntu', action: 'status' }); return state.state === 'absent'; }, 25000);
  await start();
  const resumed = collect('session/follow', { request: { address: { kind: 'session', sessionId: created.sessionId }, assistantStream: true } });
  await until(() => { if (resumed.error) throw resumed.error; return resumed.frames.some(frame => frame.type === 'snapshot'); }, 95000);
  assert.equal(resumed.frames[0].header.id, created.sessionId);
  assert.ok(JSON.stringify(resumed.frames[0].records).includes('Linux'));
  await prompt(created.sessionId, 'Resume after Host restart.');
  await until(() => resumed.frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'));
  report.checks.push({ name: 'host-restart-retains-runtime-map-history-and-same-session', sessionId: created.sessionId });
  const restoredBlank = collect('session/follow', { request: { address: { kind: 'session', sessionId: blank.sessionId }, assistantStream: true } });
  await until(() => { if (restoredBlank.error) throw restoredBlank.error; return restoredBlank.frames.some(frame => frame.type === 'snapshot'); });
  assert.equal(restoredBlank.frames[0].header.id, blank.sessionId);
  assert.ok(JSON.stringify(restoredBlank.frames[0].records).includes('Switch this unused session to Linux.'));
  report.checks.push({ name: 'migrated-blank-session-restores-linux-history-after-restart', sessionId: blank.sessionId });
  const runtimeStatus = await fetch(base + '/api/dsh-wsl-native-runtime/status', { headers: { cookie } }).then(response => response.json());
  assert.deepEqual(runtimeStatus.localWslAgents, []);
  if (hostModel) { assert.ok(mock.evidence.requests > 1); assert.ok(mock.evidence.cancelled > 0); }
  else assert.equal(mock.evidence.requests, 1);
  report.checks.push({ name: 'wsl-execution-never-creates-windows-agent-or-model-request', localWslAgents: runtimeStatus.localWslAgents, windowsModelRequests: mock.evidence.requests });
  if (packedPlugin) {
    for (const item of collectors) item.abort.abort();
    await Promise.all(collectors.map(item => item.done));
    await stop();
    const mapping = await readFile(join(home, 'native-wsl-routes.json'), 'utf8');
    await exec(exe, ['--expose-internals', cli, 'plugin', '--profile', 'web', 'remove', 'dsh-wsl-native'], { env, windowsHide: true, timeout: 60000 });
    assert.equal(await readFile(join(home, 'native-wsl-routes.json'), 'utf8'), mapping);
    assert.equal(await readFile(join(workspace, 'WSL原型 回写验证.txt'), 'utf8'), 'Linux DSH 工具回写成功\n');
    await start();
    const removedStatus = await fetch(base + '/api/dsh-wsl-native-runtime/status', { headers: { cookie } });
    assert.equal(removedStatus.status, 404);
    assert.ok(!(await rpc('agentPresets/list')).presets.some(row => row.id === 'wsl'));
    const beforeUninstallRoundtrip = mock.evidence.requests;
    const clean = await rpc('session/create', { request: { cwd: workspace, agentPreset: 'standard' } });
    await prompt(clean.sessionId, 'Standard mode after native plugin removal.');
    await until(async () => mock.evidence.requests > beforeUninstallRoundtrip && (await rpc('session/list', { _request: {} })).items.some(row => row.sessionId === clean.sessionId && !row.running && !row.blank));
    report.checks.push({ name: 'official-plugin-removal-restores-builtins-and-preserves-project-and-mapping', sessionId: clean.sessionId });
  }
  report.linuxRoutingImplemented = true;
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack; process.exitCode = 1; if (base && cookie) report.diagnostics = await fetch(base + '/api/dsh-wsl-native-runtime/status', { headers: { cookie } }).then(response => response.json()).catch(() => null); if (!backendInfo && report.diagnostics?.managedBackend) backendInfo = report.diagnostics.managedBackend; }
finally {
  for (const item of collectors) item.abort.abort();
  await Promise.all(collectors.map(item => item.done));
  try { await stop(); } catch (error) { report.cleanupError = error.message; report.ok = false; process.exitCode = 1; }
  if (backendInfo) {
    try {
      const { WslController } = await import(pathToFileURL(backendInfo.module).href);
      const maintenance = new WslController();
      await until(async () => { report.cleanupLock = await maintenance.maintenance({ distro: 'Ubuntu', action: 'status' }); return report.cleanupLock.state === 'absent'; }, 25000);
    } catch (error) { report.cleanupError = error.message; report.ok = false; process.exitCode = 1; }
  }
  mock?.server.closeAllConnections(); mock?.server.close();
  await writeFile(join(root, packedPlugin ? 'artifacts/native-plugin-' + (hostModel ? 'host-model' : 'mock') + '-evidence.json' : 'artifacts/native-runtime-evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
