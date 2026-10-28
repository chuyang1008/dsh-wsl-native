import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual refresh implementation without loading Electron vendors.
const source = await readFile(new URL('../native-runtime/linux-runtime.js', import.meta.url), 'utf8');
const Runtime = vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, '').replace('export class LinuxRuntime', 'class LinuxRuntime') + '\nLinuxRuntime');
function runtime() {
  const value = Object.create(Runtime.prototype);
  value.ready = Promise.resolve();
  value.records = { s: { sessionId: 's', summary: { sessionId: 's', updatedAt: 7 } } };
  value.ensure = () => { throw Error('Background refresh must not start WSL'); };
  return value;
}
test('cached sessions remain available without starting WSL', async () => {
  const value = runtime();
  assert.equal((await value.refresh())[0].sessionId, 's');
});
test('unavailable Linux Host preserves cached list and exposes error', async () => {
  const value = runtime();
  value.client = { rpc: async () => { throw Error('Host offline'); } };
  assert.equal((await value.refresh())[0].sessionId, 's');
  assert.equal(value.refreshError.message, 'Host offline');
});
test('caller cancellation is propagated', async () => {
  const value = runtime();
  const signal = AbortSignal.abort();
  value.client = { rpc: async () => { throw signal.reason; } };
  await assert.rejects(value.refresh(signal), { name: 'AbortError' });
});
test('atomic mapping save retries transient Windows locks without deleting committed data', async () => {
  let attempts = 0;
  let files = 0;
  const SaveRuntime = vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, '').replace('export class LinuxRuntime', 'class LinuxRuntime') + '\nLinuxRuntime', {
    mkdir: async () => {}, writeFile: async () => { files++; }, join: (...parts) => parts.join('/'),
    randomUUID: () => 'unique', setTimeout: callback => callback(),
    rename: async () => { if (++attempts < 3) throw Object.assign(Error('locked'), { code: 'EPERM' }); },
  });
  const value = Object.create(SaveRuntime.prototype);
  Object.assign(value, { store: 'mapping.json', records: {}, writes: Promise.resolve() });
  await value.save();
  assert.equal(files, 1);
  assert.equal(attempts, 3);
});
