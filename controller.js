import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { importFiles } from './file-import.js';

const exec = promisify(execFile);
const scripts = fileURLToPath(new URL('./scripts/', import.meta.url));
export function validateOptions(input = {}) {
  const distro = validateDistro(input.distro);
  const workspace = input.workspace;
  const mode = input.mode ?? 'mock';
  if (typeof workspace !== 'string' || !/^[A-Za-z]:[\\/]/.test(workspace) || /[\x00-\x1f]/.test(workspace)) throw new Error('工作区必须是 Windows 绝对路径');
  if (!['mock', 'host'].includes(mode)) throw new Error('未知模型模式');
  if (mode === 'host' && (!input.selection || !['provider', 'model'].every(key => typeof input.selection[key] === 'string' && input.selection[key].length > 0 && input.selection[key].length <= 512 && !/[\x00-\x1f]/.test(input.selection[key])))) throw new Error('请选择 Windows Host 的可用模型');
  return { distro, workspace, mode, ...(mode === 'host' ? { selection: { provider: input.selection.provider, model: input.selection.model } } : {}) };
}
export function validateDistro(distro = 'Ubuntu') {
  if (typeof distro !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(distro) || /^docker-desktop/i.test(distro)) throw new Error('请选择普通 WSL 开发发行版');
  return distro;
}
export class WslController {
  #child; #pending; #url; #logs = []; #state = 'stopped'; #options; #epoch = 0;
  #broker; #hostModel; #calls = new Map();
  constructor({ broker } = {}) { this.#broker = broker; }
  snapshot() { return { state: this.#state, ...this.#options, logs: [...this.#logs], mode: this.#options?.mode ?? 'mock', version: '0.0.5' }; }
  async import(input = {}) {
    const epoch = this.#epoch;
    const assertCurrent = () => { if (this.#state !== 'running' || epoch !== this.#epoch) throw new Error('WSL 环境已改变，请重新导入'); };
    assertCurrent();
    if (input.workspace !== this.#options.workspace || input.backendPid !== this.#options.backendPid) throw new Error('工作区已改变，请刷新面板后重新选择文件');
    return importFiles(this.#options.workspace, this.#options.linuxWorkspace, input.files, assertCurrent);
  }
  async maintenance(input = {}) {
    if (this.#child || this.#pending) throw new Error('请先停止当前环境');
    const distro = validateDistro(input.distro);
    if (!['status', 'recover'].includes(input.action)) throw new Error('未知维护操作');
    const { stdout: script } = await exec('wsl.exe', ['-d', distro, '--exec', 'wslpath', '-a', '-u', scripts + 'run-linux.sh'], { windowsHide: true, timeout: 15000 });
    try {
      const { stdout } = await exec('wsl.exe', ['-d', distro, '--exec', 'bash', '--noprofile', '--norc', script.trim(), '--' + input.action], { windowsHide: true, timeout: 20000 });
      return JSON.parse(stdout.trim());
    } catch (error) {
      if (error.code === 73) throw new Error('另一个后端仍持有运行锁；请在所属窗口停止它。');
      throw new Error('WSL 维护未完成：' + (error.stderr ? error.stderr.replace(/\0/g, '').slice(-600) : '请检查运行时是否已准备完成'));
    }
  }
  async #send(frame) {
    if (!this.#child || this.#child.stdin.destroyed || this.#child.stdin.writableEnded) throw new Error('模型桥已关闭');
    const encoded = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error('模型桥消息超出大小限制');
    await new Promise((resolve, reject) => this.#child.stdin.write(encoded, error => error ? reject(error) : resolve()));
  }
  async #receive(frame) {
    if (typeof frame.id !== 'string' || !/^[a-f0-9-]{36}$/.test(frame.id)) return;
    if (frame.type === 'llm-cancel') { this.#calls.get(frame.id)?.abort(); return; }
    if (frame.type !== 'llm-request') return;
    if (this.#calls.has(frame.id)) return;
    if (!this.#broker || !this.#hostModel || this.#calls.size >= 4) { await this.#send({ type: 'llm-error', id: frame.id }); return; }
    const abort = new AbortController(); this.#calls.set(frame.id, abort);
    const timer = setTimeout(() => abort.abort(), 180000);
    try {
      for await (const chunk of this.#broker.stream(this.#hostModel, frame.request, abort.signal)) await this.#send({ type: 'llm-chunk', id: frame.id, chunk });
      await this.#send({ type: 'llm-end', id: frame.id });
    } catch { await this.#send({ type: 'llm-error', id: frame.id }).catch(() => {}); }
    finally { clearTimeout(timer); this.#calls.delete(frame.id); }
  }
  #log(value) { this.#logs.push(value.replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]').slice(-1500)); this.#logs = this.#logs.slice(-25); }
  async distros() {
    const { stdout } = await exec('wsl.exe', ['--list', '--quiet'], { encoding: 'buffer', windowsHide: true, timeout: 15000 });
    return stdout.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map(x => x.trim()).filter(x => x && !/^docker-desktop/i.test(x));
  }
  start(input) {
    if (this.#pending) return this.#pending;
    if (this.#child) return Promise.reject(new Error('请先停止当前环境，再切换工作区'));
    const options = validateOptions(input);
    this.#options = options; this.#url = undefined; this.#logs = []; this.#state = 'starting';
    this.#pending = this.#start(options, ++this.#epoch).finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
  async #start({ distro, workspace, mode, selection }, epoch) {
    try {
      this.#hostModel = mode === 'host' ? await this.#broker?.prepare(selection) : undefined;
      if (mode === 'host' && !this.#hostModel) throw new Error('当前 Host 没有模型转发服务');
      if (!(await this.distros()).includes(distro)) throw new Error('发行版不存在');
      const run = async value => (await exec('wsl.exe', ['-d', distro, '--exec', 'wslpath', '-a', '-u', value], { windowsHide: true, timeout: 15000 })).stdout.trim();
      const linuxScript = await run(scripts + 'run-linux.sh');
      const linuxWorkspace = await run(workspace);
      if (epoch !== this.#epoch) throw new Error('启动已取消');
      const child = spawn('wsl.exe', ['-d', distro, '--exec', 'bash', '--noprofile', '--norc', linuxScript, linuxWorkspace], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8');
      this.#child = child;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('启动超时，请检查状态日志')); void this.stop(); }, 90000);
        let buffer = '';
        const fail = error => { clearTimeout(timer); reject(error); };
        child.stdin.on('error', () => {});
        void this.#send({ type: 'configure', mode, ...(this.#hostModel ? { model: this.#hostModel } : {}) }).catch(fail);
        child.stdout.on('data', chunk => {
          buffer += chunk.toString();
          if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { fail(new Error('WSL 模型消息超出大小限制')); void this.stop(); return; }
          for (;;) {
            const pos = buffer.indexOf('\n'); if (pos < 0) break;
            const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
            if (line.startsWith('DSH_WSL_POC_FRAME ')) {
              try { void this.#receive(JSON.parse(line.slice(18))).catch(() => {}); } catch { fail(new Error('WSL 模型消息格式错误')); void this.stop(); }
            } else if (line.startsWith('DSH_WSL_POC_READY ')) {
              try {
                const ready = JSON.parse(line.slice(18));
                const url = new URL(ready.url);
                if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !url.searchParams.get('token')) throw new Error('后端地址不符合回环认证约束');
                this.#url = url.href;
                this.#options = { ...this.#options, linuxWorkspace, platform: ready.platform, node: ready.node, backendPid: ready.pid };
                // WSL's Windows localhost relay may lag behind the Linux listener.
                void (async () => {
                  for (let attempt = 0; attempt < 60; attempt++) {
                    if (this.#child !== child || this.#state !== 'starting') throw new Error('启动已取消');
                    try {
                      const response = await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
                      await response.body?.cancel();
                      if (response.status === 303 && response.headers.has('set-cookie')) { this.#state = 'running'; clearTimeout(timer); resolve(this.snapshot()); return; }
                    } catch { /* Wait briefly for Windows loopback forwarding. */ }
                    await new Promise(r => setTimeout(r, 250));
                  }
                  throw new Error('Linux 已启动，但 Windows localhost 尚不可达');
                })().catch(error => { fail(error); void this.stop(); });
              } catch (error) { fail(error); void this.stop(); }
            } else this.#log(line);
          }
        });
        child.stderr.on('data', x => this.#log(x.toString(x.includes(0) ? 'utf16le' : 'utf8')));
        child.once('error', error => { this.#child = undefined; this.#state = 'failed'; fail(error); });
        child.once('exit', code => {
          this.#child = undefined; this.#url = undefined; this.#state = code === 0 ? 'stopped' : 'failed';
          for (const call of this.#calls.values()) call.abort(); this.#calls.clear();
          this.#log('WSL runner exited: ' + code); fail(new Error('WSL 后端已退出：' + code));
        });
      });
    } catch (error) { if (!this.#child && epoch === this.#epoch) this.#state = 'failed'; throw error; }
  }
  open() { if (this.#state !== 'running' || !this.#url) throw new Error('环境尚未就绪'); return { url: this.#url }; }
  async stop() {
    this.#epoch++;
    for (const call of this.#calls.values()) call.abort(); this.#calls.clear();
    const child = this.#child;
    this.#url = undefined;
    if (!child) { this.#state = 'stopped'; return this.snapshot(); }
    this.#state = 'stopping';
    // The Linux supervisor owns its DSH child. EOF requests graceful shutdown.
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.#log('停止尚未确认；保留监督进程以便重试'); resolve(); }, 15000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    return this.snapshot();
  }
}
