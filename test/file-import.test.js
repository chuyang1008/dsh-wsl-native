import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { decodeFiles, importFiles, MAX_IMPORT_BYTES } from '../file-import.js';
const file = (name, bytes = Buffer.from('中文\r\n\0binary')) => ({ name, base64: bytes.toString('base64') });

test('imports preserve bytes and isolate repeat names without overwriting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-import-test-'));
  try {
    const a = await importFiles(root, '/mnt/d/中文 工作区', [file('数据 文件.txt')]);
    const b = await importFiles(root, '/mnt/d/中文 工作区', [file('数据 文件.txt', Buffer.from('second'))]);
    assert.notEqual(a.files[0].windowsPath, b.files[0].windowsPath);
    assert.deepEqual(await readFile(a.files[0].windowsPath), Buffer.from('中文\r\n\0binary'));
    assert.match(a.files[0].linuxPath, /^\/mnt\/d\/中文 工作区\/\.dsh-import-[^/]+\/数据 文件.txt$/);
  } finally { await rm(root, { recursive: true }); }
});
test('rejects traversal, reserved names, collisions, corrupt encodings and oversize batches', () => {
  for (const name of ['../escape', '..', 'C:evil', 'bad\\file', 'NUL.txt', 'COM1', 'bad.', 'bad\nname']) assert.throws(() => decodeFiles([file(name)]));
  assert.throws(() => decodeFiles([file('A.txt'), file('a.txt')]));
  assert.throws(() => decodeFiles([file('é'), file('e\u0301')]));
  for (const base64 of ['???=', 'A===', 'Zg', 'Zh==']) assert.throws(() => decodeFiles([{ name: 'a', base64 }]));
  assert.throws(() => decodeFiles([file('a', Buffer.alloc(MAX_IMPORT_BYTES)), file('b', Buffer.from('b'))]));
  assert.equal(decodeFiles([file('empty', Buffer.alloc(0))])[0].bytes.length, 0);
});
test('environment change rolls back only files created by this batch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-import-test-')); let calls = 0;
  try {
    await assert.rejects(importFiles(root, '/mnt/d/test', [file('a'), file('b')], () => { if (++calls === 3) throw new Error('changed'); }), /changed/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true }); }
});
test('workspace junctions cannot redirect imported files away from mapped location', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-import-test-'));
  try {
    const target = path.join(root, 'actual'); await mkdir(target);
    const link = path.join(root, 'link'); await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(importFiles(link, '/mnt/d/link', [file('a')]), /Junction/);
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(root, { recursive: true }); }
});
test('guest public UI bridge appends file draft without prompting a model or replacing existing draft', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const files = ['/mnt/d/test/.dsh-import-Ab1234/中文 文件.txt']; const calls = [];
  const store = value => ({ getSnapshot: () => value, subscribe: () => () => {} });
  const inner = {
    workspaces: { list: store({ phase: 'ready', items: [{ workspaceId: 'w', sessionIds: [] }], archivedSessionIds: [] }) },
    sessions: { list: store({ phase: 'ready', byId: {} }) },
    uiWorkspace: { startSession: (...args) => calls.push(args) },
    effect: fn => fn(),
  };
  let plugin;
  vm.runInNewContext(source, {
    window: { __DSH_WSL_BOOT__: { workspaceId: 'w', path: '/mnt/d/test' }, __ModuleLoader__: { load: value => { plugin = value.factory(() => ({})); } } },
    location: { hash: '#' + new URLSearchParams({ wslImport: JSON.stringify(files) }), pathname: '/', search: '' },
    URLSearchParams, history: { replaceState: () => {} }, console,
  });
  plugin.apply({ inject: (_services, fn) => fn(inner) });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'w');
  assert.equal(calls[0][1].whenDraftExists, 'append');
  assert.ok(calls[0][1].prompt.includes(JSON.stringify(files[0])));
});
