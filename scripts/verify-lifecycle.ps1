$ErrorActionPreference = 'Stop'
$pocRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $pocRoot 'desktop-poc.ps1'
$profile = Join-Path $pocRoot '.state\windows-home\profiles\desktop'
$patch = Join-Path $profile 'cordis.patch.yml'
$priorPatchHash = (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash
$report = [ordered]@{ test = '0.0.3-isolated-desktop-plugin-lifecycle'; steps = @(); ok = $false }
try {
  $operations = @(
    @{ Stage='Upgrade'; Version='0.0.3' },
    @{ Stage='Uninstall'; Version=$null },
    @{ Stage='Install'; Version='0.0.3' },
    @{ Stage='Upgrade'; Version='0.0.2' },
    @{ Stage='Upgrade'; Version='0.0.3' }
  )
  foreach ($operation in $operations) {
    $params = @{ Stage=$operation.Stage }
    if ($operation.Version) { $params.PackagePath = Join-Path $pocRoot ('artifacts\dsh-wsl-poc-' + $operation.Version + '.tgz') }
    & $entry @params
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $profile 'package.json') | ConvertFrom-Json
    $registered = @($manifest.dsh.profile.bundles) -contains 'dsh-wsl-poc'
    if ($registered -ne ($operation.Stage -ne 'Uninstall')) { throw 'Unexpected plugin registration' }
    if ($operation.Version) {
      $installed = Get-Content -Raw -LiteralPath (Join-Path $profile 'node_modules\dsh-wsl-poc\package.json') | ConvertFrom-Json
      if ($installed.version -ne $operation.Version) { throw 'Installed package version mismatch' }
    }
    if ((Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash -ne $priorPatchHash) { throw 'User model patch changed' }
    $report.steps += [ordered]@{ stage=$operation.Stage; version=$operation.Version; registrationVerified=$true; modelPatchUnchanged=$true }
  }
  & $entry -Stage Shortcut
  $report.shortcutCreated = Test-Path -LiteralPath (Join-Path $pocRoot '启动 WSL Desktop.lnk')
  $report.ok = $true
} catch { $report.error = $_.Exception.Message; throw }
finally { $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $pocRoot 'artifacts\lifecycle-evidence-0.0.3.json') -Encoding utf8 }
