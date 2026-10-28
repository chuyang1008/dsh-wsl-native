// Stage-one probe only. Never mount this bundle in a normal user profile.
export const name = 'dsh-wsl-native-probe';
export const inject = ['agentPresets', 'sessionProjections', 'connection'];
export const presetId = 'wsl';
export function apply(ctx) {
  if (process.platform !== 'win32') throw new Error('Native entry probe requires the Windows Host');
  if (process.env.DSH_WSL_NATIVE_ENTRY_PROBE !== '1') throw new Error('Use the isolated native-entry verification launcher');
  const blocked = [];
  // Register the guard before publishing the selectable entry. It also covers
  // blank-session preset changes and sessions resumed from durable history.
  ctx.on('agent/pre-step', ({ agent }, next) => {
    const selected = ctx.sessionProjections.stateOf(agent.session, 'agentPreset') ?? agent.session.header.agentPreset;
    if (selected !== presetId) return next();
    blocked.push({ sessionId: agent.id, selected, platform: process.platform });
    throw new Error('WSL_NATIVE_ROUTING_NOT_IMPLEMENTED：此模式仅验证原生入口；Linux 会话路由尚未接入。');
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-wsl-native-probe/evidence', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({ blocked }, { headers: { 'cache-control': 'no-store' } }),
  }), 'wsl-native-probe: authenticated verification evidence');
  ctx.effect(async function* () {
    yield await ctx.agentPresets.register({
      id: presetId,
      name: 'WSL 模式',
      description: '原生入口验证阶段：尚未连接 Linux Host，任务执行暂不可用。',
      order: 2,
      plugins: [],
    });
  }, 'wsl-native-probe: preset declaration');
}
