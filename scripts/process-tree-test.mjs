// Test helper: records only descendants of a proven private supervisor, never command lines.
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { identityAlive, processIdentity } from './process-lock.mjs';
const [action, root, runId] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(runId) || (await readFile(join(root, '.poc-owned'), 'utf8')).trim() !== 'dsh-wsl-poc-v1') throw new Error('Not a private test runtime');
const file = join(root, 'instances/poc', 'test-tree-' + runId + '.json');
if (action === 'snapshot') {
  const lock = JSON.parse(await readFile(join(root, 'instances/poc.lock'), 'utf8'));
  if (lock.runId !== runId || !await identityAlive(lock.supervisor)) throw new Error('Live test ownership mismatch');
  const parents = new Map();
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try { const text = await readFile('/proc/' + name + '/stat', 'utf8'); const fields = text.slice(text.lastIndexOf(') ') + 2).split(/\s+/); parents.set(Number(name), Number(fields[1])); } catch { /* Process already exited. */ }
  }
  const pids = new Set([lock.guardian?.pid ?? lock.supervisor.pid]);
  let changed = true;
  while (changed) { changed = false; for (const [pid, parent] of parents) if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; } }
  const members = (await Promise.all([...pids].map(async pid => {
    const identity = await processIdentity(pid); if (!identity) return null;
    const text = await readFile('/proc/' + pid + '/stat', 'utf8');
    const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/);
    const status = await readFile('/proc/' + pid + '/status', 'utf8');
    const ignored = status.match(/^SigIgn:\s+([a-fA-F0-9]+)/m)?.[1] ?? '0';
    return { ...identity, processGroupId: Number(fields[2]), sessionId: Number(fields[3]), ignoresSigterm: (BigInt('0x' + ignored) & (1n << 14n)) !== 0n };
  }))).filter(Boolean);
  const snapshot = { runId, members };
  await writeFile(file, JSON.stringify(snapshot), { mode: 0o600 });
  console.log(JSON.stringify(snapshot));
} else if (['status', 'cleanup', 'finalize-test'].includes(action)) {
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  if (snapshot.runId !== runId) throw new Error('Test snapshot ownership mismatch');
  const alive = [];
  for (const identity of snapshot.members) if (await identityAlive(identity)) alive.push(identity);
  if (action === 'cleanup') for (const identity of alive.reverse()) { if (await identityAlive(identity)) { try { process.kill(identity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } }
  if (action === 'finalize-test') {
    if (!root.endsWith('/dsh-wsl-poc-validation') || alive.length) throw new Error('Test finalization refused');
    const lockPath = join(root, 'instances/poc.lock');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    if (lock.runId !== runId) throw new Error('Lock changed');
    for (const identity of [lock.guardian, lock.supervisor, lock.backend].filter(Boolean)) if (await identityAlive(identity)) throw new Error('Test owner still alive');
    await unlink(lockPath);
  }
  console.log(JSON.stringify({ runId, alive }));
} else throw new Error('Invalid test action');
