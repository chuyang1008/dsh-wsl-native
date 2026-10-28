// Extract only installed vendor code and package metadata, never user profiles.
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const archive = join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/app.asar');
const target = join(root, 'scratch/native-api-audit');
const packages = ['dsh-client-ui-session', 'dsh-client-ui-slots', 'dsh-client-ui-renderer', 'dsh-client-ui-chat', 'dsh-client-ui-workspace', 'dsh-cordis-client-runner', 'dsh-client-hmr', 'dsh-agent-preset', 'dsh-agent-preset-registry', 'dsh-client-ui-agent-preset', 'dsh-agent', 'dsh-agent-loop', 'dsh-api-session-controller', 'dsh-api-gateway', 'dsh-client-connection', 'dsh-session', 'dsh-workspace', 'dsh-session-persistence'];
const fd = fs.openSync(archive, 'r');
const report = { archive, files: [] };
try {
  const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
  const headerSize = prefix.readUInt32LE(12);
  if (headerSize > 64 * 1024 * 1024) throw new Error('Unexpected ASAR header size');
  const dataOffset = 8 + prefix.readUInt32LE(4);
  const buffer = Buffer.alloc(headerSize); fs.readSync(fd, buffer, 0, buffer.length, 16);
  const header = JSON.parse(buffer.toString('utf8'));
  for (const name of packages) {
    for (const file of ['package.json', 'README.md', 'lib/index.js', 'lib/typert.host.js', 'lib/client.js']) {
      const source = `dsh/node_modules/@deepseek-ai/${name}/${file}`;
      let entry = header;
      for (const part of source.split('/')) entry = entry?.files?.[part];
      if (!entry) continue;
      if (entry.unpacked || entry.link) throw new Error('Unexpected external ASAR entry: ' + source);
      const bytes = Buffer.alloc(entry.size);
      assertRead(fs.readSync(fd, bytes, 0, bytes.length, dataOffset + Number(entry.offset)), bytes.length);
      const output = join(target, name, file);
      fs.mkdirSync(join(output, '..'), { recursive: true }); fs.writeFileSync(output, bytes);
      report.files.push({ source, output, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
  }
  fs.writeFileSync(join(root, 'artifacts/native-api-source-manifest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ extractedFiles: report.files.length, target }));
} finally { fs.closeSync(fd); }
function assertRead(actual, expected) { if (actual !== expected) throw new Error('Truncated ASAR entry'); }
