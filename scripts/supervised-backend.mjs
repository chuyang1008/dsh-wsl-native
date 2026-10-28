import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { startMock } from './mock-provider.mjs';
import { mockPatch } from './mock-config.mjs';
import { startStdioRelay } from './stdio-relay.mjs';
import { acquireLock, processIdentity } from './process-lock.mjs';
const [workspaceArg, root] = process.argv.slice(2);
const workspace = resolve(workspaceArg);
if (!(await stat(workspace)).isDirectory()) throw new Error('Workspace must exist');
const lock = await acquireLock(root);
const parentGuard = fileURLToPath(new URL('./parent-guard.mjs', import.meta.url));
const guardedArgs = args => ['--pdeathsig', 'TERM', process.execPath, parentGuard, String(process.pid), cli, ...args];
const home = join(root, 'instances', 'poc', 'home');
const cli = join(root, 'runtimes', 'dsh-0.2.1-rc.3', 'node_modules', '@deepseek-ai/dsh/lib/bin.js');
let backend, mock, relay; let closing = false;
async function stop(code = 0) {
  if (closing) return; closing = true;
  relay?.close();
  if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
    backend.kill('SIGTERM');
    await Promise.race([new Promise(r => backend.once('exit', r)), new Promise(r => setTimeout(r, 6000))]);
    if (backend.exitCode === null && backend.signalCode === null) { backend.kill('SIGKILL'); await new Promise(r => backend.once('exit', r)); }
  }
  if (mock) {
    mock.server.closeAllConnections(); mock.server.close();
    await writeFile(join(root, 'instances', 'poc', 'last-mock-evidence.json'), JSON.stringify(mock.evidence, null, 2), { mode: 0o600 });
  }
  // Guardian retains the lock until adopted tool descendants are reaped too.
  process.exit(code);
}
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
process.stdout.on('error', () => void stop(1));
const send = frame => process.stdout.write('DSH_WSL_POC_FRAME ' + JSON.stringify(frame) + '\n');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let configure;
const configured = new Promise(resolve => { configure = resolve; });
input.on('line', line => {
  try {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('Frame too large');
    const frame = JSON.parse(line);
    if (frame.type === 'configure' && configure) { configure(frame); configure = undefined; }
    else relay?.receive(frame);
  } catch { process.stderr.write('Invalid supervisor frame\n'); void stop(1); }
});
input.on('close', () => void stop());
try {
  const timeout = setTimeout(() => { process.stderr.write('Missing supervisor configuration\n'); void stop(1); }, 15000);
  const config = await configured; clearTimeout(timeout);
  if (!['mock', 'host'].includes(config.mode)) throw new Error('Invalid model mode');
  const env = { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write', DSH_WSL_POC_BACKEND: '1', DSH_WSL_POC_MODEL_MODE: config.mode };
  let patch;
  if (config.mode === 'host') {
    if (!config.model?.id || !config.model?.provider) throw new Error('Missing Host model');
    relay = await startStdioRelay(send);
    Object.assign(env, { DSH_WSL_POC_MODEL_INFO: JSON.stringify(config.model), DSH_WSL_POC_RELAY_URL: relay.url, DSH_WSL_POC_RELAY_TOKEN: relay.token });
    patch = JSON.stringify([{ id: 'agent-default-model', config: { provider: 'wsl-host', model: config.model.id } }, { id: 'tool-bash', disabled: false }, { id: 'session-title-llm', disabled: true }]);
  } else {
    mock = await startMock(); env.DSH_WSL_POC_MOCK_KEY = 'poc-local-only'; patch = mockPatch(mock.port);
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  execFileSync('setpriv', guardedArgs(['web', '--dump-config']), { env, cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
  const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'));
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
  const packageInfo = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
  const version = packageInfo.version;
  const hash = createHash('sha256');
  for (const file of ['package.json', ...packageInfo.files]) { hash.update(file); hash.update(await readFile(join(pluginRoot, file))); }
  const stamp = JSON.stringify({ version, fingerprint: hash.digest('hex') });
  const versionFile = join(home, 'plugin-version');
  const installedVersion = await readFile(versionFile, 'utf8').catch(() => '');
  if (!profile.dsh?.profile?.bundles?.includes('dsh-wsl-poc') || installedVersion !== stamp) {
    execFileSync('setpriv', guardedArgs(['plugin', '--profile', 'web', 'add', pluginRoot, '--store-dir', join(root, 'cache/pnpm')]), { env, cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
    const installed = JSON.parse(await readFile(join(home, 'profiles/web/node_modules/dsh-wsl-poc/package.json'), 'utf8'));
    if (installed.version !== version) throw new Error('Linux plugin version did not synchronize');
    await writeFile(versionFile, stamp, { mode: 0o600 });
  }
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), patch, { mode: 0o600 });
  await lock.update({ phase: 'spawning' });
  backend = spawn('setpriv', guardedArgs(['web', '--no-open', '--host', '127.0.0.1', '--port', '0']), { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  // Install handlers before asynchronous identity persistence (including spawn errors).
  backend.once('error', () => { process.stderr.write('Linux DSH failed to start\n'); void stop(1); });
  backend.once('exit', code => { if (!closing) void stop(code ?? 1); });
  await lock.update({ phase: 'running', backend: await processIdentity(backend.pid) });
  let pending = ''; let announced = false; let backendUrl; let workspaceReady = false;
  backend.stdout.setEncoding('utf8'); backend.stderr.setEncoding('utf8');
  function log(chunk) {
    pending += chunk;
    for (;;) {
      const position = pending.indexOf('\n'); if (position < 0) break;
      const line = pending.slice(0, position); pending = pending.slice(position + 1);
      const match = line.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
      if (match) backendUrl = match[0];
      if (line.trim() === 'DSH_WSL_POC_WORKSPACE_READY') workspaceReady = true;
      if (backendUrl && workspaceReady && !announced) {
        announced = true;
        process.stdout.write('DSH_WSL_POC_READY ' + JSON.stringify({ url: backendUrl, platform: process.platform, node: process.version, pid: backend.pid }) + '\n');
      }
      process.stderr.write(line.replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]') + '\n');
    }
    if (pending.length > 32000) pending = pending.slice(-4000);
  }
  backend.stdout.on('data', log); backend.stderr.on('data', log);
} catch (error) { process.stderr.write(error.message + '\n'); await stop(1); }
