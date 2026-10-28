import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity, releaseGuardianLock } from './process-lock.mjs';

const [workspace, root] = process.argv.slice(2);
if (process.platform !== 'linux') throw new Error('Linux guardian required');
const require = createRequire(import.meta.url);
// Reuse the native FFI shipped and verified with the pinned private DSH runtime.
const koffi = require(join(root, 'runtimes/dsh-0.2.1-rc.3/node_modules/koffi'));
const libc = koffi.load(null);
const prctl = libc.func('int prctl(int, unsigned long, unsigned long, unsigned long, unsigned long)');
const waitpid = libc.func('int waitpid(int, void *, int)');
if (prctl(36, 1, 0, 0, 0) !== 0) throw new Error('Cannot enable Linux child subreaper');
const guardian = await processIdentity(process.pid);
let child, childIdentity, finishing = false, requested = false, escalation;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function directChildren() {
  const names = (await readFile('/proc/self/task/' + process.pid + '/children', 'utf8')).trim().split(/\s+/).filter(Boolean);
  const result = [];
  for (const name of names) {
    const pid = Number(name);
    if (pid === child?.pid) continue; // libuv owns the spawned supervisor's waitpid.
    try {
      const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
      if (Number(fields[1]) === process.pid) result.push({ pid, zombie: ['Z', 'X'].includes(fields[0]) });
    } catch (error) {
      // /proc can report ESRCH when a process exits between open and read.
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return result;
}
async function collectAdopted() {
  const termAt = new Map(); const deadline = Date.now() + 7000;
  for (;;) {
    const children = await directChildren();
    if (children.length === 0) return;
    for (const entry of children) {
      if (entry.zombie) { waitpid(entry.pid, null, 1); continue; }
      // A direct unreaped child cannot have its PID recycled; no unrelated
      // process is signalled, even when a tool created another session/group.
      const sentAt = termAt.get(entry.pid);
      const signal = sentAt === undefined ? 'SIGTERM' : Date.now() - sentAt >= 2000 ? 'SIGKILL' : undefined;
      if (signal) { try { process.kill(entry.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      if (sentAt === undefined) termAt.set(entry.pid, Date.now());
    }
    if (Date.now() > deadline) throw new Error('Owned child cleanup not confirmed; lock retained');
    await pause(80);
  }
}
async function finish(code) {
  if (finishing) return; finishing = true; clearTimeout(escalation);
  process.stdin.unpipe(child.stdin); process.stdin.pause();
  try {
    await collectAdopted();
    await releaseGuardianLock(root, guardian, childIdentity);
    if (!process.stderr.destroyed) process.stderr.write('DSH_WSL_POC_GUARDIAN_CLEAN\n');
    process.exit(code);
  } catch (error) {
    if (!process.stderr.destroyed) process.stderr.write(error.message + '\n');
    process.exit(1);
  }
}
function requestStop() {
  if (requested || finishing) return; requested = true;
  child?.stdin.end();
  escalation = setTimeout(() => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
  }, 7000);
}
process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop); process.on('SIGHUP', requestStop);
process.stdout.on('error', requestStop); process.stderr.on('error', requestStop);
child = spawn(process.execPath, [fileURLToPath(new URL('./supervised-backend.mjs', import.meta.url)), workspace, root], {
  env: { ...process.env, DSH_WSL_POC_GUARDIAN_PID: String(process.pid) }, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.on('error', () => {});
child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false });
process.stdin.pipe(child.stdin);
process.stdin.on('end', requestStop); process.stdin.on('error', requestStop);
child.once('error', () => { process.stderr.write('Supervisor failed to spawn\n'); void finish(1); });
child.once('exit', (code, signal) => { void finish(signal ? 1 : code ?? 1); });
childIdentity = await processIdentity(child.pid);
