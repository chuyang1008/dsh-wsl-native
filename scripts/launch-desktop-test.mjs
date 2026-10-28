import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { startMock } from './mock-provider.mjs';
import { mockPatch } from './mock-config.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { home: { type: 'string' }, 'user-data-dir': { type: 'string' }, mock: { type: 'boolean', default: false } } });
const home = values.home ?? join(root, '.state/windows-home');
const userData = values['user-data-dir'] ?? join(root, '.state/desktop-userdata');
if (!isAbsolute(home) || !isAbsolute(userData)) throw new Error('Absolute profile paths required');
const mockMode = values.mock;
let mock;
if (mockMode) {
  const patchPath = join(home, 'profiles/desktop/cordis.patch.yml');
  const previous = await readFile(patchPath, 'utf8');
  const meaningful = previous.split('\n').filter(line => !line.trim().startsWith('#')).join('\n').trim();
  if (meaningful !== '[]' && !previous.startsWith('# POC-owned local mock provider; no real credentials\n')) throw new Error('Existing model configuration is preserved; use normal Launch, not --mock');
  mock = await startMock();
  const patch = mockPatch(mock.port).replace('- id: tool-bash\n  disabled: false\n', '');
  await writeFile(patchPath, '# POC-owned local mock provider; no real credentials\n' + patch);
}
const exe = join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/DeepSeek Harness.exe');
const env = { ...process.env, DSH_HOME: home, ...(mockMode ? { DSH_WSL_POC_MOCK_KEY: 'poc-local-only' } : {}) };
const child = spawn(exe, ['--user-data-dir=' + userData], { env, windowsHide: false, stdio: 'ignore' });
child.on('error', error => { console.error(error.message); mock?.server.close(); process.exitCode = 1; });
child.on('exit', code => { mock?.server.closeAllConnections(); mock?.server.close(); console.log('POC Desktop exited: ' + code); });
console.log('POC Desktop launched: pid=' + child.pid + ', mode=' + (mockMode ? 'local-mock' : 'preserve-configured-models'));
