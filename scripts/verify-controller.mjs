import { mkdir, writeFile } from 'node:fs/promises';
import { WslController } from '../controller.js';
const workspace = process.argv[2];
await mkdir(workspace, { recursive: true });
const controller = new WslController();
const report = { test: 'windows-controller-real-linux-web', steps: [] };
try {
  const started = await controller.start({ distro: 'Ubuntu', workspace });
  report.steps.push({ name: 'start', ...started });
  const { url } = controller.open();
  const auth = await fetch(url, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  const origin = new URL(url).origin;
  const index = await fetch(origin, { headers: { cookie } });
  const page = await index.text();
  report.steps.push({ name: 'authenticate-and-serve-ui', exchange: auth.status, status: index.status, html: page.includes('__DSH_BOOT__') || page.includes('DeepSeek') });
  const noAuth = await fetch(origin + '/api/remote.mux');
  report.steps.push({ name: 'api-denies-unauthenticated', status: noAuth.status });
  if (auth.status !== 303 || index.status !== 200 || noAuth.status !== 401) throw new Error('Linux UI/auth check failed');
} catch (error) { report.error = error.stack; report.cause = String(error.cause ?? ''); process.exitCode = 1; }
finally {
  report.stopped = await controller.stop();
  report.ok = !report.error && report.stopped.state === 'stopped';
  if (!report.ok) process.exitCode = 1;
  await writeFile(new URL('../artifacts/controller-evidence.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
