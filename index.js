import { WslController } from './controller.js';
import { ModelBroker } from './model-broker.js';
import { applyLinux } from './linux-host.js';
export const name = 'dsh-wsl-poc';
export const inject = ['connection', 'llm'];
export function apply(ctx) {
  if (process.platform === 'linux') { applyLinux(ctx); return; }
  const broker = new ModelBroker(ctx.llm);
  const controller = new WslController({ broker });
  const routes = {
    status: ['GET', async () => controller.snapshot()],
    distros: ['GET', async () => ({ distros: await controller.distros() })],
    models: ['GET', async () => broker.catalog()],
    start: ['POST', async request => controller.start(await request.json())],
    open: ['POST', async () => controller.open()],
    import: ['POST', async request => {
      if (Number(request.headers.get('content-length')) > 15 * 1024 * 1024) throw new Error('导入请求过大');
      const body = await request.text();
      if (body.length > 15 * 1024 * 1024) throw new Error('导入请求过大');
      return controller.import(JSON.parse(body));
    }],
    stop: ['POST', async () => controller.stop()],
    maintenance: ['POST', async request => controller.maintenance(await request.json())],
  };
  for (const [path, [method, handler]] of Object.entries(routes)) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/dsh-wsl-poc/' + path, methods: [method], requestBody: 'buffered',
      fetch: async request => {
        try { return Response.json(await handler(request), { headers: { 'cache-control': 'no-store' } }); }
        catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
      },
    }), 'dsh-wsl-poc: ' + path);
  }
  ctx.effect(() => () => controller.stop(), 'dsh-wsl-poc: stop owned Linux backend');
}
