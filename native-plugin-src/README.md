# 原生 WSL 模式插件 0.1.0-alpha.13（启停卡死修复）

适用：Windows DeepSeek Harness **0.2.1-rc.3**，普通 WSL 开发发行版。实验版仅支持一个 WSL 项目、文本输入；尚未完成 Desktop 全流程实机验收，不建议直接替换日常配置。

保留官方 SessionController、AgentLoop 和 Sessions 客户端的生命周期，插件只可逆地接管 WSL 路由方法。插件包不再携带前端入口，不停用内置核心服务，避免启停时拆除会话界面适配器。列表与控制流读取缓存，后台刷新不启动 WSL。

隔离验收时选择 `dsh-wsl-native-0.1.0-alpha.13.tgz`，或使用官方 CLI：

```powershell
dsh plugin --profile desktop add C:\完整路径\dsh-wsl-native-0.1.0-alpha.13.tgz
```

重启应用后，在原生新会话的模式菜单选择“WSL 模式”，再选择 Windows 项目目录并发送文本任务。无需打开独立面板或手动启动 Linux 后端。标准模式保留 Windows 执行。

插件设置：`distro` 默认 Ubuntu；`modelMode` 默认 host，复用 Windows 已配置的默认模型。`mock` 仅用于离线验收，不能提供真实推理。不要把模拟模型的固定响应当成正常模型行为。

首次使用会自动准备当前 Windows DSH_HOME 对应的 Linux 私有状态目录；优先复用已有受管理的 0.2.1-rc.3 运行时。不存在时，从官方 Node 下载并校验 Node 24.21.0，通过 npm 官方仓库安装固定 DSH 与 pnpm。运行时位于 `~/.local/share/dsh-wsl-native/shared`，不替换系统 Node。Windows 缓存、映射和后端副本位于 DSH_HOME 下的 `native-wsl` 与 `native-wsl-routes.json`。

限制：不支持附件、fork、跨项目并行和 WSL→Windows 的原位切换；目录/技能等依赖 agentId 的接口尚未全部适配。状态更新仍有轮询，异常事务与真实模型验收待补齐。只在 DSH 0.2.1-rc.3 上固定适配，其他版本拒绝激活。

卸载使用应用插件管理页或 `dsh plugin --profile desktop remove dsh-wsl-native`；卸载后恢复内置 Controller/Agent Loop。缓存、Linux 历史和映射保留，不自动删除项目文件或运行时。升级与卸载前先结束 WSL 任务并退出应用。
