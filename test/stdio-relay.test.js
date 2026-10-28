import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStdioRelay } from '../scripts/stdio-relay.mjs';

test('Linux loopback relay requires its ephemeral credential and forwards streams', async () => {
  let relay;
  relay = await startStdioRelay(frame => {
    if (frame.type === 'llm-request') {
      setImmediate(() => { relay.receive({ type: 'llm-chunk', id: frame.id, chunk: { type: 'text-delta', index: 0, text: '中文流' } }); relay.receive({ type: 'llm-end', id: frame.id }); });
    }
  });
  try {
    assert.equal((await fetch(relay.url, { method: 'POST', body: '{}' })).status, 403);
    const response = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer ' + relay.token }, body: JSON.stringify({ provider: 'wsl-host', model: 'm', messages: [] }) });
    const rows = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].chunk.text, '中文流'); assert.equal(rows[1].type, 'end');
  } finally { relay.close(); }
});
