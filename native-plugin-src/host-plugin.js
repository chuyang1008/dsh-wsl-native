import NativeRuntimeController from './runtime-controller.js';
import NativeAwareLoop from './loop.js';
import { runtimeState } from './state.js';
import { routeSessionEvents } from './session-events.js';

// Preserve the official Host entry, its Remote metadata and its client lifetime.
// Only execution dispatch changes. Removing this plugin restores exact methods.
export const Config = NativeRuntimeController.Config;
export const inject = [...new Set([...NativeRuntimeController.inject, 'sessionController', 'agentLoop'])];
export function apply(ctx, config) {
  if (!['host', 'mock'].includes(config.modelMode)) throw new Error('modelMode must be host or mock');
  // Cordis getters return consumer-context proxies. Patching/binding one would
  // capture this plugin's context, which becomes inactive on the next toggle.
  const original = Symbol.for('cordis.original');
  const controller = ctx.sessionController[original] ?? ctx.sessionController;
  const loop = ctx.agentLoop[original] ?? ctx.agentLoop;
  const restores = [];
  function replaceMethods(target, prototype, names) {
    for (const name of names) {
      const before = Object.getOwnPropertyDescriptor(target, name);
      const replacement = prototype[name].bind(target);
      Object.defineProperty(target, name, { value: replacement, configurable: true, writable: true });
      restores.push(() => {
        if (target[name] !== replacement) return;
        if (before) Object.defineProperty(target, name, before);
        else delete target[name];
      });
    }
  }
  ctx.effect(() => () => { for (const restore of restores.reverse()) restore(); }, 'native-wsl: restore official dispatch');
  replaceMethods(loop, NativeAwareLoop.prototype, ['createAgent', 'resume']);
  replaceMethods(controller, NativeRuntimeController.prototype, ['create', 'list', 'prompt', 'cancel', 'updateQueue', 'modelCatalog', 'selectModel', 'rename', 'fork', 'attachment', 'projections', 'follow', 'page', 'control']);
  NativeRuntimeController.prototype.installNativeRuntime.call(controller, ctx, config);
  const provider = controller.linux;
  ctx.effect(() => routeSessionEvents(controller.listState.ctx, provider.records), 'native-wsl: route official session notifications');
  ctx.effect(() => () => {
    if (runtimeState.provider === provider) runtimeState.provider = undefined;
  }, 'native-wsl: release runtime provider');
}
