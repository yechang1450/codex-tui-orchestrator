<#
.SYNOPSIS
Prepare Node/npm, the locked SDK and native Codex CLI without administrator rights.
.EXAMPLE
& .\scripts\bootstrap.ps1 -Action install
& .\scripts\bootstrap.ps1 -Action prepare -Json
& .\scripts\bootstrap.ps1 -Action run -Arguments @('--plan', 'Your task')
#>
[CmdletBinding()]
param(
    [ValidateSet('install','prepare','doctor','run')][string]$Action = 'install',
    [switch]$Json,
    [ValidateRange(1,1800)][int]$TimeoutSeconds = 900,
    [string]$NodePath,
    [switch]$NoDownload,
    [Parameter(ValueFromRemainingArguments=$true)][AllowEmptyCollection()][string[]]$Arguments = @()
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'runtime-bootstrap.ps1')

$runtimeHome = $null; $lock = $null; $npmCache = $null
$savedEnvironment = @{}
$exitCode = 0
$watch = [Diagnostics.Stopwatch]::StartNew()
function Get-RemainingBootstrapSeconds {
    $left = $TimeoutSeconds - [int][Math]::Floor($watch.Elapsed.TotalSeconds)
    if ($left -lt 1) { throw 'BOOTSTRAP_TIMEOUT: setup exhausted its time budget; rerun to reuse any completed runtime installation.' }
    return $left
}
try {
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED: use native Windows PowerShell.' }
    $pluginRoot = Split-Path -Parent $PSScriptRoot
    $runtimeHome = Get-OrchRuntimeHome -PluginRoot $pluginRoot
    $candidates = @(Get-OrchNodeCandidates -RuntimeHome $runtimeHome -NodePath $NodePath)
    $allowUnverifiedNode = [bool]$NodePath -and [string]$env:ORCH_ALLOW_UNVERIFIED_NODE -eq '1'
    $allowUnverifiedNpm = [bool]$NodePath -and [string]$env:ORCH_ALLOW_UNVERIFIED_NPM -eq '1'
    $runtime = Resolve-OrchNode -Candidates $candidates -RuntimeHome $runtimeHome -NoDownload:($NoDownload -or [bool]$NodePath) -AllowUnverified:$allowUnverifiedNode -AllowUnverifiedNpm:$allowUnverifiedNpm -TimeoutSeconds (Get-RemainingBootstrapSeconds)
    $lock = Enter-OrchRuntimeLock -RuntimeHome $runtimeHome -TimeoutSeconds (Get-RemainingBootstrapSeconds)
    foreach ($name in @('PATH','npm_execpath','npm_config_prefix','npm_config_cache','CODEX_CLI_PATH','ORCH_CLI','ORCH_NPM_TRUSTED','ORCH_NPM_TRUSTED_PATH','ORCH_NPM_TRUSTED_SHA256','ORCH_GIT_PATH')) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    $env:PATH = (Split-Path -Parent $runtime.NodePath) + ';' + $env:PATH
    $env:npm_execpath = $runtime.NpmPath
    $env:ORCH_NPM_TRUSTED = if ($runtime.NpmTrusted) { '1' } else { '0' }
    $env:ORCH_NPM_TRUSTED_PATH = [IO.Path]::GetFullPath($runtime.NpmPath)
    $env:ORCH_NPM_TRUSTED_SHA256 = (Get-FileHash -LiteralPath $env:ORCH_NPM_TRUSTED_PATH -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    $env:npm_config_prefix = Join-Path $runtimeHome 'cli'
    [void](Assert-OrchSafePath $env:npm_config_prefix)
    $npmCache = Join-Path $runtimeHome ('.npm-cache-' + [guid]::NewGuid().ToString('N'))
    $env:npm_config_cache = $npmCache
    $prepare = Invoke-OrchProcess -FilePath $runtime.NodePath -ArgumentList @((Join-Path $PSScriptRoot 'runtime-prepare.mjs')) -TimeoutSeconds (Get-RemainingBootstrapSeconds)
    if ($prepare.Stderr) { [Console]::Error.Write($prepare.Stderr) }
    if ($prepare.ExitCode -ne 0) { throw 'BOOTSTRAP_PREPARE_FAILED: prerequisite verification failed; see diagnostic above.' }
    $report = $prepare.Stdout | ConvertFrom-Json
    if (-not $report.ok -or $report.stage -ne 'ready' -or -not (Test-Path -LiteralPath $report.cliPath -PathType Leaf)) { throw 'BOOTSTRAP_PREPARE_INVALID: runtime did not produce a verified CLI report.' }
    $env:CODEX_CLI_PATH = $report.cliPath
    $env:ORCH_CLI = $report.cliPath
    # Release before a potentially long run. Preparation is serialized; task concurrency
    # continues to be controlled by the orchestrator's memory and dependency scheduler.
    $lock.Dispose(); $lock = $null
    if ($Action -eq 'prepare') {
        if ($Arguments.Count -gt 0) { throw 'BOOTSTRAP_ARGUMENTS: prepare takes no runner arguments.' }
        if ($Json) { [Console]::Out.WriteLine(($report | ConvertTo-Json -Compress)) }
        else { [Console]::Out.WriteLine("Runtime ready: Node $($report.nodeVersion), SDK $($report.sdkVersion), native Codex CLI verified.") }
    } else {
        if ($Action -eq 'install') {
            if ($Arguments -contains '--pull') {
                $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
                if (-not $git) { throw 'GIT_REQUIRED_FOR_PULL: --pull requires Git for Windows; install Git or omit --pull when using a downloaded release.' }
                if (-not (Test-OrchTrustedSignature -Path $git.Source -AllowedThumbprints @('3E9627155B7A6F29856321EE56D7FC25CF808407'))) { throw 'GIT_UNTRUSTED: --pull requires a verified Git for Windows executable; run git pull manually to use another Git build.' }
                $env:ORCH_GIT_PATH = [IO.Path]::GetFullPath($git.Source)
                $gitProbe = Invoke-OrchProcess -FilePath $env:ORCH_GIT_PATH -ArgumentList @('--version') -TimeoutSeconds 8
                if ($gitProbe.ExitCode -ne 0) { throw 'GIT_REQUIRED_FOR_PULL: Git failed its version probe.' }
            }
            $entry = Join-Path $PSScriptRoot 'install-plugin.mjs'
            $forward = @($Arguments)
            if ($Json -and -not ($forward -contains '--json')) { $forward += '--json' }
        } else {
            $entry = Join-Path $PSScriptRoot 'orchestrate-sdk.mjs'
            if ($Action -eq 'doctor') { $forward = @('--doctor') + $Arguments }
            else { $forward = @($Arguments) }
        }
        if ($Action -eq 'run') {
            $exitCode = Invoke-OrchAttachedProcess -FilePath $runtime.NodePath -ArgumentList (@($entry) + $forward)
        } else {
            $result = Invoke-OrchProcess -FilePath $runtime.NodePath -ArgumentList (@($entry) + $forward) -TimeoutSeconds (Get-RemainingBootstrapSeconds)
            [Console]::Out.Write($result.Stdout)
            [Console]::Error.Write($result.Stderr)
            $exitCode = $result.ExitCode
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $exitCode = 1
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    if ($lock) { $lock.Dispose() }
    if ($npmCache) {
        try { Remove-OrchOwnedDirectory -Path $npmCache -RuntimeHome $runtimeHome }
        catch { [Console]::Error.WriteLine('BOOTSTRAP_CLEANUP_FAILED: private npm cache needs inspection.'); $exitCode = 1 }
    }
}
exit $exitCode
