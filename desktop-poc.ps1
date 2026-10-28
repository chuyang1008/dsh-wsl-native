param(
  [ValidateSet('Init','Install','Upgrade','Uninstall','Launch','Doctor','Shortcut')][string]$Stage = 'Launch',
  [string]$DshHome = (Join-Path $PSScriptRoot '.state\windows-home'),
  [string]$UserDataPath = (Join-Path $PSScriptRoot '.state\desktop-userdata'),
  [string]$PackagePath = $PSScriptRoot,
  [switch]$Mock
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 (pwsh.exe) 运行此脚本。' }
$pocRoot = $PSScriptRoot
$desktopRoot = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
$desktopExe = Join-Path $desktopRoot 'DeepSeek Harness.exe'
$cli = Join-Path $desktopRoot 'resources\runtime\cli\bin\dsh.cmd'
if (-not [IO.Path]::IsPathFullyQualified($DshHome) -or -not [IO.Path]::IsPathFullyQualified($UserDataPath)) { throw 'DshHome 和 UserDataPath 必须使用绝对路径。' }
$pocHome = [IO.Path]::GetFullPath($DshHome)
$pocUserData = [IO.Path]::GetFullPath($UserDataPath)
$profileRoot = Join-Path $pocHome 'profiles\desktop'
$manifestPath = Join-Path $profileRoot 'package.json'
if (-not (Test-Path -LiteralPath $desktopExe)) { throw "Desktop not found: $desktopExe" }
$pocProcesses = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($Stage -eq 'Shortcut') {
  $pocShell = (Get-Process -Id $PID).Path
  $pocShortcutPath = Join-Path $pocRoot '启动 WSL Desktop.lnk'
  $pocWshShell = New-Object -ComObject WScript.Shell
  $pocShortcut = $pocWshShell.CreateShortcut($pocShortcutPath)
  $pocShortcut.TargetPath = $pocShell
  $pocShortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $PSCommandPath + '" -Stage Launch -DshHome "' + $pocHome + '" -UserDataPath "' + $pocUserData + '"'
  $pocShortcut.WorkingDirectory = $pocRoot
  $pocShortcut.IconLocation = $desktopExe + ',0'
  $pocShortcut.Description = '启动 WSL 插件 Desktop，保留目标模型配置'
  $pocShortcut.Save()
  Write-Output "已生成快捷方式：$pocShortcutPath"
  return
}
if ($Stage -eq 'Doctor') {
  $manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json } else { $null }
  [pscustomobject]@{
    DesktopVersion = (Get-Item -LiteralPath $desktopExe).VersionInfo.ProductVersion
    Running = $pocProcesses.Count -gt 0
    DshHome = $pocHome
    ProfileInitialized = $null -ne $manifest
    PluginInstalled = $null -ne $manifest -and @($manifest.dsh.profile.bundles) -contains 'dsh-wsl-poc'
    PluginSource = if ($manifest) { $manifest.dependencies.'dsh-wsl-poc' } else { $null }
    SourceVersion = (Get-Content -Raw -LiteralPath (Join-Path $pocRoot 'package.json') | ConvertFrom-Json).version
  } | Format-List
  return
}
if ($pocProcesses.Count -gt 0) {
  throw '请先从托盘完整退出当前 Desktop。该脚本不会关闭现有进程。'
}
if ($Mock -and $Stage -ne 'Launch') { throw '-Mock 仅适用于 Launch。' }
$priorDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $pocHome
  if ($Stage -in @('Install','Upgrade','Uninstall')) {
    if (-not (Test-Path -LiteralPath $manifestPath)) {
      throw '请先执行 -Stage Init，由官方应用初始化独立 profile，再完整退出应用。'
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $installed = (@($manifest.dsh.profile.bundles) -contains 'dsh-wsl-poc') -or ($null -ne $manifest.dependencies.'dsh-wsl-poc')
    if ($Stage -eq 'Upgrade' -and -not $installed) { throw '目标尚未安装插件，请先使用 Install。' }
    if ($Stage -eq 'Uninstall' -and -not $installed) { Write-Output '目标未安装插件，无需卸载。'; return }
    if ($Stage -ne 'Uninstall') {
      $pocPackage = (Resolve-Path -LiteralPath $PackagePath).Path
      if (Test-Path -LiteralPath $pocPackage -PathType Container) {
        $candidate = Get-Content -Raw -LiteralPath (Join-Path $pocPackage 'package.json') | ConvertFrom-Json
        if ($candidate.name -ne 'dsh-wsl-poc') { throw 'PackagePath 不是插件目录。' }
      } elseif ([IO.Path]::GetExtension($pocPackage) -ne '.tgz') { throw 'PackagePath 必须是本地插件目录或 .tgz。' }
      else {
        # An unchanged tarball path/version can reuse old pnpm contents. Give
        # each byte-distinct archive an immutable source path before adding it.
        $pocArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pocPackage).Hash.ToLowerInvariant()
        $pocArchiveDir = Join-Path $pocRoot ('.state\packages\' + $pocArchiveHash)
        $pocArchivePath = Join-Path $pocArchiveDir 'dsh-wsl-poc.tgz'
        New-Item -ItemType Directory -Path $pocArchiveDir -Force | Out-Null
        if (-not (Test-Path -LiteralPath $pocArchivePath)) { Copy-Item -LiteralPath $pocPackage -Destination $pocArchivePath }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $pocArchivePath).Hash.ToLowerInvariant() -ne $pocArchiveHash) { throw 'Cached archive checksum mismatch' }
        $pocPackage = $pocArchivePath
      }
    }
    # Dependency metadata only: never copy model settings or credentials into artifacts.
    $pocBackup = Join-Path $pocRoot ('.state\backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $pocBackup -Force | Out-Null
    foreach ($name in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml')) {
      $source = Join-Path $profileRoot $name
      if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $pocBackup $name) }
    }
    $patchPath = Join-Path $profileRoot 'cordis.patch.yml'
    $patchBytes = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllBytes($patchPath) } else { $null }
    # pnpm can leave a development junction behind on Windows. Unlink only this
    # exact reparse point, never recursively delete its source checkout.
    $pocPluginLink = [IO.Path]::GetFullPath((Join-Path $profileRoot 'node_modules\dsh-wsl-poc'))
    $pocModulesRoot = [IO.Path]::GetFullPath((Join-Path $profileRoot 'node_modules')) + [IO.Path]::DirectorySeparatorChar
    if (-not $pocPluginLink.StartsWith($pocModulesRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Plugin link escaped target profile' }
    $pocLink = Get-Item -Force -LiteralPath $pocPluginLink -ErrorAction SilentlyContinue
    if ($pocLink -and $pocLink.LinkType -eq 'Junction') {
      $pocLinkTarget = $pocLink.ResolveLinkTarget($true).FullName
      $pocLinkedPackage = Get-Content -Raw -LiteralPath (Join-Path $pocLinkTarget 'package.json') | ConvertFrom-Json
      if ($pocLinkedPackage.name -ne 'dsh-wsl-poc') { throw 'Unexpected plugin junction target' }
      [IO.Directory]::Delete($pocPluginLink)
    }
    if ($Stage -eq 'Uninstall') { & $cli plugin --profile desktop remove dsh-wsl-poc }
    else {
      # Official reconciliation activates newly added dependencies only. A prior
      # failed install may have a dependency with no selected bundle: remove that
      # exact dependency first so the official add can validate and activate it.
      if ($manifest.dependencies.'dsh-wsl-poc' -and -not (@($manifest.dsh.profile.bundles) -contains 'dsh-wsl-poc')) {
        & $cli plugin --profile desktop remove dsh-wsl-poc
        if ($LASTEXITCODE -ne 0) { throw '无法修复上次未完成的插件安装；已保留现场。' }
      }
      & $cli plugin --profile desktop add $pocPackage
    }
    $pocExitCode = $LASTEXITCODE
    $patchAfter = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllBytes($patchPath) } else { $null }
    $patchChanged = [Convert]::ToBase64String([byte[]]@($patchBytes)) -cne [Convert]::ToBase64String([byte[]]@($patchAfter))
    if ($patchChanged -and $null -ne $patchBytes) { [IO.File]::WriteAllBytes($patchPath, [byte[]]$patchBytes) }
    if ($patchChanged) { throw "模型 patch 意外变化，已有内容已恢复；请核查。元数据备份：$pocBackup" }
    if ($pocExitCode -ne 0) { throw "插件操作失败，保留现场。元数据备份：$pocBackup" }
    $after = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $present = @($after.dsh.profile.bundles) -contains 'dsh-wsl-poc'
    if ($present -ne ($Stage -ne 'Uninstall')) { throw "官方 profile 插件注册与预期不符。备份：$pocBackup" }
    Write-Output "已完成 $Stage。DSH_HOME=$pocHome；模型配置已保留。元数据备份：$pocBackup"
  } elseif ($Stage -eq 'Launch') {
    $pocLauncher = Join-Path $pocRoot 'scripts\launch-desktop-test.mjs'
    $pocNode = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $startInfo = [Diagnostics.ProcessStartInfo]::new($pocNode)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    foreach ($argument in @($pocLauncher, '--home', $pocHome, '--user-data-dir', $pocUserData)) { $startInfo.ArgumentList.Add($argument) }
    if ($Mock) { $startInfo.ArgumentList.Add('--mock') }
    [Diagnostics.Process]::Start($startInfo) | Out-Null
    Write-Output '已启动原型专用 Desktop；默认保留已有模型配置，登录和密钥设置由用户在应用内完成。'
  } else {
    Start-Process -FilePath $desktopExe -ArgumentList ('--user-data-dir="' + $pocUserData + '"') -WindowStyle Hidden | Out-Null
    Write-Output "已请求启动官方 Desktop，使用 DSH_HOME=$pocHome"
    if ($Stage -eq 'Init') { Write-Output '等待应用完成初始化后完整退出，再执行 -Stage Install。遇到登录界面请人工处理。' }
  }
} finally {
  if ($null -eq $priorDshHome) { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue } else { $env:DSH_HOME = $priorDshHome }
}
