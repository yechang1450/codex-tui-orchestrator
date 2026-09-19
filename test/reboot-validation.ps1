[CmdletBinding()]
param(
  [ValidateSet('prepare','collect')]
  [string]$Mode = 'prepare',
  [string]$Workspace = '',
  [ValidatePattern('^$|^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
  [string]$Id = '',
  [ValidatePattern('^$|^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$')]
  [string]$RecoveryId = '',
  [switch]$ManualOnly,
  [ValidateSet('Manual','RunOnce','StartupFolder')]
  [string]$Trigger = 'Manual'
)

$ErrorActionPreference = 'Stop'
if (-not $Workspace) { $Workspace = Split-Path -Parent $PSScriptRoot }
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
if (-not $Id) {
  if ($Mode -eq 'collect') { throw 'collect requires the original Id.' }
  $Id = [Guid]::NewGuid().ToString('N')
}
$State = Join-Path $Workspace ("temp\reboot-validation-{0}" -f $Id)
$PrePath = Join-Path $State 'pre-reboot.json'
$PostPath = Join-Path $State 'post-reboot.json'
$DispatchPath = Join-Path $State 'dispatch.json'
$Collector = (Resolve-Path -LiteralPath $PSCommandPath).Path
$RunOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$RunOnceName = "CodexTuiOrchestrator-RebootValidation-$Id"
$StartupName = "CodexTuiOrchestrator-RebootValidation-$Id.cmd"

function Write-NewJson([string]$Path, [object]$Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12))
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function BootTime {
  (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
}

function Release-Hash {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($hash.ComputeHash([IO.File]::ReadAllBytes((Join-Path $Workspace 'release.json'))))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}

function Git-Text([string]$Git, [string[]]$Arguments) {
  $value = & $Git -C $Workspace @Arguments | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect repository state.' }
  $value.Trim()
}

function Read-Registration {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\RunOnce')
  if ($key) { try { $key.GetValue($RunOnceName) } finally { $key.Dispose() } }
}

function Remove-OwnedRegistration {
  $value = Read-Registration
  if ($value -and $value.Contains('"' + $Collector + '"') -and $value.Contains('"' + $Id + '"')) {
    Remove-ItemProperty -LiteralPath $RunOnceKey -Name $RunOnceName
    if (Read-Registration) { throw 'RunOnce cleanup read-back failed.' }
  }
  Remove-OwnedStartup
}

# Startup-folder helper. RunOnce has not been executed at logon on this host
# (the value survived two real logons), and creating an ONLOGON scheduled task
# is refused without elevation, so the user's Startup folder is used instead:
# it runs at logon without any administrator rights.
function Startup-Path {
  $folder = [Environment]::GetFolderPath('Startup')
  if (-not $folder) { return $null }
  return Join-Path $folder $StartupName
}

# External tools may return text in the console code page; strip anything
# outside printable ASCII before it is written into a JSON baseline, otherwise
# the mojibake can break the document (seen with a refused schtasks call).
function Sanitize-Text([object]$Value) {
  $text = [string]$Value
  if (-not $text) { return '' }
  $clean = -join ($text.ToCharArray() | Where-Object { [int]$_ -ge 32 -and [int]$_ -lt 127 })
  return $clean.Trim()
}

function Read-StartupRegistration {
  $path = Startup-Path
  if (-not $path) { return $null }
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $text = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
  if ($text -and $text.Contains($Collector) -and $text.Contains($Id)) { return $text }
  return $null
}

function Remove-OwnedStartup {
  if (Read-StartupRegistration) { Remove-Item -LiteralPath (Startup-Path) -Force }
}

function Invoke-Check([string]$Label, [string]$Command, [string[]]$Arguments, [int]$TimeoutMs = 30000) {
  $process = [Diagnostics.Process]::new()
  $result = [ordered]@{ label = $Label; exitCode = $null; output = ''; stderr = ''; valid = $false; error = $null }
  try {
    $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $process.StartInfo.FileName = $Command
    $process.StartInfo.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $process.StartInfo.WorkingDirectory = $Workspace
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $process.StartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMs)) {
      $process.Kill()
      $process.WaitForExit()
      throw "Check timed out after $TimeoutMs milliseconds."
    }
    $result.exitCode = $process.ExitCode
    $result.output = $stdout.GetAwaiter().GetResult().Trim()
    $result.stderr = $stderr.GetAwaiter().GetResult().Trim()
    if ($result.exitCode -ne 0) { throw "Health check exited with $($result.exitCode)." }
    $receipt = $result.output | ConvertFrom-Json
    switch ($Label) {
      'release-integrity' { $result.valid = ($receipt.schema -in @(1,2)) -and $receipt.files -gt 0 -and [bool]$receipt.coreVersion }
      'doctor' { $result.valid = $receipt.agent -eq 'codex' -and $receipt.workspace -eq $Workspace -and (Test-Path -LiteralPath $receipt.cli -PathType Leaf) }
      'marketplace-registration' { $result.valid = $receipt.ok -eq $true -and $receipt.status -eq 'matched' -and $receipt.pluginReal -eq $Workspace }
      'task-recovery' { $result.valid = $receipt.passed -eq $true -and $receipt.runId -eq ('reboot-' + $preRecord.recoveryId) }
    }
    if (-not $result.valid) { throw 'Health check receipt does not match its contract or workspace.' }
  } catch { $result.error = $_.Exception.Message } finally { $process.Dispose() }
  [pscustomobject]$result
}

if ($Mode -eq 'prepare') {
  if (Test-Path -LiteralPath $State) { throw 'Validation Id already exists; use a new Id without overwriting the baseline.' }
  $gitPath = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  # Version managers may expose a per-shell link that does not survive reboot.
  $installedNode = (& $nodePath -p "require('fs').realpathSync.native(process.execPath)" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $installedNode -or -not (Test-Path -LiteralPath $installedNode -PathType Leaf)) { throw 'Cannot resolve the installed Node runtime.' }
  $nodePath = $installedNode
  $commit = Git-Text $gitPath @('rev-parse','HEAD')
  $sourceClean = -not (Git-Text $gitPath @('status','--porcelain','--untracked-files=no'))
  if (-not $sourceClean) { throw 'Commit tracked changes before preparing a reboot baseline.' }
  if ($RecoveryId) {
    $recovery = Get-Content -Raw -LiteralPath (Join-Path $Workspace "temp\reboot-recovery-$RecoveryId\pre-reboot.json") | ConvertFrom-Json
    if ($recovery.id -ne $RecoveryId -or $recovery.runId -ne ('reboot-' + $RecoveryId) -or $recovery.workspace -ne $Workspace -or $recovery.ready -ne $true) { throw 'Task recovery baseline is not ready or belongs to another run.' }
  }
  $preRecord = [ordered]@{
    schema = 2; id = $Id; workspace = $Workspace; commit = $commit
    user = [Environment]::UserName; bootBefore = BootTime; preparedAt = [DateTime]::UtcNow.ToString('o')
    releaseSha256 = Release-Hash
    recoveryId = $RecoveryId
    nodePath = $nodePath; gitPath = $gitPath; runOnceName = $RunOnceName; collector = $Collector
    registration = [ordered]@{ status = 'manual-only'; error = $null }
  }
  New-Item -ItemType Directory -Path $State | Out-Null
  if (-not $ManualOnly) {
    # Registration is best effort: it does not prove that Windows executed it.
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Mode collect -Id "{1}" -Trigger RunOnce' -f $Collector, $Id
    if ($Workspace -ne (Split-Path -Parent $PSScriptRoot)) { $arguments += ' -Workspace "{0}"' -f $Workspace }
    $command = 'powershell.exe ' + $arguments
    try {
      if ($command.Length -gt 260) { throw 'RunOnce command exceeds the Windows 260-character limit; use manual collect.' }
      if (Read-Registration) { throw 'A registration with this Id already exists.' }
      if (-not (Test-Path -LiteralPath $RunOnceKey)) { New-Item -Path $RunOnceKey | Out-Null }
      New-ItemProperty -LiteralPath $RunOnceKey -Name $RunOnceName -Value $command -PropertyType String | Out-Null
      if ((Read-Registration) -ne $command) { throw 'RunOnce registration read-back failed.' }
      $preRecord.registration.status = 'registered-unverified'
    } catch { $preRecord.registration.status = 'unavailable'; $preRecord.registration.error = $_.Exception.Message }
    # Second trigger: a .cmd in the user's Startup folder. Runs at logon without
    # elevation and is independent of the RunOnce list.
    try {
      $startupPath = Startup-Path
      if (-not $startupPath) { throw 'The Startup folder is unavailable.' }
      if (Read-StartupRegistration) { throw 'A startup entry with this Id already exists.' }
      $startupCommand = '{0} -NoProfile -NonInteractive -WindowStyle Hidden -File "{1}" -Mode collect -Id "{2}" -Trigger StartupFolder' -f (Join-Path $PSHOME 'powershell.exe'), $Collector, $Id
      if ($Workspace -ne (Split-Path -Parent $PSScriptRoot)) { $startupCommand += ' -Workspace "{0}"' -f $Workspace }
      Set-Content -LiteralPath $startupPath -Value ('@echo off' + [Environment]::NewLine + $startupCommand) -Encoding ASCII
      if (-not (Read-StartupRegistration)) { throw 'Startup registration read-back failed.' }
      $preRecord.registration.startup = 'registered-unverified'
    } catch { $preRecord.registration.startup = 'unavailable'; $preRecord.registration.startupError = (Sanitize-Text $_.Exception.Message) }
  }
  try { Write-NewJson $PrePath $preRecord } catch { Remove-OwnedRegistration; throw }
  [pscustomobject]@{ prepared = $true; pre = $PrePath; id = $Id; registration = $preRecord.registration; bootBefore = $preRecord.bootBefore; commit = $commit } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if (-not (Test-Path -LiteralPath $PrePath)) { throw "Missing pre-reboot record: $PrePath" }
if (Test-Path -LiteralPath $PostPath) { throw 'A collection receipt already exists; read it without overwriting the evidence.' }
# This marker is the first durable receipt of a dispatched collector.  It
# distinguishes "RunOnce was never launched" from "collector launched but a
# later health check failed" without overwriting an existing first dispatch.
if (-not (Test-Path -LiteralPath $DispatchPath)) {
  try {
    Write-NewJson $DispatchPath ([ordered]@{
      schema = 1; id = $Id; trigger = $Trigger; pid = $PID
      user = [Environment]::UserName; host = [Environment]::MachineName
      dispatchedAt = [DateTime]::UtcNow.ToString('o')
    })
  } catch { }
}
$post = [ordered]@{
  schema = 2; id = $Id; workspace = $Workspace; scope = 'post-reboot-health'
  collectionTrigger = $Trigger; automaticCollectionPassed = $false
  commitBefore = $null; commitAfter = $null; commitMatches = $false; sourceClean = $false
  bootBefore = $null; bootAfter = $null; bootChanged = $false; releaseMatches = $false
  checks = @(); passed = $false; error = $null; failedStage = $null; registrationCleanupError = $null
  collectedAt = $null
}
$stage = 'read-baseline'
try {
  $preRecord = Get-Content -Raw -LiteralPath $PrePath | ConvertFrom-Json
  if ($preRecord.schema -notin @(1,2) -or $preRecord.id -ne $Id -or $preRecord.workspace -ne $Workspace -or $preRecord.user -ne [Environment]::UserName -or $preRecord.commit -notmatch '^[a-f0-9]{40}$') { throw 'Baseline identity or schema does not match this collection.' }
  $post.commitBefore = $preRecord.commit
  $post.bootBefore = $preRecord.bootBefore
  $stage = 'boot-time'
  $post.bootAfter = BootTime
  $post.bootChanged = [DateTimeOffset]::Parse($post.bootAfter) -gt [DateTimeOffset]::Parse($post.bootBefore)
  $stage = 'runtime'
  $node = if ($preRecord.schema -eq 2) { $preRecord.nodePath } else { (Get-Command node -CommandType Application | Select-Object -First 1).Source }
  $git = if ($preRecord.schema -eq 2) { $preRecord.gitPath } else { (Get-Command git -CommandType Application | Select-Object -First 1).Source }
  if (-not $node -or -not (Test-Path -LiteralPath $node -PathType Leaf) -or -not $git -or -not (Test-Path -LiteralPath $git -PathType Leaf)) { throw 'Prepared runtime is unavailable.' }
  $stage = 'repository'
  $post.commitAfter = Git-Text $git @('rev-parse','HEAD')
  $post.commitMatches = $post.commitBefore -eq $post.commitAfter
  $post.sourceClean = -not (Git-Text $git @('status','--porcelain','--untracked-files=no'))
  $post.releaseMatches = $preRecord.schema -eq 2 -and $preRecord.releaseSha256 -eq (Release-Hash)
  $stage = 'health-checks'
  $post.checks = @(
    (Invoke-Check 'release-integrity' $node @((Join-Path $Workspace 'scripts\release-integrity.mjs'))),
    (Invoke-Check 'doctor' $node @((Join-Path $Workspace 'scripts\orchestrate-sdk.mjs'), '--doctor')),
    (Invoke-Check 'marketplace-registration' $node @((Join-Path $Workspace 'scripts\repair-plugin-registration.mjs'), $Workspace, '--check'))
  )
  if ($preRecord.recoveryId) {
    $post.scope = 'post-reboot-health-and-task-recovery'
    if ($post.bootChanged -and $post.commitMatches -and $post.sourceClean -and $post.releaseMatches -and @($post.checks | Where-Object { -not $_.valid }).Count -eq 0) {
      $stage = 'task-recovery'
      $post.checks += Invoke-Check 'task-recovery' $node @((Join-Path $Workspace 'test\live-reboot-recovery.mjs'), 'collect', $preRecord.recoveryId) 930000
    } else { throw 'Task recovery requires a validated later boot and unchanged healthy source.' }
  }
  $post.passed = $post.bootChanged -and $post.commitMatches -and $post.sourceClean -and $post.releaseMatches -and @($post.checks | Where-Object { -not $_.valid }).Count -eq 0
  # Invocation metadata alone is not independent proof of Windows logon dispatch.
  $post.automaticCollectionPassed = $false
} catch { $post.error = $_.Exception.Message; $post.failedStage = $stage }
finally {
  try { Remove-OwnedRegistration } catch { $post.registrationCleanupError = $_.Exception.Message; $post.passed = $false }
  $post.collectedAt = [DateTime]::UtcNow.ToString('o')
  Write-NewJson $PostPath $post
}
$post | ConvertTo-Json -Depth 12 -Compress
if (-not $post.passed) { exit 1 }
