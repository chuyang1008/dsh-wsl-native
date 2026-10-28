import { randomUUID } from 'node:crypto';
import { WebSocket } from './vendor.js';
export class RemoteClient {
  constructor(base, cookie) { this.base = base; this.cookie = cookie; this.sockets = new Set(); }
  async rpc(endpoint, args, signal) {
    const response = await fetch(this.base + '/api/' + endpoint, {
      method: 'POST', headers: { cookie: this.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(95000)]) : AbortSignal.timeout(95000),
    });
    const body = await response.json();
    if (!response.ok || !body.result?.ok) {
      const error = new Error(body.result?.error?.message ?? 'Remote Host request failed');
      Object.assign(error, body.result?.error, { isDSHRemoteError: true }); throw error;
    }
    return body.result.value;
  }
  async *stream(endpoint, args, signal) {
    signal?.throwIfAborted();
    const socket = new WebSocket(this.base.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { cookie: this.cookie } });
    this.sockets.add(socket);
    const id = randomUUID(), queue = [];
    let wake, ended = false, failure, bytes = 0;
    const notify = () => { wake?.(); wake = undefined; };
    const abort = () => { ended = true; socket.terminate(); notify(); };
    const fail = error => { if (!ended) failure = error; ended = true; notify(); };
    socket.on('error', () => fail(new Error('Remote stream connection failed')));
    socket.on('close', () => { if (!ended) fail(new Error('Remote stream closed before completion')); });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId: id, endpoint, payload: { args } })));
    socket.on('message', raw => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.streamId !== id) return;
        if (frame.type === 'item') {
          const size = Buffer.byteLength(raw);
          bytes += size;
          if (bytes > 8 * 1024 * 1024) { fail(new Error('Remote stream consumer exceeded buffer limit')); socket.terminate(); return; }
          queue.push({ value: frame.value, size }); notify();
        } else if (frame.type === 'end') { ended = true; notify(); }
        else if (frame.type === 'error') fail(Object.assign(new Error(frame.error?.message ?? 'Remote stream failed'), frame.error, { isDSHRemoteError: true }));
      } catch (error) { fail(error); socket.terminate(); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      while (!ended || queue.length) {
        if (signal?.aborted) return;
        const item = queue.shift();
        if (item) { bytes -= item.size; yield item.value; }
        else await new Promise(resolve => { wake = resolve; });
      }
      if (failure) throw failure;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.sockets.delete(socket); socket.terminate();
    }
  }
  close() { for (const socket of this.sockets) socket.terminate(); }
}
