import test from 'node:test';
import assert from 'node:assert/strict';
import { existingAgentHandle, sameAgent, transitionHandle } from '../native-plugin-src/agent-handle.js';
test('recover only the exact rc.3 lifecycle capability for an existing blank Agent', async () => {
  const agent = { id: 'old-blank' };
  let disposed = 0;
  const own = Object.assign(() => { disposed++; }, { [Symbol.for('cordis.effect')]: { label: 'agentLoop.lifecycle(old-blank)' } });
  const other = Object.assign(() => { throw Error('unrelated agent'); }, { [Symbol.for('cordis.effect')]: { label: 'agentLoop.lifecycle(other)' } });
  const owner = { fiber: { _disposables: [own, other] } };
  const handle = existingAgentHandle(agent, [owner, owner]);
  assert.equal(handle.agent, agent);
  await handle.dispose();
  assert.equal(disposed, 1);
  assert.equal(existingAgentHandle({ id: 'missing' }, [owner]), undefined);
  const stale = { agent: { id: agent.id }, dispose: () => { throw Error('stale handle'); } };
  assert.equal(transitionHandle(agent, stale, [owner]).agent, agent);
});
test('ambiguous ownership is refused and Cordis proxy identity is normalized', () => {
  const effect = () => Object.assign(() => {}, { [Symbol.for('cordis.effect')]: { label: 'agentLoop.lifecycle(a)' } });
  assert.equal(existingAgentHandle({ id: 'a' }, [{ fiber: { _disposables: [effect(), effect()] } }]), undefined);
  const agent = {};
  assert.equal(sameAgent({ [Symbol.for('cordis.original')]: agent }, agent), true);
  assert.equal(sameAgent({}, agent), false);
});
