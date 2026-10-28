import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RemoteClient } from './remote-client.js';
import { runtimeState } from './state.js';
export class LinuxRuntime {
  constructor(ctx) {
    this.ctx = ctx; this.records = {}; this.client = undefined; this.pending = undefined; this.writes = Promise.resolve(); this.closed = false;
    this.promotions = new Map(); this.followers = new Map();
    this.store = join(process.env.DSH_HOME, 'native-wsl-routes.json');
    this.ready = readFile(this.store, 'utf8').then(text => {
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.routes)) throw new Error('Invalid native WSL mapping store');
      for (const row of data.routes) {
        if (row.runtime !== 'wsl' || row.distro !== 'Ubuntu' || typeof row.sessionId !== 'string' || row.sessionId !== row.linuxSessionId || typeof row.windowsWorkspace !== 'string') throw new Error('Invalid native WSL route');
        this.records[row.sessionId] = row;
      }
    }).catch(error => { if (error.code !== 'ENOENT') throw error; }).then(() => {
      for (const row of Object.values(this.records)) this.reference(row);
    });
  }
  reference(row) {
    // Workspace membership requires a local Session header. This is an inert
    // identity reference, never a Windows Agent or a duplicate execution log.
    if (!this.ctx.sessions.get(row.sessionId)) this.ctx.sessions.create(row.sessionId, { meta: { cwd: row.windowsWorkspace, agentPreset: 'wsl' } });
  }
  async ensure(windowsWorkspace) {
    if (this.closed) throw new Error('Runtime provider is closing');
    if (this.client) {
      if (resolve(this.windowsWorkspace).toLowerCase() !== resolve(windowsWorkspace).toLowerCase()) throw new Error('This feasibility probe supports one WSL project per Host');
      return this.client;
    }
    if (this.pending) { await this.pending; return this.ensure(windowsWorkspace); }
    this.pending = (async () => {
      const { WslController } = await import(pathToFileURL(process.env.DSH_WSL_NATIVE_BACKEND_MODULE).href);
      this.backend = new WslController(); this.windowsWorkspace = windowsWorkspace;
      const state = await this.backend.start({ distro: 'Ubuntu', workspace: windowsWorkspace, mode: 'mock' });
      if (this.closed) { await this.backend.stop(); throw new Error('Runtime provider closed during startup'); }
      const { url } = this.backend.open();
      const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (auth.status !== 303) throw new Error('Linux Host authentication failed');
      this.client = new RemoteClient(new URL(url).origin, auth.headers.get('set-cookie').split(';')[0]);
      this.linuxWorkspace = state.linuxWorkspace;
      return this.client;
    })();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  async save() {
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = this.store + '.' + randomUUID() + '.tmp';
      await mkdir(join(this.store, '..'), { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, routes: Object.values(this.records) }, null, 2));
      // Windows scanners/watchers can briefly hold the destination open.
      // Preserve atomic replacement; never delete the committed mapping first.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, this.store); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 200)));
        }
      }
    });
    return this.writes;
  }
  async create(request) {
    await this.ready;
    if (request.cwd !== undefined && request.workspaceId !== undefined) throw new Error('Specify cwd or workspaceId');
    const workspace = request.workspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(request.workspaceId);
    if (request.workspaceId !== undefined && !workspace) throw new Error('Workspace not found');
    const cwd = workspace?.path ?? request.cwd;
    if (!cwd) throw new Error('An explicit Windows project is required for the WSL probe');
    const client = await this.ensure(cwd);
    const created = await client.rpc('session/create', { request: { cwd: this.linuxWorkspace, agentPreset: 'wsl', ...(request.sessionId && this.records[request.sessionId] ? { sessionId: request.sessionId } : {}) } });
    this.records[created.sessionId] = { runtime: 'wsl', distro: 'Ubuntu', sessionId: created.sessionId, linuxSessionId: created.sessionId, windowsWorkspace: cwd, linuxWorkspace: this.linuxWorkspace, ...(workspace ? { workspaceId: workspace.id } : {}) };
    await this.save();
    this.reference(this.records[created.sessionId]);
    if (workspace) await workspace.attachSession(created.sessionId);
    await this.refresh();
    return created;
  }
  async route(sessionId) {
    await this.ready;
    if (this.promotions.has(sessionId)) await this.promotions.get(sessionId);
    return this.records[sessionId];
  }
  async promoteSelected(sessionId) {
    if (await this.route(sessionId)) return;
    const agent = this.ctx.agents.get(sessionId);
    if (!agent || this.ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== 'wsl') return;
    if (this.promotions.has(sessionId)) return this.promotions.get(sessionId);
    const task = (async () => {
      const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
      if (agent.status === 'running' || boundary && (boundary.lastTurn > 0 || boundary.openTurnStartSeq !== null)) throw new Error('Only an unused blank session can change execution hosts');
      const handle = runtimeState.handles.get(sessionId);
      if (!handle || handle.agent !== agent) throw new Error('No owned Agent handle for host transition');
      const cwd = agent.session.header.cwd;
      const client = await this.ensure(cwd);
      // Recheck after startup: a concurrent preset selection must not change
      // the meaning of the transition while the Linux Host was starting.
      if (this.ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== 'wsl') throw new Error('Preset changed while preparing the WSL Host');
      const events = agent.session.snapshotEvents();
      const response = await fetch(client.base + '/api/dsh-wsl-native-runtime/seed', {
        method: 'POST', headers: { cookie: client.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, createdAt: agent.session.header.createdAt, events }), signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Linux blank-session seed failed');
      this.records[sessionId] = { runtime: 'wsl', distro: 'Ubuntu', sessionId, linuxSessionId: sessionId, windowsWorkspace: cwd, linuxWorkspace: this.linuxWorkspace };
      await this.save();
      // Switch an existing native follower before disposing the Windows
      // Session, otherwise its stream can end before learning about migration.
      for (const notify of this.followers.get(sessionId) ?? []) notify();
      await handle.dispose(); runtimeState.handles.delete(sessionId);
      this.reference(this.records[sessionId]);
      await this.refresh();
    })();
    this.promotions.set(sessionId, task);
    try { await task; } finally { this.promotions.delete(sessionId); }
  }
  async call(endpoint, request, signal) {
    const row = await this.route(request.sessionId);
    if (!row) throw new Error('No WSL route for session');
    if (endpoint === 'session/prompt' && request.content.some(part => part.type !== 'text')) throw new Error('Native WSL probe currently accepts text only; attachment routing is not implemented');
    return (await this.ensure(row.windowsWorkspace)).rpc(endpoint, { request }, signal);
  }
  async *follow(request, signal) {
    if (request.address.kind !== 'session') throw new Error('Subagent history routing is not implemented in this probe');
    const row = await this.route(request.address.sessionId);
    if (!row) throw new Error('No WSL route for history');
    yield* (await this.ensure(row.windowsWorkspace)).stream('session/follow', { request }, signal);
  }
  async page(request, signal) {
    const row = await this.route(request.address.sessionId);
    return (await this.ensure(row.windowsWorkspace)).rpc('session/page', { request }, signal);
  }
  cachedSummaries() {
    return Object.values(this.records).flatMap(row => row.summary ? [row.summary] : []);
  }
  async refresh(signal) {
    await this.ready;
    const rows = Object.values(this.records);
    if (!rows.length) return [];
    // Background list/control reads must never provision or restart WSL.
    // Foreground create/prompt/history operations own backend startup.
    if (!this.client) return this.cachedSummaries();
    let list;
    try {
      list = await this.client.rpc('session/list', { _request: {} }, signal);
      this.refreshError = undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.refreshError = { message: String(error.message ?? error), time: Date.now() };
      return this.cachedSummaries();
    }
    const items = list.items.filter(item => this.records[item.sessionId]).map(item => ({ ...item, cwd: this.records[item.sessionId].windowsWorkspace }));
    for (const item of items) {
      const row = this.records[item.sessionId];
      const changed = !row.summary || JSON.stringify(row.summary) !== JSON.stringify(item);
      if (changed) {
        row.summary = item;
        this.ctx.emit('api-session/added', item);
        this.ctx.emit('api-session/status', item.sessionId, item.running);
        if (item.projections) for (const [key, value] of Object.entries(item.projections.values)) this.broadcast?.({ type: 'projection', sessionId: item.sessionId, key, value, seq: item.projections.asOfSeq });
      }
    }
    return items;
  }
  async close() {
    this.closed = true; this.client?.close();
    await this.pending?.catch(() => {});
    await Promise.allSettled(this.promotions.values());
    if (this.backend) {
      const state = await this.backend.stop();
      if (state.state !== 'stopped') throw new Error('Owned Linux Host did not confirm shutdown');
    }
    await this.writes;
  }
}
