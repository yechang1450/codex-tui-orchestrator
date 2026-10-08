# SessionStart command hook. No model calls, task launches, or host trust changes.
# Dot sourcing exposes the functions without executing the hook.
function New-OrchSessionOutput {
    param([string]$Code, [string]$Message)
    return @{ continue = $true; hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = "[codex-tui-orchestrator] ${Code}: $Message" } }
}

function Get-OrchSessionAvailableMemoryMB {
    Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop
    $computer = New-Object Microsoft.VisualBasic.Devices.ComputerInfo
    return [math]::Floor($computer.AvailablePhysicalMemory / 1MB)
}

function Invoke-OrchSessionStart {
    param(
        [AllowEmptyString()][string]$InputJson,
        [Parameter(Mandatory)][string]$PluginRoot,
        [AllowEmptyString()][string]$DataRoot = $env:PLUGIN_DATA,
        [ValidateRange(1,110)][int]$PrepareTimeoutSeconds = 110
    )
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    try {
        if (-not $InputJson -or $InputJson.Length -gt 65536 -or -not $InputJson.TrimStart().StartsWith('{')) { throw 'invalid input' }
        $event = ConvertFrom-Json -InputObject $InputJson -ErrorAction Stop
        if ($event -isnot [pscustomobject]) { throw 'invalid input' }
    } catch { return New-OrchSessionOutput 'INVALID_INPUT' 'Preparation skipped because the event was invalid; continue inline.' }
    if (-not ($event.PSObject.Properties.Name -contains 'hook_event_name') -or $event.hook_event_name -ne 'SessionStart') { return New-OrchSessionOutput 'UNRELATED_EVENT' 'Preparation skipped for a different lifecycle event.' }
    if (-not ($event.PSObject.Properties.Name -contains 'session_id') -or $event.session_id -isnot [string] -or [string]::IsNullOrWhiteSpace($event.session_id)) { return New-OrchSessionOutput 'NO_SESSION' 'No active session was supplied; no preparation or task execution started.' }
    if ($env:ORCH_RUN_ID -or $env:ORCH_BLOCK_ID -or $env:ORCH_WINDOW -eq '1' -or $env:ORCH_EXECUTION -eq '1' -or $env:ORCH_HOOK_PREPARING -eq '1') {
        return New-OrchSessionOutput 'CHILD_SESSION' 'Parent preparation applies to this worker; recursive preparation and orchestration are disabled.'
    }
    if (-not ($event.PSObject.Properties.Name -contains 'source')) { return New-OrchSessionOutput 'INVALID_INPUT' 'Preparation skipped because the start source was missing; continue inline.' }
    if ($event.source -eq 'compact') { return New-OrchSessionOutput 'COMPACTION' 'The existing session owns its runtime; no repeated preparation or task execution started.' }
    if ($event.source -notin @('startup','resume','clear')) { return New-OrchSessionOutput 'INVALID_INPUT' 'Preparation skipped because the start source was invalid; continue inline.' }
    try {
        $available = [double](Get-OrchSessionAvailableMemoryMB)
        if ([double]::IsNaN($available) -or [double]::IsInfinity($available) -or $available -le 0) { throw 'invalid memory reading' }
    } catch { return New-OrchSessionOutput 'MEMORY_UNAVAILABLE' 'Available memory could not be confirmed; continue inline without orchestration.' }
    $reserve = [double]1000
    if ($env:ORCH_MIN_AVAILABLE_MB) {
        $requested = [double]0
        if ([double]::TryParse($env:ORCH_MIN_AVAILABLE_MB, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$requested) -and
            -not [double]::IsNaN($requested) -and -not [double]::IsInfinity($requested)) {
            $reserve = [math]::Max($reserve, [math]::Floor($requested))
        }
    }
    if ($available -le $reserve) { return New-OrchSessionOutput 'LOW_MEMORY' "Available memory is at or below the $reserve MB reserve; continue inline without orchestration." }

    $lock = $null
    try {
        # Reuse the bootstrap's path validation and bounded native process helper.
        . (Join-Path $PluginRoot 'scripts\runtime-bootstrap.ps1')
        $bootstrap = Assert-OrchSafePath (Join-Path $PluginRoot 'scripts\bootstrap.ps1')
        if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw 'bootstrap missing' }
        $manualPrepareCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $bootstrap + '" -Action prepare -Json'
        $dataHome = if ($DataRoot) { $DataRoot } else { Join-Path $PluginRoot 'temp' }
        $stateHome = Assert-OrchSafePath (Join-Path $dataHome 'session-start')
        [void][IO.Directory]::CreateDirectory($stateHome)
        $statePath = Assert-OrchSafePath (Join-Path $stateHome 'state.json')
        $lockPath = Assert-OrchSafePath (Join-Path $stateHome 'prepare.lock')
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { return New-OrchSessionOutput 'PREPARE_BUSY' 'Another session is preparing the runtime; continue inline until it finishes.' }
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $hasher = [Security.Cryptography.SHA256]::Create()
        $bootstrapStream = [IO.File]::OpenRead($bootstrap)
        try { $fingerprint = [BitConverter]::ToString($hasher.ComputeHash($bootstrapStream)).Replace('-','') }
        finally { $bootstrapStream.Dispose(); $hasher.Dispose() }
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            try {
                if ((Get-Item -LiteralPath $statePath).Length -gt 8192) { throw 'state too large' }
                $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
                if ($state.schema -eq 1 -and $state.fingerprint -eq $fingerprint -and $state.retryAfter -gt $now -and $state.retryAfter -le ($now + 600)) {
                    return New-OrchSessionOutput 'COOLDOWN' ('A recent preparation attempt failed; continue inline. Automatic retry is limited to once per ten minutes; ' + $manualPrepareCommand + ' can be run explicitly.')
                }
            } catch { # Corrupt state is not evidence of runtime health.
            }
        }
        # Record the bounded attempt first so an interrupted preparation cannot loop.
        $state = @{ schema = 1; fingerprint = $fingerprint; retryAfter = $now + 600; outcome = 'preparing' }
        [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        $code = 'PREPARE_FAILED'
        try {
            $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $previousPreparing = $env:ORCH_HOOK_PREPARING
            $previousPluginData = $env:PLUGIN_DATA
            try {
                $env:ORCH_HOOK_PREPARING = '1'
                $env:PLUGIN_DATA = $DataRoot
                $result = Invoke-OrchProcess -FilePath $powershell -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$bootstrap,'-Action','prepare','-Json','-TimeoutSeconds',[string]$PrepareTimeoutSeconds) -TimeoutSeconds $PrepareTimeoutSeconds
            } finally { $env:ORCH_HOOK_PREPARING = $previousPreparing; $env:PLUGIN_DATA = $previousPluginData }
            if ($result.ExitCode -ne 0 -or $result.Stdout.Length -gt 65536) { throw 'prepare failed' }
            $prepared = ConvertFrom-Json -InputObject $result.Stdout -ErrorAction Stop
            if ($prepared -isnot [pscustomobject] -or $prepared.ok -isnot [bool] -or $prepared.ok -ne $true -or $prepared.stage -ne 'ready') { throw 'prepare result invalid' }
            $code = 'READY'
        } catch {
            if ($_.Exception.Message -like 'PROCESS_TIMEOUT:*') { $code = 'PREPARE_TIMEOUT' }
            # Never expose child stdout/stderr or exception text: package tools may
            # include proxy credentials, command arguments, or other sensitive data.
        }
        $state.outcome = $code
        if ($code -eq 'READY') { $state.retryAfter = 0 }
        [void](Assert-OrchSafePath $statePath)
        [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        if ($code -eq 'READY') {
            return New-OrchSessionOutput $code 'Environment preparation passed. Wait for an authorized task, then use the skill to assess independent blocks; one block stays inline. Preparation alone launches no task.'
        }
        return New-OrchSessionOutput $code ('Environment preparation did not finish successfully; continue inline without orchestration. Diagnose with ' + $manualPrepareCommand + '; automatic retry is limited to once per ten minutes.')
    } catch { return New-OrchSessionOutput 'STATE_UNAVAILABLE' 'Preparation state or bootstrap files could not be accessed safely; continue inline without orchestration.' }
    finally { if ($null -ne $lock) { $lock.Dispose() } }
}

if ($MyInvocation.InvocationName -ne '.') {
    [Console]::InputEncoding = [Text.Encoding]::UTF8
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $OutputEncoding = [Text.Encoding]::UTF8
    try {
        $pluginRoot = Split-Path -Parent $PSScriptRoot
        $output = Invoke-OrchSessionStart -InputJson ([Console]::In.ReadToEnd()) -PluginRoot $pluginRoot
        [Console]::Out.WriteLine(($output | ConvertTo-Json -Depth 6 -Compress))
    } catch {
        [Console]::Out.WriteLine('{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[codex-tui-orchestrator] HOOK_FAILED: Environment preparation unavailable; continue inline without orchestration."}}')
    }
    exit 0
}
