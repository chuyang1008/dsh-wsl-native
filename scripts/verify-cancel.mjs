import { WslController } from '../controller.js';
import { writeFile } from 'node:fs/promises';
const controller = new WslController();
const starting = controller.start({ distro: 'Ubuntu', workspace: 'D:\\dsh\\wsl-poc\\scratch' });
const stopped = await controller.stop();
let result;
try { await starting; result = { ok: false, reason: 'Cancelled start unexpectedly succeeded' }; }
catch (error) { result = { ok: error.message === '启动已取消' && controller.snapshot().state === 'stopped', message: error.message, state: controller.snapshot().state }; }
await writeFile(new URL('../artifacts/cancel-evidence.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
