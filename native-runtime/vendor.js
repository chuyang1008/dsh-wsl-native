import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
if (process.platform !== 'win32' || process.env.DSH_WSL_NATIVE_RUNTIME_PROBE !== '1') throw new Error('Isolated Windows runtime probe launcher required');
// Resolve the installed Host's own modules, preserving Cordis class identity.
// This version-pinned feasibility probe does not modify or copy vendor code.
const vendorRequire = createRequire(join(dirname(process.execPath), 'resources/app.asar/dsh/package.json'));
export async function vendor(name) { return import(pathToFileURL(vendorRequire.resolve(name)).href); }
export const WebSocket = vendorRequire('ws');
