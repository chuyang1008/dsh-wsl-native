import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBroker } from '../model-broker.js';

function service() {
  return { listProviders: () => [{ id: 'test', name: 'Test', privateField: 'hidden' }],
    listModels: async () => [{ provider: 'test', id: 'm', name: 'Model', secret: 'hidden' }],
    resolveModelInfo: async () => ({ provider: 'test', id: 'm', name: 'Model', inputModalities: ['text', 'image'] }),
    async *stream() { yield { type: 'text-delta', index: 0, text: '中文' }; } };
}
test('catalog exposes only model metadata and rejects unadvertised model selection', async () => {
  const broker = new ModelBroker(service());
  assert.deepEqual(await broker.catalog(), { groups: [{ provider: 'test', name: 'Test', models: [{ id: 'm', name: 'Model' }] }] });
  await assert.rejects(broker.prepare({ provider: 'test', model: 'unknown' }));
  assert.deepEqual((await broker.prepare({ provider: 'test', model: 'm' })).inputModalities, ['text']);
});
test('dispatch pins the selected Windows route, preserves replay state and honors cancellation', async () => {
  const llm = service(); let observed;
  llm.stream = async function* (options) { observed = options; yield { type: 'text-delta', index: 0, text: '中文' }; };
  const broker = new ModelBroker(llm); const selection = await broker.prepare({ provider: 'test', model: 'm' });
  const signal = new AbortController();
  const request = { provider: 'wsl-host', model: 'm', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'previous' }], source: { kind: 'model', provider: 'wsl-host', model: 'm', replayState: { response: { id: 'opaque' } } } }], headers: { authorization: 'should-not-forward' } };
  assert.equal((await Array.fromAsync(broker.stream(selection, request, signal.signal)))[0].text, '中文');
  assert.equal(observed.provider, 'test'); assert.equal(observed.signal, signal.signal); assert.equal(observed.headers, undefined);
  assert.equal(observed.messages[0].source.provider, 'test'); assert.equal(observed.messages[0].source.replayState.response.id, 'opaque');
  signal.abort(); await assert.rejects(Array.fromAsync(broker.stream(selection, request, signal.signal)));
  await assert.rejects(Array.fromAsync(broker.stream(selection, { ...request, model: 'other' }, new AbortController().signal)));
  await assert.rejects(Array.fromAsync(broker.stream(selection, { ...request, messages: [{ content: [{ type: 'image', attachment: { path: 'foreign' } }] }] }, new AbortController().signal)));
});
test('provider diagnostics cannot carry secret strings back to Linux', async () => {
  const llm = service();
  llm.stream = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'secret-canary', rawHeaders: 'secret-canary' } } }; };
  const output = await Array.fromAsync(new ModelBroker(llm).stream({ provider: 'test', id: 'm' }, { provider: 'wsl-host', model: 'm', messages: [] }, new AbortController().signal));
  assert.ok(!JSON.stringify(output).includes('secret-canary')); assert.equal(output[0].reason.failure.code, 'INVALID_CREDENTIAL');
});
