import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.state', 'release-upload-' + Date.now());
const source = join(output, 'source');
const validation = join(output, 'validation-work');
const assets = join(output, 'assets');
const hash = data => createHash('sha256').update(data).digest('hex');
const forbidden = /(^|\/)(?:\.git|\.state|scratch|artifacts|asar|node_modules)(\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|tgz|zip|lnk|log)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /[?&]token=[A-Za-z0-9_-]{24,}/,
];
const result = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
const files = [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
assert.ok(files.length > 0, 'No upload files found');
for (const required of ['README.md', 'LICENSE', '.gitignore', '.gitattributes', 'package.json']) assert.ok(files.includes(required), 'Missing ' + required);
await mkdir(assets, { recursive: true });
const manifest = [];
for (const file of files) {
  assert.ok(!forbidden.test(file) && !['asar.mjs', 'asar-probe.mjs', 'controller-index.js', 'controller-client.js', 'desktop-runtime.json'].includes(file), 'Forbidden upload path: ' + file);
  const stat = await lstat(join(root, file));
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Not a regular file: ' + file);
  assert.ok(stat.size < 10 * 1024 * 1024, 'Review large file: ' + file);
  const data = await readFile(join(root, file));
  assert.ok(!data.includes(0), 'Review binary file: ' + file);
  assert.ok(!secretPatterns.some(pattern => pattern.test(data.toString('utf8'))), 'Possible secret in ' + file + ' (value withheld)');
  await mkdir(dirname(join(source, file)), { recursive: true });
  await copyFile(join(root, file), join(source, file));
  await mkdir(dirname(join(validation, file)), { recursive: true });
  await copyFile(join(root, file), join(validation, file));
  manifest.push({ path: file, bytes: data.length, sha256: hash(data) });
}
console.log('Source snapshot: ' + files.length + ' files; running unit tests and native build.');
const tests = files.filter(file => /^test\/.*\.test\.js$/.test(file));
const tested = await exec(process.execPath, ['--test', ...tests], { cwd: validation, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
await writeFile(join(output, 'unit-tests.txt'), tested.stdout + tested.stderr);
console.log(tested.stdout);
const built = await exec(process.execPath, ['scripts/build-native-plugin.mjs'], { cwd: validation, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
await writeFile(join(output, 'build.txt'), built.stdout + built.stderr);
const info = JSON.parse(await readFile(join(validation, 'artifacts/native-plugin-package.json'), 'utf8'));
const filename = 'dsh-wsl-native-' + info.version + '.tgz';
const archive = await readFile(join(validation, 'artifacts', filename));
assert.equal(hash(archive), info.sha256);
const checksum = await readFile(join(validation, 'artifacts', filename + '.sha256'), 'utf8');
assert.equal(checksum.trim(), info.sha256 + '  ' + filename);
for (const file of info.files) assert.ok(!forbidden.test(file.replace(/^backend\//, '')) || file === 'LICENSE', 'Unexpected package path: ' + file);
for (const file of info.files.filter(file => /\.(?:js|mjs|json|md|sh|yml)$/.test(file))) {
  const text = await readFile(join(validation, '.state/native-plugin-package', file), 'utf8');
  assert.ok(!secretPatterns.some(pattern => pattern.test(text)), 'Possible secret in built package: ' + file);
}
await writeFile(join(assets, filename), archive);
await writeFile(join(assets, filename + '.sha256'), checksum);
await writeFile(join(output, 'source-files.json'), JSON.stringify(manifest, null, 2) + '\n');
const audit = { version: info.version, preparedAt: new Date().toISOString(), node: process.version, sourceFiles: files.length, sourceBytes: manifest.reduce((n, file) => n + file.bytes, 0), unitTests: 'passed; see unit-tests.txt', build: 'passed in source snapshot', secretScan: 'heuristic patterns passed; manual review still required', asset: filename, sha256: info.sha256, packageFiles: info.files, integrationTests: 'not rerun during release preparation', desktopUI: 'not rerun during release preparation' };
await writeFile(join(output, 'release-audit.json'), JSON.stringify(audit, null, 2) + '\n');
await writeFile(join(output, 'UPLOAD.txt'), 'Repository content: source/ only (include .gitignore and .gitattributes).\nGitHub Release attachments: assets/*.tgz and assets/*.sha256.\nTag: v' + info.version + '\nMark as pre-release. Release notes: source/docs/RELEASE-v' + info.version + '.md\nDo not upload validation-work/, audit files or test logs.\n');
console.log(JSON.stringify({ output, ...audit }, null, 2));
