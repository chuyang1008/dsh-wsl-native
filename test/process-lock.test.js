import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLock, recoverLock, releaseGuardianLock } from '../scripts/process-lock.mjs';

test('recovery refuses live owners, live orphan backends, legacy and incomplete locks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lock-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proc = join(root, 'proc');
  await mkdir(join(root, 'instances'), { recursive: true });
  await mkdir(join(proc, 'sys/kernel/random'), { recursive: true });
  await writeFile(join(proc, 'sys/kernel/random/boot_id'), 'boot-one');
  const identity = { pid: 100, startTicks: '777', bootId: 'boot-one' };
  await mkdir(join(proc, '100'));
  // Include spaces and ')' in comm, which must not shift the start-time field.
  const fields = ['S', '1', ...Array(17).fill('0'), '777', '0'];
  await writeFile(join(proc, '100/stat'), '100 (agent (worker)) ' + fields.join(' '));
  const path = join(root, 'instances/poc.lock');
  const save = record => writeFile(path, JSON.stringify(record));
  const base = { schema: 2, runId: 'test-owned-run', phase: 'running', supervisor: { ...identity, pid: 101 }, backend: identity };
  await save({ ...base, supervisor: identity });
  assert.equal((await inspectLock(root, proc)).state, 'active');
  await assert.rejects(recoverLock(root, proc));
  await save(base);
  assert.equal((await inspectLock(root, proc)).state, 'active');
  await assert.rejects(recoverLock(root, proc));
  for (const record of [{ pid: 101 }, { ...base, phase: 'spawning', backend: null }, { ...base, supervisor: {} }]) {
    await save(record);
    assert.equal((await inspectLock(root, proc)).state, 'unknown');
    await assert.rejects(recoverLock(root, proc));
    assert.deepEqual(JSON.parse(await readFile(path)), record);
  }
  // A recycled PID or a different boot is not the recorded owner.
  for (const backend of [{ ...identity, startTicks: '776' }, { ...identity, bootId: 'previous-boot' }]) {
    await save({ ...base, backend });
    assert.equal((await inspectLock(root, proc)).state, 'stale');
    assert.equal((await recoverLock(root, proc)).state, 'recovered');
    assert.equal((await inspectLock(root, proc)).state, 'absent');
  }
  const guarded = { ...base, schema: 3, guardian: identity };
  await save({ ...guarded, backend: { ...identity, pid: 102 } });
  assert.equal((await inspectLock(root, proc)).state, 'active');
  await assert.rejects(releaseGuardianLock(root, { ...identity, startTicks: 'wrong' }, base.supervisor));
  await releaseGuardianLock(root, identity, base.supervisor);
  assert.equal((await inspectLock(root, proc)).state, 'absent');
  await save({ ...guarded, guardian: { ...identity, pid: 103 }, backend: { ...identity, pid: 102 } });
  assert.equal((await inspectLock(root, proc)).state, 'unknown');
  await assert.rejects(recoverLock(root, proc));
  await writeFile(join(proc, 'sys/kernel/random/boot_id'), 'boot-two');
  assert.equal((await recoverLock(root, proc)).state, 'recovered');
});
