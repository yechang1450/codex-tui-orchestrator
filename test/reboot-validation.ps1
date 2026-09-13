param(
  [ValidateSet('prepare','collect')]
  [string]$Mode = 'prepare',
  [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
  [string]$Id = ''
)

$ErrorActionPreference = 'Stop'
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
if (-not $Id) { $Id = [Guid]::NewGuid().ToString('N') }
$State = Join-Path $Workspace ("temp\reboot-validation-{0}" -f $Id)
$PrePath = Join-Path $State 'pre-reboot.json'
$PostPath = Join-Path $State 'post-reboot.json'
$Script = (Resolve-Path -LiteralPath $PSCommandPath).Path
$RunOnceName = "CodexTuiOrchestrator-RebootValidation-$Id"

function Write-JsonFile([string]$Path, [object]$Value) {
  New-Item -ItemType Directory -Force (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
}

function BootTime {
  (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
}

function Invoke-Check([string]$Label, [string]$Command, [string[]]$Arguments) {
  $out = & $Command @Arguments 2>&1 | Out-String
  [pscustomobject]@{ label = $Label; exitCode = $LASTEXITCODE; output = $out.Trim() }
}

if ($Mode -eq 'prepare') {
  New-Item -ItemType Directory -Force $State | Out-Null
  $commit = (& git -C $Workspace rev-parse HEAD 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $commit) { throw 'Cannot read repository commit.' }
  $preRecord = [pscustomobject]@{
    schema = 1
    id = $Id
    workspace = $Workspace
    commit = $commit
    user = [Environment]::UserName
    bootBefore = BootTime
    preparedAt = [DateTime]::UtcNow.ToString('o')
    runOnceName = $RunOnceName
    collector = $Script
  }
  Write-JsonFile $PrePath $preRecord
  $args = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode collect -Workspace "{1}" -Id "{2}"' -f $Script, $Workspace, $Id
  New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Force | Out-Null
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name $RunOnceName -Value ("powershell.exe {0}" -f $args) -PropertyType String -Force | Out-Null
  [pscustomobject]@{ prepared = $true; pre = $PrePath; runOnceName = $RunOnceName; bootBefore = $preRecord.bootBefore; commit = $commit } | ConvertTo-Json -Compress
  exit 0
}

if (-not (Test-Path -LiteralPath $PrePath)) { throw "Missing pre-reboot record: $PrePath" }
$preRecord = Get-Content -Raw -LiteralPath $PrePath | ConvertFrom-Json
$bootAfter = BootTime
$node = (Get-Command node -ErrorAction Stop).Source
$checks = @(
  (Invoke-Check 'release-integrity' $node @((Join-Path $Workspace 'scripts\release-integrity.mjs'))),
  (Invoke-Check 'doctor' $node @((Join-Path $Workspace 'scripts\orchestrate-sdk.mjs'), '--doctor')),
  (Invoke-Check 'marketplace-registration' $node @((Join-Path $Workspace 'scripts\repair-plugin-registration.mjs'), '--check'))
)
$bootChanged = $preRecord.bootBefore -ne $bootAfter
$passed = $bootChanged -and (($checks | Where-Object { $_.exitCode -ne 0 }).Count -eq 0)
$post = [pscustomobject]@{
  schema = 1
  id = $preRecord.id
  workspace = $Workspace
  commit = $preRecord.commit
  bootBefore = $preRecord.bootBefore
  bootAfter = $bootAfter
  bootChanged = $bootChanged
  checks = $checks
  passed = $passed
  collectedAt = [DateTime]::UtcNow.ToString('o')
}
Write-JsonFile $PostPath $post
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name $RunOnceName -ErrorAction SilentlyContinue
$post | ConvertTo-Json -Compress
if (-not $passed) { exit 1 }
