import test from 'node:test';
import assert from 'node:assert/strict';
import { routeSessionEvents } from '../native-plugin-src/session-events.js';
test('moving a mapped session to Linux cannot mark it removed in the official client', () => {
  const events = [];
  const original = function (...args) { events.push(args); };
  const owner = { emit: original };
  const summary = { sessionId: 'linux', agentAvailable: true, running: true };
  const dispose = routeSessionEvents(owner, { linux: { summary } });
  owner.emit('api-session/removed', 'linux');
  owner.emit('api-session/added', { sessionId: 'linux', agentAvailable: false });
  owner.emit('api-session/removed', 'windows');
  assert.deepEqual(events, [['api-session/added', summary], ['api-session/removed', 'windows']]);
  dispose();
  assert.equal(owner.emit, original);
});
