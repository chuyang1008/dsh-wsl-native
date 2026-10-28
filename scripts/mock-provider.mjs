import http from 'node:http';
import { randomUUID } from 'node:crypto';
export async function startMock() {
  const evidence = { requests: 0, toolsAdvertised: [], toolResults: [], cancelled: 0, waiting: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST' || req.headers.authorization !== 'Bearer poc-local-only') { res.writeHead(403); res.end(); return; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4 * 1024 * 1024) { res.writeHead(413); res.end(); return; } }
    let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    evidence.requests++;
    evidence.toolsAdvertised = (body.tools ?? []).map(x => x.function.name);
    const results = (body.messages ?? []).filter(x => x.role === 'tool');
    evidence.toolResults = results.map(x => x.content);
    if (body.messages?.some(x => x.role === 'user' && JSON.stringify(x.content).includes('WSL_POC_WAIT'))) {
      evidence.waiting++;
      const timer = setTimeout(() => { res.writeHead(504); res.end(); }, 30000);
      res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) evidence.cancelled++; });
      return;
    }
    const detachedTool = body.messages?.some(x => x.role === 'user' && JSON.stringify(x.content).includes('WSL_POC_DETACHED_TOOL'));
    const longTool = detachedTool || body.messages?.some(x => x.role === 'user' && JSON.stringify(x.content).includes('WSL_POC_LONG_TOOL'));
    const marker = longTool || body.messages?.some(x => x.role === 'user' && JSON.stringify(x.content).includes('WSL_POC_VERIFY'));
    const call = marker && !results.length && evidence.toolsAdvertised.includes('bash');
    const sleeper = detachedTool ? "setsid sh -c 'trap \"\" TERM; exec sleep 120'" : 'sleep 120';
    const command = longTool ? "set -C; printf '%s\\n' \"$$\" > '.poc-active-tool.pids'; " + sleeper + " & child=$!; printf '%s\\n' \"$child\" >> '.poc-active-tool.pids'; wait \"$child\"" : "set -C; uname -s; printf 'Linux DSH 工具回写成功\\n' > 'WSL原型 回写验证.txt' && cat 'WSL原型 回写验证.txt'";
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function', function: { name: 'bash', arguments: JSON.stringify({ description: longTool ? 'Owned long-running process cleanup test' : 'Verify Linux and Windows file roundtrip', command, timeoutMs: longTool ? 150000 : 10000 }) } }] }
      : { role: 'assistant', content: marker ? 'WSL_POC_COMPLETE\n' + results.map(x => x.content).join('\n') : '这是 WSL 原型的本地模拟模型。发送 WSL_POC_VERIFY 可运行固定的 Linux 和文件回写验证；本模式不提供真实推理。' };
    const id = 'chatcmpl-' + randomUUID();
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const [d, finish_reason] of [[delta, null], [{}, call ? 'tool_calls' : 'stop']]) res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'poc-model', choices: [{ index: 0, delta: d, finish_reason }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } else {
      const message = { ...delta }; if (message.tool_calls) message.tool_calls = message.tool_calls.map(({ index, ...x }) => x);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'poc-model', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, evidence, port: server.address().port };
}
