import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const app = (process.env.LOCALAPPDATA + '/Programs/DeepSeek Harness');
const previous = JSON.parse(await readFile(resolve('wsl-poc/artifacts/active-cleanup-evidence.json'), 'utf8'));
if (!previous.ok) throw new Error('Cleanup matrix must pass first');
const targets = previous.cases.filter(value => ['windows-host-crash-detached', 'linux-supervisor-crash-detached'].includes(value.scenario));
if (targets.length !== 2) throw new Error('Missing crash fixtures');
const report = { test: 'resume-persisted-sessions-after-owned-host-and-supervisor-crashes', version: '0.0.4', realModelRequests: 0, cases: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 20000; do { if (await check()) return; await pause(150); } while (Date.now() < deadline); throw new Error('Resume deadline exceeded'); }
async function auth(url) { const response = await fetch(url, { redirect: 'manual' }); if (response.status !== 303) throw new Error('Auth exchange failed'); return response.headers.get('set-cookie').split(';')[0]; }
async function rpc(base, cookie, method, args) { const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(15000) }); const value = await response.json(); if (!value.result?.ok) throw new Error(method + ' failed'); return value.result.value; }
const host = spawn(app + '/DeepSeek Harness.exe', ['--expose-internals', app + '/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: resolve('wsl-poc/.state/cleanup-validation-home'), DSH_WSL_POC_MOCK_KEY: 'poc-local-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
let api;
try {
  const url = await new Promise((ready, reject) => { let buffer = ''; const timer = setTimeout(() => reject(new Error('Host startup deadline')), 30000); const log = bytes => { buffer += bytes; const found = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (found) { clearTimeout(timer); ready(found[0]); } }; host.stdout.on('data', log); host.stderr.on('data', log); host.once('error', reject); });
  const base = new URL(url).origin; const cookie = await auth(url);
  api = async (path, body) => { const response = await fetch(base + '/api/dsh-wsl-poc/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(95000) }); const value = await response.json(); if (!response.ok) throw new Error(path + ' failed'); return value; };
  for (const target of targets) {
    const result = { scenario: target.scenario, previousSessionId: target.sessionId }; report.cases.push(result);
    await api('start', { distro: 'Ubuntu', workspace: target.workspace, mode: 'mock' });
    const guest = await api('open', {}); const guestBase = new URL(guest.url).origin; const guestCookie = await auth(guest.url);
    await until(async () => (await rpc(guestBase, guestCookie, 'session/list', { _request: {} })).items.some(value => value.sessionId === target.sessionId && !value.running));
    result.crashedSessionRestoredAndNotRunning = true;
    const workspace = await rpc(guestBase, guestCookie, 'workspace/create', { request: { path: '/mnt/d/' + target.workspace.slice(3).replaceAll('\\', '/') } });
    const session = await rpc(guestBase, guestCookie, 'session/create', { request: { workspaceId: workspace.workspace.workspaceId } });
    await rpc(guestBase, guestCookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: 'WSL_POC_VERIFY' }] } });
    await until(async () => (await readFile(resolve(target.workspace, 'WSL原型 回写验证.txt'), 'utf8').catch(() => '')) === 'Linux DSH 工具回写成功\n' && (await rpc(guestBase, guestCookie, 'session/list', { _request: {} })).items.some(value => value.sessionId === session.sessionId && !value.running));
    result.newToolRoundTripPassed = true;
    result.stopped = (await api('stop', {})).state;
  }
  report.ok = report.cases.every(value => value.crashedSessionRestoredAndNotRunning && value.newToolRoundTripPassed && value.stopped === 'stopped');
} catch (error) { report.error = error.message; report.ok = false; }
finally { if (api) await api('stop', {}).catch(() => {}); host.kill('SIGTERM'); await writeFile(resolve('wsl-poc/artifacts/crash-resume-evidence-0.0.4.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
if (!report.ok) process.exitCode = 1;
