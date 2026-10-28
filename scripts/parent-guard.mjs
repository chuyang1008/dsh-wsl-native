import { pathToFileURL } from 'node:url';
const [parent, entry, ...args] = process.argv.slice(2);
// setpriv installs PR_SET_PDEATHSIG before exec. Check the pre-prctl race too.
if (process.ppid !== Number(parent)) process.exit(1);
process.argv = [process.execPath, entry, ...args];
const { runCli } = await import(pathToFileURL(entry).href);
if (typeof runCli !== 'function') throw new Error('Pinned DSH runtime has no runCli entry');
await runCli();
