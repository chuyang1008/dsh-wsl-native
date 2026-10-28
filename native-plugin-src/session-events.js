// The official controller closes a local Agent during WSL promotion. That is
// not deletion of the durable Linux Session; do not relay a removal to the UI.
export function routeSessionEvents(owner, records) {
  const before = Object.getOwnPropertyDescriptor(owner, 'emit');
  const emit = owner.emit;
  const replacement = function (name, ...args) {
    if (name === 'api-session/removed' && records[args[0]]) return;
    if (name === 'api-session/added') {
      const row = records[args[0]?.sessionId];
      if (row) args[0] = row.summary ?? { ...args[0], agentAvailable: true, running: false };
    }
    return emit.call(this, name, ...args);
  };
  Object.defineProperty(owner, 'emit', { value: replacement, configurable: true, writable: true });
  return () => {
    if (owner.emit !== replacement) return;
    if (before) Object.defineProperty(owner, 'emit', before);
    else delete owner.emit;
  };
}
