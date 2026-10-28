import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const text = await readFile(new URL('../native-plugin-src/host-plugin.js', import.meta.url), 'utf8');
function fixture() {
  const original = () => 'original';
  class Controller {
    static inject = [];
    installNativeRuntime(ctx) { this.linux = {}; ctx.state.provider = this.linux; }
  }
  for (const name of ['create', 'list', 'prompt', 'cancel', 'updateQueue', 'modelCatalog', 'selectModel', 'rename', 'fork', 'attachment', 'projections', 'follow', 'page', 'control']) Controller.prototype[name] = function () { return this.marker; };
  class Loop { createAgent() { return this.marker; } resume() { return this.marker; } }
  const cleanups = [];
  const state = {};
  const controller = Object.create({ prompt: original });
  controller.marker = 'routed'; controller.listState = { ctx: {} };
  const loop = { marker: 'guarded', createAgent: original, resume: original };
  const ctx = { sessionController: controller, agentLoop: loop, state, effect(fn) { cleanups.push(fn()); } };
  const apply = vm.runInNewContext(text.replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '') + '\napply', { NativeRuntimeController: Controller, NativeAwareLoop: Loop, runtimeState: state, routeSessionEvents: () => () => {} });
  return { apply, ctx, cleanups, original, controller, loop, state };
}
test('native routing preserves core service identity and restores inherited and own methods', () => {
  const f = fixture();
  f.apply(f.ctx, { modelMode: 'host' });
  assert.equal(f.ctx.sessionController, f.controller);
  assert.equal(f.ctx.agentLoop, f.loop);
  assert.equal(f.controller.prompt(), 'routed');
  assert.equal(f.loop.createAgent(), 'guarded');
  for (const cleanup of f.cleanups.reverse()) cleanup();
  assert.equal(f.controller.prompt, f.original);
  assert.equal(Object.hasOwn(f.controller, 'prompt'), false);
  assert.equal(f.loop.createAgent, f.original);
  assert.equal(f.state.provider, undefined);
});
test('invalid configuration cannot mutate core services', () => {
  const f = fixture();
  assert.throws(() => f.apply(f.ctx, { modelMode: 'invalid' }), /modelMode/);
  assert.equal(f.controller.prompt, f.original);
  assert.equal(f.loop.resume, f.original);
});
test('dispatch binds the original Cordis service rather than its consumer context proxy', () => {
  const f = fixture();
  f.ctx.sessionController = new Proxy(f.controller, {
    get(target, key) {
      if (key === Symbol.for('cordis.original')) return target;
      if (key === 'marker') return 'inactive-consumer';
      return Reflect.get(target, key);
    },
  });
  f.apply(f.ctx, { modelMode: 'host' });
  assert.equal(f.controller.prompt(), 'routed');
  for (const cleanup of f.cleanups.reverse()) cleanup();
  assert.equal(f.controller.prompt, f.original);
});
