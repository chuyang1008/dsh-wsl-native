import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WslController } from '../controller.js';
const exec = promisify(execFile);
const root = '/home/chuyang/.local/share/dsh-wsl-poc';
const workspace = 'D:\\dsh\\wsl-poc\\scratch\\recovery-run-03';
const controller = new WslController(); const competing = new WslController();
const report = { test: '0.0.3-real-linux-crash-recovery', steps: [] };
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  await mkdir(workspace, { recursive: true });
  assert.equal((await controller.maintenance({ action: 'status' })).state, 'absent');
  const started = await controller.start({ workspace });
  assert.equal(started.state, 'running');
  report.steps.push('real-linux-backend-started');
  await assert.rejects(controller.maintenance({ action: 'recover' }));
  await assert.rejects(competing.start({ workspace }));
  assert.equal(controller.snapshot().state, 'running');
  report.steps.push('concurrent-start-and-live-recovery-refused');
  const status = await competing.maintenance({ action: 'status' });
  assert.equal(status.state, 'active');
  const fault = await exec('wsl.exe', ['-d', 'Ubuntu', '--exec', root + '/runtimes/node-v24.21.0-linux-x64/bin/node', '/mnt/d/dsh/wsl-poc/scripts/fault-inject-owned.mjs', root, status.runId], { windowsHide: true, timeout: 10000 });
  assert.match(fault.stdout, /owned-supervisor-killed/);
  let after;
  for (let i = 0; i < 40; i++) {
    await pause(250);
    if (controller.snapshot().state === 'running') continue;
    after = await controller.maintenance({ action: 'status' });
    if (after.state === 'stale') break;
  }
  assert.equal(after?.state, 'stale');
  report.steps.push('sigkill-parent-death-cleaned-backend-and-left-provably-stale-lock');
  assert.equal((await controller.maintenance({ action: 'recover' })).state, 'recovered');
  assert.equal((await controller.start({ workspace })).state, 'running');
  report.steps.push('explicit-recovery-and-restart-passed');
  assert.equal((await controller.stop()).state, 'stopped');
  assert.equal((await controller.maintenance({ action: 'status' })).state, 'absent');
  const version = await exec('wsl.exe', ['-d', 'Ubuntu', '--exec', 'cat', root + '/instances/poc/home/plugin-version'], { windowsHide: true, timeout: 10000 });
  assert.equal(JSON.parse(version.stdout).version, '0.0.3');
  report.steps.push('linux-plugin-version-synchronized-and-normal-stop-released-lock');
  report.ok = true;
} catch (error) { report.error = error.message; report.logs = controller.snapshot().logs; report.ok = false; process.exitCode = 1; }
finally {
  await controller.stop(); await competing.stop();
  await writeFile(new URL('../artifacts/recovery-evidence-0.0.3.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
