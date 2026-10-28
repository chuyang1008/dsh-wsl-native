// Test-only: SIGKILL exactly the supervisor whose run ID the test just observed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identityAlive } from './process-lock.mjs';
const [root, expectedRunId] = process.argv.slice(2);
const lock = JSON.parse(await readFile(join(root, 'instances/poc.lock'), 'utf8'));
if (![2, 3].includes(lock.schema) || lock.runId !== expectedRunId || !(await identityAlive(lock.supervisor))) throw new Error('Test ownership mismatch');
process.kill(lock.supervisor.pid, 'SIGKILL');
console.log('owned-supervisor-killed');
