import { mkdtemp, realpath, stat, writeFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export function decodeFiles(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10) throw new Error('每批请选择 1–10 个文件');
  let total = 0;
  const names = new Set();
  return input.map(file => {
    const name = file?.name;
    if (typeof name !== 'string' || !name || name.length > 120 || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new Error('文件名不受支持');
    const key = name.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error('同一批次包含重名文件，请分批导入');
    names.add(key);
    if (typeof file.base64 !== 'string' || file.base64.length > Math.ceil(MAX_IMPORT_BYTES / 3) * 4 || file.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new Error('文件编码或大小不受支持');
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.toString('base64') !== file.base64) throw new Error('文件编码不规范');
    total += bytes.length;
    if (total > MAX_IMPORT_BYTES) throw new Error('每批文件合计最多 10 MiB');
    return { name, bytes };
  });
}

// Allocate directly below the resolved workspace: no reusable import directory
// that a pre-existing junction/symlink could redirect, and no overwrites.
export async function importFiles(workspace, linuxWorkspace, input, assertCurrent = () => {}) {
  const files = decodeFiles(input);
  const root = await realpath(workspace);
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(root) !== normalize(workspace)) throw new Error('文件导入暂不支持经过符号链接或 Junction 的工作区，请选择实际目录');
  if (!(await stat(root)).isDirectory()) throw new Error('工作区不是目录');
  assertCurrent();
  const directory = await mkdtemp(path.join(root, '.dsh-import-'));
  const written = [];
  try {
    for (const file of files) {
      assertCurrent();
      const destination = path.join(directory, file.name);
      await writeFile(destination, file.bytes, { flag: 'wx' });
      written.push(destination);
    }
    assertCurrent();
    const folder = path.basename(directory);
    return { files: files.map(file => ({ name: file.name, bytes: file.bytes.length, windowsPath: path.join(directory, file.name), linuxPath: linuxWorkspace.replace(/\/$/, '') + '/' + folder + '/' + file.name })) };
  } catch (error) {
    // Only unlink files this operation created; never recursively remove a path.
    for (const destination of written) await unlink(destination).catch(() => {});
    await rmdir(directory).catch(() => {});
    throw error;
  }
}
