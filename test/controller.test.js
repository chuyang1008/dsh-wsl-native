import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOptions } from '../controller.js';
test('Host mode requires a concrete model selection and unknown modes are refused', () => {
  for (const input of [{ mode: 'external' }, { mode: 'host' }, { mode: 'host', selection: { provider: 'p', model: '' } }]) assert.throws(() => validateOptions({ workspace: 'D:\\test', ...input }));
  assert.deepEqual(validateOptions({ workspace: 'D:\\test', mode: 'host', selection: { provider: 'p', model: 'm', url: 'ignored' } }).selection, { provider: 'p', model: 'm' });
});
test('Windows paths remain argv data, including spaces and shell punctuation', () => {
  assert.equal(validateOptions({ workspace: 'D:\\中文 项目\\a&b;$(x)' }).workspace, 'D:\\中文 项目\\a&b;$(x)');
});
test('reject ambiguous paths and managed service distributions', () => {
  for (const workspace of ['relative', '/mnt/d/test', '\\\\server\\share', 'D:relative', 'D:\\x\n']) assert.throws(() => validateOptions({ workspace }));
  for (const distro of ['docker-desktop', '-d', 'Ubuntu\n']) assert.throws(() => validateOptions({ distro, workspace: 'D:\\test' }));
});
