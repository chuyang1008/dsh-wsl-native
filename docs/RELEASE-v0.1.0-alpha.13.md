# v0.1.0-alpha.13

首个对外发布的原生 WSL 模式实验版。GitHub Release 请勾选 **Set as a pre-release**。

## 功能

- 在 Windows DeepSeek Harness 原生会话中选择 WSL 模式，在 Linux 后端执行任务。
- 复用 Windows 已配置的模型，通过本地桥转发请求。
- 自动准备私有 Linux 运行时，支持文本流、工具轨迹和取消。
- 保留官方会话服务生命周期，修复插件启停导致的空白界面及已有空白会话迁移失败。

## 环境与安装

仅适配 Windows DeepSeek Harness **0.2.1-rc.3**，已验证 Ubuntu WSL2 x64。使用前先确认发行版可正常启动，并备份现有应用配置。

下载附件 `dsh-wsl-native-0.1.0-alpha.13.tgz` 与同名 `.sha256` 文件。在 PowerShell 中核对摘要：

```powershell
Get-FileHash .\dsh-wsl-native-0.1.0-alpha.13.tgz -Algorithm SHA256
```

通过应用的本地插件安装入口导入 tgz 并启用，重启应用。在原生新会话中选择“WSL 模式”，选择 Windows 本地项目目录后发送文本任务。

## 已知限制

- 单项目、文本输入；不支持附件、fork、跨项目并行和 WSL 到 Windows 原位切换。
- 文件、技能、终端等其他 agent 作用域接口尚未全部路由。
- 会话列表摘要可能未及时刷新，列表与恢复行为仍需进一步验收。
- 尚未完成 alpha.13 全流程窗口操作验收、真实 WSL/Windows 重启恢复与完整沙箱审计。
- 首次启动可能需要从官方源下载 Node、pnpm 和 DSH；需要网络且可能耗时。
- Linux 工具具有当前 WSL 用户的能力；WSL interop 可启动 Windows 进程，请使用专用测试项目。

## 验证范围

已有 2026-10-28 本机记录确认 Linux 工具、双向文件访问、真实模型转发、用户取消和已有空白会话迁移。该记录依据进程、日志及文件证据，不能替代完整 UI 验收。发布准备时重新运行的单测与构建结果见本地生成的 `release-audit.json`。

## Release 附件

- `dsh-wsl-native-0.1.0-alpha.13.tgz`
- `dsh-wsl-native-0.1.0-alpha.13.tgz.sha256`

源码由仓库及 GitHub 标签归档提供。不要上传本机 profile、运行日志、会话历史、解包源码或旧安装包。
