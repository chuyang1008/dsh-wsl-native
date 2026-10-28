import fs from 'node:fs';
const archive = (process.env.LOCALAPPDATA + '/Programs/DeepSeek Harness/resources/app.asar');
const fd = fs.openSync(archive, 'r');
const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
const dataOffset = 8 + prefix.readUInt32LE(4); const buffer = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, buffer, 0, buffer.length, 16);
const header = JSON.parse(buffer.toString());
function read(path) { let entry = header; for (const part of path.split('/')) entry = entry.files[part]; const b = Buffer.alloc(entry.size); fs.readSync(fd, b, 0, b.length, dataOffset + Number(entry.offset)); return b.toString(); }
const main = read('lib/main.js');
for (const term of ['function needsWelcome', 'readWelcomeState =', 'function readWelcomeState', 'saveApiKey:']) {
  const i = main.indexOf(term); console.log(JSON.stringify({ term, offset: i, context: i >= 0 ? main.slice(Math.max(0, i-400), i+500) : '' }));
}
fs.closeSync(fd);
