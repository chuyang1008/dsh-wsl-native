import { vendor } from './vendor.js';
import { LinuxRuntime } from './linux-runtime.js';
import { runtimeState } from './state.js';
const { SessionController } = await vendor('@deepseek-ai/dsh-api-session-controller');
export default class NativeRuntimeController extends SessionController {
  static inject = [...SessionController.inject, 'connection', 'agentPresets'];
  constructor(ctx, config) {
    super(ctx, config);
    this.installNativeRuntime(ctx, config);
  }
  installNativeRuntime(ctx, config) {
    this.linux = new LinuxRuntime(ctx);
    const linux = this.linux;
    runtimeState.provider = this.linux;
    ctx.on('agent/pre-step', ({ agent }, next) => {
      if (this.linux.records[agent.id] || agent.session.header.agentPreset === 'wsl') throw new Error('WSL sessions must execute on their Linux Host; local fallback is forbidden');
      return next();
    });
    this.linux.broadcast = frame => this.controlState.broadcast(frame);
    ctx.effect(async function* () {
      yield await ctx.agentPresets.register({ id: 'wsl', name: 'WSL 模式', description: 'Linux Host 原生会话路由实验，仅支持单项目和文本输入。', order: 2, plugins: [] });
    }, 'native-runtime: WSL preset');
    let polling = false;
    const timer = setInterval(async () => {
      if (polling || linux.closed || !linux.client) return;
      polling = true;
      try { await linux.refresh(); } catch { /* foreground operations report backend failures */ }
      finally { polling = false; }
    }, 250);
    timer.unref();
    ctx.effect(() => async () => { clearInterval(timer); await linux.close(); }, 'native-runtime: stop owned backend');
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/dsh-wsl-native-runtime/status', methods: ['GET'], requestBody: 'buffered',
      fetch: async () => Response.json({ controller: 'native-runtime-subclass', platform: process.platform, backend: this.linux.backend?.snapshot() ?? { state: 'not-started' }, localWslAgents: Object.keys(this.linux.records).filter(id => ctx.agents.get(id)), routes: Object.values(this.linux.records).map(({ summary, ...row }) => row) }),
    }), 'native-runtime: authenticated status');
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/dsh-wsl-native-runtime/shutdown', methods: ['POST'], requestBody: 'buffered',
      fetch: async () => { await this.linux.close(); return Response.json({ stopped: true }); },
    }), 'native-runtime: isolated test shutdown');
  }
  async create(request) {
    if (request.agentPreset === 'wsl' || request.sessionId && await this.linux.route(request.sessionId)) return this.linux.create(request);
    return super.create(request);
  }
  async list(_request, signal) {
    const local = await super.list(_request, signal);
    await this.linux.ready.catch(error => {
      if (signal?.aborted) throw error;
      this.linux.refreshError = { message: String(error.message ?? error), time: Date.now() };
    });
    const remote = this.linux.cachedSummaries();
    const remoteIds = new Set(remote.map(row => row.sessionId));
    return { items: [...local.items.filter(row => !remoteIds.has(row.sessionId)), ...remote.filter(row => this.ctx.remoteAccess.allows({ kind: 'session', id: row.sessionId }))].sort((a, b) => b.updatedAt - a.updatedAt) };
  }
  async prompt(request, signal) {
    await this.linux.promoteSelected(request.sessionId);
    return await this.linux.route(request.sessionId) ? this.linux.call('session/prompt', request, signal) : super.prompt(request, signal);
  }
  async cancel(request) { return await this.linux.route(request.sessionId) ? this.linux.call('session/cancel', request) : super.cancel(request); }
  async updateQueue(request) { return await this.linux.route(request.sessionId) ? this.linux.call('session/updateQueue', request) : super.updateQueue(request); }
  async modelCatalog() {
    const catalog = await super.modelCatalog();
    if (this.linux.config?.modelMode !== 'host') return catalog;
    const selection = this.linux.backend?.snapshot().selection ?? this.ctx.agentDefaultModel.currentSelection();
    const model = catalog.groups.find(group => group.id === selection?.provider)?.models.find(model => model.id === selection.model);
    if (model && !catalog.groups.some(group => group.id === 'wsl-host')) {
      catalog.groups.push({ id: 'wsl-host', name: 'WSL · Windows Host 模型', models: [{ ...model, name: 'Windows · ' + model.name }] });
      catalog.routableProviders.push('wsl-host');
    }
    return catalog;
  }
  async selectModel(request) {
    const route = await this.linux.route(request.sessionId);
    const selection = this.linux.backend?.snapshot().selection ?? this.ctx.agentDefaultModel.currentSelection();
    if (route && this.linux.config?.modelMode === 'host') {
      if (request.model !== selection?.model || ![selection?.provider, 'wsl-host'].includes(request.provider)) throw new Error('WSL 会话目前只能使用启动后端时绑定的 Windows 模型；切换其它模型需要重启后端');
      return this.linux.call('session/selectModel', { ...request, provider: 'wsl-host' });
    }
    if (!route && request.provider === 'wsl-host') request = { ...request, provider: selection.provider };
    return route ? this.linux.call('session/selectModel', request) : super.selectModel(request);
  }
  async rename(request) { return await this.linux.route(request.sessionId) ? this.linux.call('session/rename', request) : super.rename(request); }
  async fork(request) {
    if (await this.linux.route(request.sessionId)) throw new Error('WSL fork routing is not implemented in this feasibility probe');
    return super.fork(request);
  }
  async attachment(request) {
    if (await this.linux.route(request.sessionId)) throw new Error('WSL attachment routing is not implemented in this feasibility probe');
    return super.attachment(request);
  }
  async projections(request, signal) { return await this.linux.route(request.sessionId) ? this.linux.call('session/projections', request, signal) : super.projections(request, signal); }
  async *follow(request, signal) {
    const id = request.address.kind === 'session' ? request.address.sessionId : request.address.parentSessionId;
    if (await this.linux.route(id)) yield* this.linux.follow(request, signal);
    else {
      const migrated = new AbortController();
      const callbacks = this.linux.followers.get(id) ?? new Set();
      this.linux.followers.set(id, callbacks);
      const notify = () => migrated.abort(); callbacks.add(notify);
      let cursor = -1;
      try {
        for await (const frame of super.follow(request, AbortSignal.any([signal, migrated.signal]))) {
          if (frame.type === 'snapshot') cursor = frame.cursor;
          if (frame.type === 'event') cursor = frame.event.seq;
          yield frame;
        }
      } finally { callbacks.delete(notify); if (!callbacks.size) this.linux.followers.delete(id); }
      if (!signal.aborted && migrated.signal.aborted) {
        for await (const frame of this.linux.follow(request, signal)) {
          if (frame.type === 'snapshot') {
            // The client already accepted one opening snapshot. Seeded Linux
            // events preserve its cursor, so continue without a second opening.
            for (const record of frame.records) if (record.event?.seq > cursor) { cursor = record.event.seq; yield { type: 'event', event: record.event }; }
          } else if (frame.type !== 'event' || frame.event.seq > cursor) {
            if (frame.type === 'event') cursor = frame.event.seq;
            yield frame;
          }
        }
      }
    }
  }
  async page(request, signal) {
    const id = request.address.kind === 'session' ? request.address.sessionId : request.address.parentSessionId;
    return await this.linux.route(id) ? this.linux.page(request, signal) : super.page(request, signal);
  }
  async *control(signal) {
    await this.linux.ready.catch(error => {
      if (signal?.aborted) throw error;
      this.linux.refreshError = { message: String(error.message ?? error), time: Date.now() };
    });
    for await (const frame of super.control(signal)) {
      if (frame.type === 'baseline') for (const row of Object.values(this.linux.records)) {
        if (row.summary?.projections && this.ctx.remoteAccess.allows({ kind: 'session', id: row.sessionId })) frame.value.projections[row.sessionId] = row.summary.projections;
      }
      yield frame;
    }
  }
}
