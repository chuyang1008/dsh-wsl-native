window.__ModuleLoader__.load({ id: 'dsh-wsl-poc', factory(require) {
  const R = require('react'); const h = R.createElement;
  const panel = 'wsl-poc';
  const button = { padding: '8px 14px', border: '1px solid #8886', borderRadius: 7, background: 'transparent', color: 'inherit', cursor: 'pointer' };
  async function api(path, data) {
    const response = await fetch('/api/dsh-wsl-poc/' + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? response.statusText); return result;
  }
  let guest; const listeners = new Set();
  function change(value) { guest = value; for (const f of listeners) f(value); }
  function Overlay() {
    const [target, setTarget] = R.useState(guest); const mount = R.useRef(); const [error, setError] = R.useState('');
    R.useEffect(() => { listeners.add(setTarget); return () => listeners.delete(setTarget); }, []);
    R.useEffect(() => {
      if (!target) return;
      let disposed = false; let lease; let element;
      setError(''); const bridge = window.dshDesktop?.browser;
      if (!bridge) { setError('当前页面没有 Desktop browser lease 接口'); return; }
      bridge.acquire('dsh-wsl-poc:' + target.workspace).then(result => {
        if (disposed) { void bridge.release(result.lease).catch(() => {}); return; }
        lease = result.lease;
        element = document.createElement('webview');
        element.setAttribute('src', 'about:blank#' + lease); element.setAttribute('partition', result.partition);
        element.style.cssText = 'width:100%;height:100%;border:0;display:flex;';
        element.addEventListener('dom-ready', () => { if (element.dataset.loaded) return; element.dataset.loaded = '1'; element.loadURL(target.url).catch(() => { if (!disposed) setError('WSL 页面加载失败，请返回面板检查后端状态'); }); });
        mount.current?.appendChild(element);
      }).catch(e => { if (!disposed) setError(e.message); });
      return () => { disposed = true; element?.remove(); if (lease) void bridge.release(lease).catch(() => {}); };
    }, [target]);
    if (!target) return null;
    return h('div', { style: { position: 'fixed', inset: '40px 0 0', zIndex: 100000, background: 'var(--background, #202124)', color: 'inherit', display: 'flex', flexDirection: 'column' } },
      h('div', { style: { padding: 8, display: 'flex', gap: 16, alignItems: 'center', background: '#23764c', color: '#fff', WebkitAppRegion: 'no-drag' } },
        h('strong', null, 'WSL · ' + target.distro + ' · ' + (target.mode === 'host' ? 'Windows Host 模型' : '本地模拟模型')), h('span', null, target.workspace),
        h('button', { style: { ...button, marginLeft: 'auto' }, onClick: () => change(null) }, '返回环境面板')),
      error ? h('p', { role: 'alert' }, error) : null,
      h('div', { ref: mount, style: { flex: 1, minHeight: 0 } }));
  }
  function Panel() {
    const [preferences] = R.useState(() => { try { const value = JSON.parse(localStorage.getItem('dsh-wsl-poc.preferences') ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } });
    const [state, setState] = R.useState({ state: 'stopped', logs: [] }); const [distros, setDistros] = R.useState(['Ubuntu']);
    const [distro, setDistro] = R.useState(typeof preferences.distro === 'string' ? preferences.distro : 'Ubuntu'); const [workspace, setWorkspace] = R.useState(typeof preferences.workspace === 'string' ? preferences.workspace : 'D:\\dsh\\wsl-poc\\scratch');
    const [mode, setMode] = R.useState(preferences.mode === 'host' ? 'host' : 'mock'); const [groups, setGroups] = R.useState([]); const [modelKey, setModelKey] = R.useState(typeof preferences.modelKey === 'string' ? preferences.modelKey : '');
    const [busy, setBusy] = R.useState(false); const [error, setError] = R.useState('');
    const [maintenance, setMaintenance] = R.useState('');
    const [imports, setImports] = R.useState(null); const fileInput = R.useRef();
    async function selectFiles(event) {
      const selected = Array.from(event.target.files ?? []); event.target.value = '';
      if (!selected.length) return;
      await action(async () => {
        if (selected.length > 10 || selected.reduce((sum, file) => sum + file.size, 0) > 10 * 1024 * 1024) throw new Error('每批最多 10 个文件，合计 10 MiB');
        const files = [];
        for (const file of selected) {
          const data = new Uint8Array(await file.arrayBuffer()); let binary = '';
          for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768));
          files.push({ name: file.name, base64: btoa(binary) });
        }
        const result = await api('import', { files, workspace: state.workspace, backendPid: state.backendPid }); setImports({ ...result, workspace: state.workspace, backendPid: state.backendPid });
      });
    }
    R.useEffect(() => { try { localStorage.setItem('dsh-wsl-poc.preferences', JSON.stringify({ distro, workspace, mode, modelKey })); } catch { /* Preferences are optional. */ } }, [distro, workspace, mode, modelKey]);
    R.useEffect(() => { if (preferences.mode === 'host') void loadModels().catch(e => setError(e.message)); }, []);
    const refresh = () => api('status').then(setState).catch(e => setError(e.message));
    R.useEffect(() => { void refresh(); void api('distros').then(x => setDistros(x.distros)).catch(e => setError(e.message)); const timer = setInterval(refresh, 2500); return () => clearInterval(timer); }, []);
    async function action(f) { setBusy(true); setError(''); try { await f(); await refresh(); } catch(e) { setError(e.message); } finally { setBusy(false); } }
    const running = state.state === 'running';
    async function loadModels() { const result = await api('models'); setGroups(result.groups); if (!result.groups.some(group => group.models.some(model => JSON.stringify({ provider: group.provider, model: model.id }) === modelKey))) { const group = result.groups.find(x => x.models.length); setModelKey(group ? JSON.stringify({ provider: group.provider, model: group.models[0].id }) : ''); } }
    return h('div', { style: { padding: 28, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 850, width: '100%', overflow: 'auto', boxSizing: 'border-box' } },
      h('h2', null, 'WSL 环境原型'), h('p', null, '智能体与工具在 Linux 运行。可使用本地模拟模型，或转发到当前 Windows Host 已配置的模型；凭据保留在 Windows。'),
      h('label', null, '发行版 ', h('select', { value: distro, disabled: busy || running, onChange: e => setDistro(e.target.value), style: button }, distros.map(x => h('option', { key: x }, x)))),
      h('label', null, 'Windows 工作区 ', h('input', { value: workspace, disabled: busy || running, onChange: e => setWorkspace(e.target.value), style: { ...button, width: '60%' } }),
        h('button', { style: button, disabled: busy || !['stopped', 'failed'].includes(state.state), onClick: () => action(async () => { if (!window.__DSH_DIRECTORY_PICKER__) throw new Error('当前窗口没有原生目录选择接口'); const value = await window.__DSH_DIRECTORY_PICKER__.pick(); if (value) setWorkspace(value); }) }, '选择目录')),
      h('label', null, '模型来源 ', h('select', { value: mode, disabled: busy || running, style: button, onChange: e => { setMode(e.target.value); if (e.target.value === 'host') void action(loadModels); } }, h('option', { value: 'mock' }, '本地模拟（无真实推理）'), h('option', { value: 'host' }, '当前 Windows Host 已配置模型'))),
      mode === 'host' ? h('div', null,
        h('select', { 'aria-label': 'Windows Host 模型', value: modelKey, disabled: busy || running, onChange: e => setModelKey(e.target.value), style: button }, h('option', { value: '' }, '请选择已配置模型'), groups.map(group => h('optgroup', { key: group.provider, label: group.name }, group.models.map(model => h('option', { key: model.id, value: JSON.stringify({ provider: group.provider, model: model.id }) }, model.name))))),
        h('button', { style: { ...button, marginLeft: 8 }, disabled: busy || running, onClick: () => action(loadModels) }, '刷新模型'),
        h('p', null, '使用本窗口所属配置中的模型；隔离测试时，请先在隔离配置中完成模型设置。')) : null,
      h('p', null, '状态：' + state.state + (state.platform ? ' · ' + state.platform + ' · ' + state.node : '') + (state.linuxWorkspace ? '\n' + state.linuxWorkspace : '')),
      h('div', { style: { display: 'flex', gap: 12 } },
        h('button', { style: button, disabled: busy || running || (mode === 'host' && !modelKey), onClick: () => action(() => api('start', { distro, workspace, mode, ...(mode === 'host' ? { selection: JSON.parse(modelKey) } : {}) })) }, busy ? '处理中…' : '启动 WSL 后端'),
        h('button', { style: button, disabled: busy || !running, onClick: () => action(async () => { const { url } = await api('open', {}); change({ url, distro: state.distro, mode: state.mode, workspace: state.linuxWorkspace }); }) }, '打开 WSL 会话'),
        h('button', { style: button, disabled: ['stopped', 'stopping'].includes(state.state), onClick: () => action(async () => { change(null); await api('stop', {}); }) }, '停止后端')),
      h('p', null, '工作区直接映射原文件。原型验证请使用专用 scratch 目录；发送 WSL_POC_VERIFY 将创建“WSL原型 回写验证.txt”。'),
      h('div', null,
        h('input', { ref: fileInput, type: 'file', multiple: true, hidden: true, onChange: selectFiles }),
        h('button', { style: button, disabled: busy || !running, onClick: () => fileInput.current?.click() }, '导入 Windows 文件'),
        h('p', null, '复制到当前工作区的独立目录，每批最多 10 个文件／10 MiB。原文件保留；图片作为工具可读文件导入。'),
        imports ? h('div', null, h('ul', null, imports.files.map(file => h('li', { key: file.linuxPath }, file.name + ' · ' + file.bytes + ' 字节 · ' + file.linuxPath))),
          h('button', { style: button, disabled: busy || !running || imports.workspace !== state.workspace || imports.backendPid !== state.backendPid, onClick: () => action(async () => {
            const { url } = await api('open', {}); const target = new URL(url);
            target.hash = new URLSearchParams({ wslImport: JSON.stringify(imports.files.map(file => file.linuxPath)) }).toString();
            change({ url: target.href, distro: state.distro, mode: state.mode, workspace: state.linuxWorkspace });
          }) }, '在 WSL 中打开文件草稿'), h('p', null, '仅预填路径引用。请补充任务后自行发送。')) : null),
      h('div', { style: { display: 'flex', gap: 12 } },
        h('button', { style: button, disabled: busy || !['stopped', 'failed'].includes(state.state), onClick: () => action(async () => { const result = await api('maintenance', { distro, action: 'status' }); setMaintenance(({ absent: '没有遗留运行锁', active: '后端仍在运行，请在所属窗口停止', stale: '检测到可恢复的陈旧锁', unknown: '锁身份不明，已保留；请人工核查' })[result.state] ?? result.state); }) }, '检查后端'),
        h('button', { style: button, disabled: busy || !['stopped', 'failed'].includes(state.state), onClick: () => action(async () => { const result = await api('maintenance', { distro, action: 'recover' }); setMaintenance(result.state === 'recovered' ? '陈旧锁已恢复，可以重新启动' : '没有遗留运行锁'); }) }, '恢复陈旧锁')),
      h('p', null, maintenance || '异常退出后可检查后端。仅在已记录的进程均已退出时恢复陈旧锁；身份不明时保留现场。'),
      error ? h('p', { role: 'alert', style: { color: '#e67d7d' } }, error) : null,
      h('pre', { style: { fontSize: 12, whiteSpace: 'pre-wrap', opacity: .75 } }, state.logs.join('\n')));
  }
  return { name: 'dsh-wsl-poc', inject: ['slots'], apply(ctx) {
    if (window.__DSH_WSL_BOOT__) {
      const target = window.__DSH_WSL_BOOT__;
      ctx.inject(['workspaces', 'sessions', 'uiWorkspace', 'conversation'], inner => {
        let done = false;
        const reconcile = () => {
          if (done) return;
          const workspaces = inner.workspaces.list.getSnapshot(); const sessions = inner.sessions.list.getSnapshot();
          if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') return;
          const workspace = workspaces.items.find(x => x.workspaceId === target.workspaceId);
          if (!workspace) return;
          done = true;
          const encoded = new URLSearchParams(location.hash.slice(1)).get('wslImport');
          if (encoded) {
            try {
              const files = JSON.parse(encoded);
              const prefix = target.path.replace(/\/$/, '') + '/.dsh-import-';
              if (!Array.isArray(files) || !files.length || files.length > 10 || !files.every(file => typeof file === 'string' && file.length < 4096 && file.startsWith(prefix) && !/[\x00-\x1f]/.test(file) && !file.split('/').includes('..'))) throw new Error('Invalid imported paths');
              inner.uiWorkspace.startSession(workspace.workspaceId, { prompt: '请使用以下已导入的工作区文件：\n' + files.map(file => JSON.stringify(file)).join('\n') + '\n\n我的任务：', whenDraftExists: 'append' });
              history.replaceState(null, '', location.pathname + location.search);
              return;
            } catch { console.error('WSL file draft could not be opened'); }
          }
          const existing = workspace.sessionIds.filter(id => sessions.byId[id] && !workspaces.archivedSessionIds.includes(id)).sort((a,b) => (sessions.byId[b].updatedAt ?? 0) - (sessions.byId[a].updatedAt ?? 0))[0];
          if (existing) inner.uiWorkspace.openSession(existing);
          else void inner.uiWorkspace.openWorkspace(workspace.workspaceId).catch(() => { console.error('WSL workspace could not be opened'); });
        };
        inner.effect(() => { const a = inner.workspaces.list.subscribe(reconcile); const b = inner.sessions.list.subscribe(reconcile); reconcile(); return () => { done = true; a(); b(); }; }, 'wsl-poc: select mapped workspace');
      });
      return;
    }
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel }, Panel));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 30, label: () => 'WSL 环境原型' }, ({ size = 20 }) => h('span', { style: { fontSize: size * .65, fontWeight: 700 } }, 'WSL')));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'wsl-poc-guest' }, Overlay));
    ctx.effect(() => () => change(null), 'wsl-poc: close guest');
  } };
} });
