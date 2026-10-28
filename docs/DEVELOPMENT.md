# 开发与验证

仓库根目录保留早期 `dsh-wsl-poc` 面板实现及其回归测试，`package.json` 的 `0.0.5` 是该历史开发包的版本。当前对外发布包为 **dsh-wsl-native 0.1.0-alpha.13**，由构建脚本生成独立 manifest；不要运行根目录的 `npm pack` 代替原生插件构建。

## 目录

| 路径 | 用途 |
| --- | --- |
| `native-plugin-src/` | 对外插件入口、服务生命周期和运行时准备 |
| `native-runtime/` | 原生会话 Linux 路由及隔离探针 |
| `native-probe/` | 早期原生入口探针 |
| `scripts/` | 构建、维护和验证脚本 |
| `test/` | 本地自动回归 |
| 根目录 JS / `desktop-poc.ps1` | 早期面板、共享后端及维护脚本 |
| `.state/`、`scratch/`、`artifacts/` | 本机状态、测试目录和生成物，不上传 |

## 构建

使用带 npm 的 Node.js >=24.9.0：

```powershell
npm test
npm run build:native
```

输出位于 `artifacts/`，包括安装包及 SHA-256。构建无需解包上游应用，也无需复制上游代码。运行时从用户安装的固定版本 Desktop 解析其自身依赖。

## 发布前准备

```powershell
npm run release:prepare
```

脚本根据 Git 的未忽略文件生成独立源码快照，在快照中运行单测和构建，检查明显凭据模式与禁止上传路径，生成本地 `.state/release-upload-<时间>/`，其中 `source/` 可作为仓库内容，`assets/` 用于 GitHub Release。检查属于启发式扫描，公开前仍应人工审阅文件清单。

## 环境集成验证

以下命令要求 Windows、已安装的 DSH 0.2.1-rc.3 和 Ubuntu WSL。它们会创建隔离 profile、启动进程和生成测试文件，需另行执行；普通单测不启动 Desktop 或真实模型。

```powershell
npm run test:native-package
npm run test:native-package:late-enable
```

这些集成命令的模型上游为本地模拟。真实模型和窗口操作验收应独立记录。部分早期 `verify-*` / `inspect-*` 脚本仍依赖原开发目录或本机安装路径，不是通用安装步骤。

## 许可证

本项目已有 MIT 许可证，本次沿用。未将本机解包的第三方应用源码纳入发布内容；上游应用及其依赖遵循各自许可证。本项目是独立实验插件。
