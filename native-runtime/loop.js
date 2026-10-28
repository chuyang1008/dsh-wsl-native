import { vendor } from './vendor.js';
import { runtimeState } from './state.js';
const { AgentLoop } = await vendor('@deepseek-ai/dsh-agent-loop');
export default class NativeAwareLoop extends AgentLoop {
  async createAgent(ownerCtx, options) {
    if (await runtimeState.provider?.route(options.sessionId)) throw new Error('A WSL session cannot create a Windows Agent');
    const handle = await super.createAgent(ownerCtx, options);
    runtimeState.handles.set(handle.agent.id, handle);
    return handle;
  }
  async resume(ownerCtx, options) {
    if (await runtimeState.provider?.route(options.sessionId)) throw new Error('WSL Agent lookup must use the Linux runtime provider');
    const handle = await super.resume(ownerCtx, options);
    runtimeState.handles.set(handle.agent.id, handle);
    return handle;
  }
}
