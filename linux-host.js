// Mounted only inside the supervised Linux backend, through the normal plugin bundle.
export function applyLinux(ctx) {
  ctx.inject(['workspaceController', 'webServer'], async inner => {
    const { workspace } = await inner.workspaceController.create({ path: process.cwd() });
    inner.on('webserver/index-inject', table => table.push({ kind: 'global', name: '__DSH_WSL_BOOT__', value: { workspaceId: workspace.workspaceId, path: workspace.path } }));
    process.stdout.write('DSH_WSL_POC_WORKSPACE_READY\n');
  });
  if (process.env.DSH_WSL_POC_MODEL_MODE !== 'host') return;
  ctx.inject(['llm'], inner => {
    const metadata = JSON.parse(process.env.DSH_WSL_POC_MODEL_INFO);
    const address = process.env.DSH_WSL_POC_RELAY_URL;
    const token = process.env.DSH_WSL_POC_RELAY_TOKEN;
    const info = { ...metadata, provider: 'wsl-host', name: 'Windows · ' + metadata.name };
    const adapter = {
      providerInfo: provider => ({ id: provider, name: 'Windows Host 模型' }),
      providerRetryPolicy: () => undefined,
      imageRequestPricing: () => undefined,
      imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
      listModels: async () => [info],
      resolveModel: async (_p, model) => { if (model !== info.id) throw new Error('Unknown Host model'); return info; },
      prepareCall: async (p, model, signal) => ({ model: await adapter.resolveModel(p, model, signal), stream: options => adapter.stream(options) }),
      async *stream(options) {
        const { signal, ...request } = options;
        const response = await fetch(address, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(request), signal });
        if (!response.ok) throw new Error('Windows 模型桥不可用：' + response.status);
        let buffer = ''; let ended = false; const decoder = new TextDecoder();
        for await (const bytes of response.body) {
          buffer += decoder.decode(bytes, { stream: true });
          for (;;) {
            const position = buffer.indexOf('\n'); if (position < 0) break;
            const event = JSON.parse(buffer.slice(0, position)); buffer = buffer.slice(position + 1);
            if (event.type === 'chunk') yield event.chunk;
            else if (event.type === 'error') throw new Error('Windows 模型桥请求失败');
            else if (event.type === 'end') ended = true;
          }
          if (buffer.length > 8 * 1024 * 1024) throw new Error('Model bridge frame too large');
        }
        if (!ended) throw new Error('Windows 模型桥连接提前关闭');
      },
    };
    inner.effect(() => inner.llm.registerAdapter(['wsl-host'], adapter), 'wsl-poc: Host model adapter');
  });
}
