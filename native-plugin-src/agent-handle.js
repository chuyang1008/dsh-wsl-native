const raw = value => value?.[Symbol.for('cordis.original')] ?? value;

// Fixed rc.3 compatibility: AgentLoop.prepare registers the exact per-Agent
// disposer as agentLoop.lifecycle(id) on its original owner fiber. Agents which
// predate plugin activation cannot have been observed by our factory wrapper.
export function existingAgentHandle(agent, owners) {
  const matches = new Set();
  const label = `agentLoop.lifecycle(${agent.id})`;
  for (const owner of owners) {
    const effects = raw(owner)?.fiber?._disposables;
    if (!effects?.[Symbol.iterator]) continue;
    for (const effect of effects) if (effect[Symbol.for('cordis.effect')]?.label === label) matches.add(effect);
  }
  if (matches.size !== 1) return undefined;
  const dispose = [...matches][0];
  return { agent: raw(agent), dispose: () => dispose() };
}

export function sameAgent(left, right) { return raw(left) === raw(right); }
export function transitionHandle(agent, captured, owners) {
  return captured && sameAgent(captured.agent, agent) ? captured : existingAgentHandle(agent, owners);
}
