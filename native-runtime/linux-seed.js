// Copied into the isolated Linux backend only; no Windows package dependencies.
export function applySeedEndpoint(ctx) {
  ctx.inject(['connection', 'agents', 'agentPresets', 'sessionProjections'], inner => {
    inner.effect(() => inner.connection.fetch.register({
      path: '/api/dsh-wsl-native-runtime/seed', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        try {
          const raw = await request.text();
          if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Blank-session seed exceeds limit');
          const body = JSON.parse(raw);
          if (!/^session-[a-f0-9-]{36}$/.test(body.sessionId) || !Array.isArray(body.events)) throw new Error('Invalid blank session seed');
          if (body.events.some((event, index) => event.seq !== index || /^(turn\/|step\/|request\/|user\/|assistant\/|tool\/)/.test(event.type))) throw new Error('Only an unused blank session can change hosts');
          const existing = inner.agents.get(body.sessionId);
          if (existing) throw new Error('Seed identity already exists');
          await inner.agents.create({
            sessionId: body.sessionId, seed: body.events,
            meta: { cwd: process.cwd(), createdAt: body.createdAt, agentPreset: 'wsl' },
            agentOptions: { provider: 'wsl-poc', model: 'poc-model' },
            setup: async agentCtx => { await inner.agentPresets.mount(agentCtx, 'wsl'); },
          });
          return Response.json({ sessionId: body.sessionId, agentPreset: 'wsl' });
        } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
      },
    }), 'native-runtime: seed unused session');
  });
}
