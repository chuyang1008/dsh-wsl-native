import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
const MAX_BYTES = 8 * 1024 * 1024;
// Linux listens only on its own loopback; all reverse traffic uses the owned WSL stdio pipe.
export async function startStdioRelay(send) {
  const token = randomBytes(32).toString('base64url'); const active = new Map();
  const server = http.createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from('Bearer ' + token);
    if (req.method !== 'POST' || req.url !== '/stream' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(403); res.end(); return; }
    if (active.size >= 4) { res.writeHead(429); res.end(); return; }
    let length = 0; const buffers = [];
    for await (const bytes of req) { length += bytes.length; if (length > MAX_BYTES) { res.writeHead(413); res.end(); return; } buffers.push(bytes); }
    let request; try { request = JSON.parse(Buffer.concat(buffers)); } catch { res.writeHead(400); res.end(); return; }
    const id = randomUUID(); let finished = false;
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const timer = setTimeout(() => { send({ type: 'llm-cancel', id }); res.end(JSON.stringify({ type: 'error' }) + '\n'); active.delete(id); }, 180000);
    active.set(id, { res, timer, bytes: 0, finish() { finished = true; } });
    res.on('close', () => { clearTimeout(timer); active.delete(id); if (!finished) send({ type: 'llm-cancel', id }); });
    send({ type: 'llm-request', id, request });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port + '/stream', token,
    receive(frame) {
      const entry = active.get(frame.id); if (!entry) return;
      const payload = frame.type === 'llm-chunk' ? { type: 'chunk', chunk: frame.chunk } : frame.type === 'llm-end' ? { type: 'end' } : { type: 'error' };
      const encoded = JSON.stringify(payload) + '\n'; entry.bytes += Buffer.byteLength(encoded);
      if (entry.bytes > 32 * MAX_BYTES || entry.res.writableLength > MAX_BYTES) { send({ type: 'llm-cancel', id: frame.id }); entry.res.destroy(); return; }
      entry.res.write(encoded);
      if (frame.type !== 'llm-chunk') { entry.finish(); clearTimeout(entry.timer); active.delete(frame.id); entry.res.end(); }
    },
    close() { for (const id of active.keys()) send({ type: 'llm-cancel', id }); server.closeAllConnections(); server.close(); for (const entry of active.values()) clearTimeout(entry.timer); active.clear(); },
  };
}
