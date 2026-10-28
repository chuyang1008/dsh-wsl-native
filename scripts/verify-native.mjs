import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.argv[2];
const runtime = join(root, 'runtimes/dsh-0.2.1-rc.3');
const require = createRequire(join(runtime, 'package.json'));
const report = { platform: process.platform, node: process.version };
try {
  const pty = require('node-pty');
  const terminal = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'printf DSH_PTY_OK'], { env: { PATH: '/usr/bin:/bin' } });
  let output = ''; terminal.onData(x => { output += x; });
  const timer = setTimeout(() => terminal.kill(), 5000);
  const exited = await new Promise(resolve => terminal.onExit(resolve)); clearTimeout(timer);
  report.terminal = { output, ...exited, ok: output.includes('DSH_PTY_OK') && exited.exitCode === 0 };
} catch (e) { report.terminal = { ok: false, error: e.message }; }
try { const ffi = require('koffi'); report.koffi = { ok: true, version: ffi.version }; }
catch (e) { report.koffi = { ok: false, error: e.message }; }
console.log(JSON.stringify(report, null, 2));
await writeFile(new URL('../artifacts/native-evidence.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('DSH spawn helper installer source:\n' + (await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs'), 'utf8')).slice(0, 7000));
if (!report.terminal.ok || !report.koffi.ok) process.exitCode = 1;
