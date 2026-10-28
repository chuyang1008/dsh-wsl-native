import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
if (process.platform !== 'win32') throw new Error('WSL mode requires the Windows Desktop Host');
const vendorRequire = createRequire(join(dirname(process.execPath), 'resources/app.asar/dsh/package.json'));
const installed = vendorRequire('@deepseek-ai/dsh-api-session-controller/package.json').version;
if (installed !== '0.2.1-rc.3') throw new Error('dsh-wsl-native requires DSH 0.2.1-rc.3; installed: ' + installed);
export async function vendor(name) { return import(pathToFileURL(vendorRequire.resolve(name)).href); }
export const WebSocket = vendorRequire('ws');
