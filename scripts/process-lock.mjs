import { readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function processIdentity(pid, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process identity');
  try {
    const stat = await readFile(join(procRoot, String(pid), 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (['Z', 'X'].includes(fields[0])) return null;
    if (!/^\d+$/.test(fields[19])) throw new Error('Invalid process stat');
    return { pid, startTicks: fields[19], bootId: (await readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim() };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
export async function identityAlive(identity, procRoot) {
  if (!identity || !Number.isSafeInteger(identity.pid) || typeof identity.startTicks !== 'string' || typeof identity.bootId !== 'string') throw new Error('Incomplete process identity');
  const current = await processIdentity(identity.pid, procRoot);
  return !!current && current.startTicks === identity.startTicks && current.bootId === identity.bootId;
}
export async function inspectLock(root, procRoot) {
  let record;
  try { record = JSON.parse(await readFile(join(root, 'instances/poc.lock'), 'utf8')); }
  catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'unknown' }; }
  if (![2, 3].includes(record.schema) || typeof record.runId !== 'string' || !['initializing', 'spawning', 'running'].includes(record.phase)) return { state: 'unknown', reason: 'legacy-or-invalid-lock' };
  try {
    if (record.schema === 3 && await identityAlive(record.guardian, procRoot)) return { state: 'active', runId: record.runId };
    if (await identityAlive(record.supervisor, procRoot)) return { state: 'active', runId: record.runId };
    if (record.backend && await identityAlive(record.backend, procRoot)) return { state: 'active', runId: record.runId };
    if (record.phase !== 'running' || !record.backend) return { state: 'unknown', reason: 'incomplete-backend-identity' };
    if (record.schema === 3 && record.guardian.bootId === (await readFile(join(procRoot ?? '/proc', 'sys/kernel/random/boot_id'), 'utf8')).trim()) return { state: 'unknown', reason: 'guardian-cleanup-unconfirmed' };
    return { state: 'stale', runId: record.runId };
  } catch { return { state: 'unknown', reason: 'process-identity-unavailable' }; }
}
// Caller holds the Linux kernel flock across acquire/update/release/recover.
export async function acquireLock(root) {
  const path = join(root, 'instances/poc.lock');
  const handle = await open(path, 'wx', 0o600).catch(() => { throw new Error('运行锁已存在；请检查后端，再使用“恢复陈旧锁”。活动或身份不明的进程不会被终止。'); });
  const guardianPid = Number(process.env.DSH_WSL_POC_GUARDIAN_PID);
  if (guardianPid !== process.ppid) { await handle.close(); throw new Error('Guardian parent mismatch; lock retained'); }
  const record = { schema: 3, runId: randomUUID(), phase: 'initializing', guardian: await processIdentity(guardianPid), supervisor: await processIdentity(process.pid), backend: null };
  await handle.writeFile(JSON.stringify(record)); await handle.close();
  async function update(patch) {
    Object.assign(record, patch);
    const temp = path + '.' + record.runId;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await rename(temp, path);
  }
  async function release() {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (existing.runId !== record.runId) throw new Error('Lock ownership changed');
    await unlink(path);
  }
  return { record, update, release };
}
export async function releaseGuardianLock(root, guardian, supervisor) {
  const path = join(root, 'instances/poc.lock');
  let record;
  try { record = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const matches = (a, b) => a && b && a.pid === b.pid && a.startTicks === b.startTicks && a.bootId === b.bootId;
  if (record.schema !== 3 || !matches(record.guardian, guardian) || !matches(record.supervisor, supervisor)) throw new Error('Guardian lock ownership mismatch');
  await unlink(path);
}
export async function recoverLock(root, procRoot) {
  const status = await inspectLock(root, procRoot);
  if (status.state === 'absent') return status;
  if (status.state !== 'stale') throw new Error('后端仍活动或锁身份不明；保留运行锁，未终止任何进程。');
  const path = join(root, 'instances/poc.lock');
  const record = JSON.parse(await readFile(path, 'utf8'));
  if (record.runId !== status.runId) throw new Error('Lock ownership changed');
  await unlink(path);
  return { state: 'recovered' };
}
