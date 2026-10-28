# DSH WSL Native

让 Windows DeepSeek Harness 的原生会话在 WSL Linux 后端执行任务。

**当前版本：`0.1.0-alpha.13`，实验版；仅适配 DSH Desktop `0.2.1-rc.3`。** 已验证 Ubuntu WSL2 x64、单项目和文本任务。完整窗口操作、系统重启恢复和沙箱边界仍待验收，建议先在专用测试项目使用。

## 功能

- 在原生新会话菜单选择“WSL 模式”，使用 Linux 工具处理 Windows 本地项目。
- 复用 Windows 已配置的默认模型，凭据由 Windows 模型适配器处理。
- 自动准备私有 Linux 运行时，支持文本流、工具轨迹和取消。
- 保留官方会话服务生命周期，支持已有空白会话迁移。

这是独立实验插件。仅在固定上游版本上适配；不会替换系统 Node。

## 安装前准备

1. 安装 Windows DeepSeek Harness **0.2.1-rc.3**。
2. 确认 `wsl -d Ubuntu -- uname -s` 返回 `Linux`。已验证 Ubuntu WSL2 x64，其他发行版和架构尚未验收。
3. 在 Windows 应用中配置默认模型，并备份现有应用配置。
4. 从本仓库 Releases 下载 `dsh-wsl-native-0.1.0-alpha.13.tgz` 及同名 `.sha256` 文件。

首次运行需要从官方源下载并校验 Node 24.21.0，以及安装固定 DSH 和 pnpm；也可能复用已有的受管理运行时。请保持网络可用，并等待准备完成。

## 安装和使用

在 PowerShell 中计算摘要，与下载的 `.sha256` 内容对照：

```powershell
Get-FileHash .\dsh-wsl-native-0.1.0-alpha.13.tgz -Algorithm SHA256
```

通过应用的本地插件安装入口选择 tgz 并启用，重启应用。若已配置 `dsh` CLI，也可使用：

```powershell
dsh plugin --profile desktop add C:\完整路径\dsh-wsl-native-0.1.0-alpha.13.tgz
```

在原生新会话的模式菜单选择 **WSL 模式**，选择 Windows 本地项目目录并发送文本任务。标准模式仍在 Windows 执行。

插件设置的 `distro` 默认为 `Ubuntu`，`modelMode` 默认为 `host`，使用 Windows 已配置的默认模型。`mock` 为固定响应的离线测试模式，不能用于正常任务。

## 已知限制

- 仅支持一个 WSL 项目及文本输入。
- 不支持原生附件、fork、跨项目并行，以及 WSL 到 Windows 的原位切换。
- 文件、技能、终端等其他依赖 agentId 的接口尚未全部适配。
- 会话列表摘要可能未及时刷新，列表与恢复行为仍需验证。
- alpha.13 尚未完成完整窗口操作验收，也未完成真实 WSL/Windows 重启恢复及完整沙箱审计。
- Linux 工具具有当前 WSL 用户的能力，WSL interop 可启动 Windows 进程。

已有本机记录确认 Linux 工具、Windows/Linux 双向文件访问、真实模型转发、取消和已有空白会话迁移。详情和验收边界见 [首版发布说明](docs/RELEASE-v0.1.0-alpha.13.md)。

## 数据位置和卸载

Linux 私有运行时位于 `~/.local/share/dsh-wsl-native/shared`，profile 位于 `~/.local/share/dsh-wsl-native/profiles/`。Windows 缓存、后端副本及会话映射位于实际 DSH_HOME 下的 `native-wsl` 与 `native-wsl-routes.json`。运行时也可能复用早期原型受管理的 Linux 目录。

升级、停用或卸载前结束 WSL 任务。通过应用插件管理页卸载，或运行：

```powershell
dsh plugin --profile desktop remove dsh-wsl-native
```

卸载恢复内置会话服务，保留缓存、Linux 历史、映射和项目文件。不要直接删除正在使用的运行时或 profile。

## 从源码构建

开发需要带 npm 的 Node.js >=24.9.0：

```powershell
npm test
npm run build:native
```

安装包和摘要输出到 `artifacts/`。发布前可运行 `npm run release:prepare` 生成经过单测及构建验证的独立上传目录。目录结构、历史版本关系与集成验证见 [开发说明](docs/DEVELOPMENT.md)。

## 许可证

[MIT](LICENSE)。本项目未随源码发布上游应用的解包内容，上游应用与依赖遵循各自许可证。
