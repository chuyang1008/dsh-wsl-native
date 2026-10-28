import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectLock, recoverLock } from './process-lock.mjs';
const [action, root] = process.argv.slice(2);
if ((await readFile(join(root, '.poc-owned'), 'utf8')).trim() !== 'dsh-wsl-poc-v1') throw new Error('Not an owned runtime');
try {
  if (!['--status', '--recover'].includes(action)) throw new Error('Invalid management action');
  console.log(JSON.stringify(action === '--status' ? await inspectLock(root) : await recoverLock(root)));
} catch (error) { console.error(error.message); process.exitCode = 1; }
