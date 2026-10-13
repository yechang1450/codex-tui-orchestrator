<#
.SYNOPSIS
Prepare Node/npm, the locked SDK and native Codex CLI without administrator rights.
.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Action install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Action prepare -Json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Action run --plan 'Your task'
#>
[CmdletBinding(PositionalBinding=$false)]
param(
    [ValidateSet('install','prepare','doctor','run','repair-deps')][string]$Action = 'install',
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
    # A prebuilt dist cannot be authenticated safely by this bootstrap before
    # it owns the export step. Reject the obsolete bypass before creating a
    # runtime, invoking npm, preparing the CLI, or honoring --pull.
    if (@($Arguments | Where-Object { $_ -eq '--skip-dist' -or $_ -like '--skip-dist=*' }).Count -gt 0) {
        throw 'SKIP_DIST_UNSUPPORTED: prebuilt distribution reuse is not supported; remove --skip-dist so installation can rebuild and verify the distribution.'
    }
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED: use native Windows PowerShell.' }
    $pluginRoot = Split-Path -Parent $PSScriptRoot
    $runtimeHome = Assert-OrchPrivateRuntimeHome (Get-OrchRuntimeHome -PluginRoot $pluginRoot)
    $candidates = @(Get-OrchNodeCandidates -RuntimeHome $runtimeHome -NodePath $NodePath)
    $allowUnverifiedNode = [bool]$NodePath -and [string]$env:ORCH_ALLOW_UNVERIFIED_NODE -eq '1'
    $allowUnverifiedNpm = [bool]$NodePath -and [string]$env:ORCH_ALLOW_UNVERIFIED_NPM -eq '1'
    $runtime = Resolve-OrchNode -Candidates $candidates -RuntimeHome $runtimeHome -NoDownload:($NoDownload -or [bool]$NodePath) -AllowUnverified:$allowUnverifiedNode -AllowUnverifiedNpm:$allowUnverifiedNpm -TimeoutSeconds (Get-RemainingBootstrapSeconds)
    $lock = Enter-OrchRuntimeLock -RuntimeHome $runtimeHome -TimeoutSeconds (Get-RemainingBootstrapSeconds)
    foreach ($name in @('PATH','npm_execpath','npm_config_prefix','npm_config_cache','CODEX_CLI_PATH','ORCH_CLI','ORCH_NPM_TRUSTED','ORCH_NPM_TRUSTED_PATH','ORCH_NPM_TRUSTED_SHA256','ORCH_DEP_REPAIR_BOOTSTRAP')) {
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
    # Every setup path gets fresh npm config files under the bootstrap-owned
    # runtime. This prevents user, project, proxy, token, and loader settings
    # from reaching dependency or CLI installation before verification.
    [void][IO.Directory]::CreateDirectory($npmCache)
    [void](Assert-OrchRuntimeIdentity -Path $npmCache -RuntimeHome $runtimeHome)
    $npmUserConfig = Assert-OrchRuntimeIdentity -Path (Join-Path $npmCache 'isolated-user.npmrc') -RuntimeHome $runtimeHome
    $npmGlobalConfig = Assert-OrchRuntimeIdentity -Path (Join-Path $npmCache 'isolated-global.npmrc') -RuntimeHome $runtimeHome
    foreach ($config in @($npmUserConfig,$npmGlobalConfig)) {
        [IO.File]::WriteAllText($config, '', [Text.UTF8Encoding]::new($false))
        [void](Assert-OrchRuntimeIdentity -Path $config -RuntimeHome $runtimeHome)
    }
    if ($Action -eq 'repair-deps') {
        if ($Arguments.Count -gt 0) { throw 'BOOTSTRAP_ARGUMENTS: repair-deps takes no runner arguments.' }
        # Narrow dependency repair: it has a verified Node/npm pair but does
        # not resolve, install, or otherwise touch the Codex CLI.  Its child
        # must not inherit user npmrc files, tokens, proxies, or Node loaders.
        $repairEnvironment = Get-OrchTrustedNpmRepairEnvironment -NodePath $runtime.NodePath -NpmPath $runtime.NpmPath -RuntimeHome $runtimeHome -NpmCache $npmCache -UserConfigPath $npmUserConfig -GlobalConfigPath $npmGlobalConfig -NpmTrusted ([bool]$runtime.NpmTrusted) -AllowUnverifiedNpm:$allowUnverifiedNpm
        $result = Invoke-OrchProcess -FilePath $runtime.NodePath -ArgumentList @((Join-Path $PSScriptRoot 'orchestrate-sdk.mjs'),'--install-deps') -TimeoutSeconds (Get-RemainingBootstrapSeconds) -Environment $repairEnvironment
        [Console]::Out.Write($result.Stdout)
        [Console]::Error.Write($result.Stderr)
        $exitCode = $result.ExitCode
    } else {
        $pluginData = Split-Path -Parent $runtimeHome
        $prepareEnvironment = Get-OrchTrustedNpmPreparationEnvironment -NodePath $runtime.NodePath -NpmPath $runtime.NpmPath -RuntimeHome $runtimeHome -NpmCache $npmCache -UserConfigPath $npmUserConfig -GlobalConfigPath $npmGlobalConfig -NpmTrusted ([bool]$runtime.NpmTrusted) -AllowUnverifiedNpm:$allowUnverifiedNpm -PluginData $pluginData -CodexHome ([string]$env:CODEX_HOME)
        $prepareWorkingDirectory = Join-Path ([string]$prepareEnvironment['SystemRoot']) 'System32'
        $prepare = Invoke-OrchProcess -FilePath $runtime.NodePath -ArgumentList @((Join-Path $PSScriptRoot 'runtime-prepare.mjs')) -TimeoutSeconds (Get-RemainingBootstrapSeconds) -Environment $prepareEnvironment -WorkingDirectory $prepareWorkingDirectory
        if ($prepare.Stderr) { [Console]::Error.Write($prepare.Stderr) }
        if ($prepare.ExitCode -ne 0) { throw 'BOOTSTRAP_PREPARE_FAILED: prerequisite verification failed; see diagnostic above.' }
        $report = $prepare.Stdout | ConvertFrom-Json
        if (-not $report.ok -or $report.stage -ne 'ready' -or -not (Test-Path -LiteralPath $report.cliPath -PathType Leaf)) { throw 'BOOTSTRAP_PREPARE_INVALID: runtime did not produce a verified CLI report.' }
        $env:CODEX_CLI_PATH = $report.cliPath
        $env:ORCH_CLI = $report.cliPath
        # Normal user work keeps its ordinary session settings, but it must
        # never inherit a caller-selected Windows executable root.
        $executionEnvironment = Get-OrchTrustedExecutionEnvironment
        # Release before a potentially long run. Preparation is serialized; task concurrency
        # continues to be controlled by the orchestrator's memory and dependency scheduler.
        $lock.Dispose(); $lock = $null
        if ($Action -eq 'prepare') {
        if ($Arguments.Count -gt 0) { throw 'BOOTSTRAP_ARGUMENTS: prepare takes no runner arguments.' }
        if ($Json) { [Console]::Out.WriteLine(($report | ConvertTo-Json -Compress)) }
        else { [Console]::Out.WriteLine("Runtime ready: Node $($report.nodeVersion), SDK $($report.sdkVersion), native Codex CLI verified.") }
        } else {
        if ($Action -eq 'install') {
            $entry = Join-Path $PSScriptRoot 'install-plugin.mjs'
            $forward = @($Arguments)
            if ($forward -contains '--pull') {
                Invoke-OrchTrustedCheckoutPull -Checkout $PSScriptRoot -TimeoutSeconds (Get-RemainingBootstrapSeconds)
                # Node intentionally rejects --pull: it cannot establish the
                # PowerShell bootstrap trust boundary or scrub GIT_* state.
                $forward = @($forward | Where-Object { $_ -ne '--pull' })
            }
            # The documented one-command flow installs the local checkout.  Make
            # that intent explicit so install-plugin keeps rejecting accidental
            # checkout installs invoked directly without this bootstrap boundary.
            $sourceIndex = [Array]::IndexOf([string[]]$forward, '--source')
            $source = if ($sourceIndex -ge 0 -and $sourceIndex + 1 -lt $forward.Count) { $forward[$sourceIndex + 1] } else { 'checkout' }
            if ($source -eq 'checkout' -and -not ($forward -contains '--local-development')) { $forward += '--local-development' }
            if ($Json -and -not ($forward -contains '--json')) { $forward += '--json' }
        } else {
            $entry = Join-Path $PSScriptRoot 'orchestrate-sdk.mjs'
            if ($Action -eq 'doctor') { $forward = @('--doctor') + $Arguments }
            else { $forward = @($Arguments) }
        }
        if ($Action -eq 'run') {
            $exitCode = Invoke-OrchAttachedProcess -FilePath $runtime.NodePath -ArgumentList (@($entry) + $forward) -Environment $executionEnvironment
        } else {
            $result = Invoke-OrchProcess -FilePath $runtime.NodePath -ArgumentList (@($entry) + $forward) -TimeoutSeconds (Get-RemainingBootstrapSeconds) -Environment $executionEnvironment
            [Console]::Out.Write($result.Stdout)
            [Console]::Error.Write($result.Stderr)
            $exitCode = $result.ExitCode
        }
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
