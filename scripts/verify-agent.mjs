import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMock } from './mock-provider.mjs';
import { mockPatch } from './mock-config.mjs';
const [workspace, root] = process.argv.slice(2);
const mock = await startMock();
const home = join(root, 'instances/verify/home');
const cli = join(root, 'runtimes/dsh-0.2.1-rc.3/node_modules/@deepseek-ai/dsh/lib/bin.js');
const env = { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write', DSH_WSL_POC_MOCK_KEY: 'poc-local-only' };
let child;
try {
  await mkdir(workspace, { recursive: true });
  execFileSync(process.execPath, [cli, 'headless', '--dump-config'], { env, cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'] });
  await writeFile(join(home, 'profiles/headless/cordis.patch.yml'), mockPatch(mock.port));
  child = spawn(process.execPath, [cli, 'headless', '--json', 'WSL_POC_VERIFY'], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostics = '';
  child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { diagnostics += x; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  const file = await readFile(join(workspace, 'WSL原型 回写验证.txt'), 'utf8').catch(() => null);
  const report = { test: 'real-linux-dsh-agent-with-mock-provider', platform: process.platform, node: process.version, code, workspace, file, ...mock.evidence, output, diagnostics };
  await writeFile(join(workspace, 'agent-evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (code !== 0 || file !== 'Linux DSH 工具回写成功\n' || !output.includes('WSL_POC_COMPLETE') || !mock.evidence.toolResults.some(x => JSON.stringify(x).includes('Linux'))) process.exitCode = 1;
} finally { if (child?.exitCode === null) child.kill('SIGTERM'); mock.server.closeAllConnections(); mock.server.close(); }
