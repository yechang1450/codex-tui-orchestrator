# Windows PowerShell 5.1 compatible helpers; this file has no startup side effects.
Set-StrictMode -Version 2.0

# Windows PowerShell launched by Node may inherit PowerShell 7's module path.
# Load the system modules by absolute path so signature and hash checks do not
# silently fail when auto-loading finds an incompatible module first.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
    Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
}

function Get-OrchRuntimeHome {
    param([Parameter(Mandatory)][string]$PluginRoot, [AllowEmptyString()][string]$DataRoot = $env:PLUGIN_DATA)
    if ($DataRoot) { return [IO.Path]::GetFullPath((Join-Path $DataRoot 'runtime')) }
    return [IO.Path]::GetFullPath((Join-Path $PluginRoot 'temp\runtime'))
}

function Assert-OrchSafePath {
    param([Parameter(Mandatory)][string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    $cursor = $full
    while ($cursor) {
        try {
            if ([IO.File]::GetAttributes((ConvertTo-OrchExtendedPath -Path $cursor)) -band [IO.FileAttributes]::ReparsePoint) { throw 'RUNTIME_REPARSE_PATH: runtime paths must not contain junctions or symbolic links.' }
        } catch [IO.FileNotFoundException] { # Missing ancestors will be created after validation.
        } catch [IO.DirectoryNotFoundException] {
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Get-OrchTrustedSystemEnvironment {
    # Derive the Windows root from the operating system instead of inheriting
    # SystemRoot, WINDIR, or ComSpec from the launching process.  Those
    # variables are configuration, not an authority to select executables.
    $system32 = [Environment]::SystemDirectory
    if ([string]::IsNullOrWhiteSpace($system32)) { throw 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE: Windows system directory is unavailable.' }
    $system32 = Assert-OrchSafePath $system32
    if (-not (Test-Path -LiteralPath $system32 -PathType Container)) { throw 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE: Windows system directory is unavailable.' }
    $systemRoot = Assert-OrchSafePath (Split-Path -Parent $system32)
    $expectedSystem32 = [IO.Path]::GetFullPath((Join-Path $systemRoot 'System32'))
    if (-not [string]::Equals([IO.Path]::GetFullPath($system32), $expectedSystem32, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE: Windows system directory does not match its parent root.'
    }
    $commandProcessor = Assert-OrchSafePath (Join-Path $system32 'cmd.exe')
    if (-not (Test-Path -LiteralPath $commandProcessor -PathType Leaf)) { throw 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE: Windows command processor is unavailable.' }
    $commandItem = Get-Item -LiteralPath $commandProcessor -Force -ErrorAction Stop
    if (($commandItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $commandItem.PSIsContainer) {
        throw 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE: Windows command processor is not a regular file.'
    }
    return [ordered]@{ SystemRoot = $systemRoot; WINDIR = $systemRoot; ComSpec = $commandProcessor; System32 = $system32 }
}

function Get-OrchTrustedExecutionEnvironment {
    # Preserve the ordinary caller environment required by the user's Codex
    # session, while pinning the three variables that decide which Windows
    # executables a child can locate.
    $environment = [ordered]@{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $environment[[string]$entry.Key] = [string]$entry.Value
    }
    # Node loader variables execute or resolve caller-selected code before a
    # terminal child reaches the verified plugin entry point. Keep ordinary
    # session settings, but never forward those loader selectors.
    foreach ($name in @('SystemRoot','WINDIR','ComSpec','NODE_OPTIONS','NODE_PATH')) {
        foreach ($key in @($environment.Keys)) {
            if ([string]::Equals([string]$key, $name, [StringComparison]::OrdinalIgnoreCase)) { $environment.Remove($key) }
        }
    }
    $trusted = Get-OrchTrustedSystemEnvironment
    $environment['SystemRoot'] = $trusted.SystemRoot
    $environment['WINDIR'] = $trusted.WINDIR
    $environment['ComSpec'] = $trusted.ComSpec
    return $environment
}

function Assert-OrchPrivateRuntimeHome {
    param([Parameter(Mandatory)][string]$Path)
    # Runtime archives, Node, npm state, and the private CLI are executable
    # authority. Keep them on a local root that another Windows principal
    # cannot create, replace, or re-ACL.
    $full = Assert-OrchSafePath $Path
    if ($full.StartsWith('\\', [StringComparison]::Ordinal)) { throw 'RUNTIME_ROOT_UNSAFE_ACL: runtime storage must be a local owner-private directory.' }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value.ToUpperInvariant()
    $allowed = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
    $dangerous = [int64]2 -bor [int64]4 -bor [int64]16 -bor [int64]64 -bor [int64]256 -bor [int64]65536 -bor [int64]262144 -bor [int64]524288 -bor [int64]33554432 -bor [int64]268435456 -bor [int64]1073741824
    $replacement = [int64]64 -bor [int64]65536 -bor [int64]262144 -bor [int64]524288 -bor [int64]268435456 -bor [int64]1073741824
    $anchor = $full
    while (-not (Test-Path -LiteralPath $anchor)) {
        $parent = [IO.Path]::GetDirectoryName($anchor)
        if (-not $parent -or $parent -eq $anchor) { throw 'RUNTIME_ROOT_UNSAFE_ACL: runtime storage has no existing local ancestor.' }
        $anchor = $parent
    }
    $item = Get-Item -LiteralPath $anchor -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw 'RUNTIME_ROOT_UNSAFE_ACL: runtime storage ancestor is not a directory.' }
    $checkTarget = {
        param([string]$Directory)
        $acl = [IO.Directory]::GetAccessControl($Directory)
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.ToUpperInvariant()
        if ($allowed -notcontains $owner) { throw 'RUNTIME_ROOT_UNSAFE_ACL: runtime storage owner is not trusted.' }
        foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            $sid = $rule.IdentityReference.Value.ToUpperInvariant()
            $mask = ([int64][int]$rule.FileSystemRights) -band [int64]4294967295
            if ($rule.AccessControlType.ToString() -eq 'Allow' -and $allowed -notcontains $sid -and (($mask -band $dangerous) -ne 0)) {
                throw 'RUNTIME_ROOT_UNSAFE_ACL: runtime storage grants write-like access outside its trusted owner set.'
            }
        }
    }
    $checkAncestor = {
        param([string]$Directory)
        $acl = [IO.Directory]::GetAccessControl($Directory)
        foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            $sid = $rule.IdentityReference.Value.ToUpperInvariant()
            $inheritOnly = @([string]$rule.PropagationFlags -split ',' | ForEach-Object { $_.Trim() }) -contains 'InheritOnly'
            $mask = ([int64][int]$rule.FileSystemRights) -band [int64]4294967295
            if ($rule.AccessControlType.ToString() -eq 'Allow' -and -not $inheritOnly -and $allowed -notcontains $sid -and (($mask -band $replacement) -ne 0)) {
                throw 'RUNTIME_ROOT_UNSAFE_ACL: runtime storage has a replaceable ancestor.'
            }
        }
    }
    try {
        & $checkTarget $anchor
        $ancestor = [IO.Path]::GetDirectoryName($anchor)
        while ($ancestor -and $ancestor -ne $anchor) {
            & $checkAncestor $ancestor
            $parent = [IO.Path]::GetDirectoryName($ancestor)
            if (-not $parent -or $parent -eq $ancestor) { break }
            $ancestor = $parent
        }
    } catch {
        if ($_.Exception.Message -like 'RUNTIME_ROOT_UNSAFE_ACL:*') { throw }
        throw 'RUNTIME_ROOT_UNSAFE_ACL: runtime storage permissions could not be verified.'
    }
    return $full
}

function Assert-OrchRuntimeIdentity {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$RuntimeHome)
    $full = Assert-OrchSafePath $Path
    $homeFull = (Assert-OrchSafePath $RuntimeHome).TrimEnd('\') + '\'
    if (-not $full.StartsWith($homeFull, [StringComparison]::OrdinalIgnoreCase) -and
        $full.TrimEnd('\') -ne $RuntimeHome.TrimEnd('\')) { throw 'RUNTIME_PATH: path escaped the private runtime home.' }
    # Missing staging descendants are expected before extraction.  Test-Path
    # avoids PowerShell's ItemNotFoundErrorRecord, which is not reliably caught
    # as an IO exception on Windows PowerShell 5.1.
    if (-not (Test-Path -LiteralPath $full)) { return $full }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RUNTIME_REPARSE_PATH: runtime identity changed to a reparse point.' }
    return $item.FullName
}

function ConvertTo-OrchExtendedPath {
    param([Parameter(Mandatory)][string]$Path)
    if ($Path.StartsWith('\\?\', [StringComparison]::Ordinal)) { return $Path }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\', [StringComparison]::Ordinal)) { return '\\?\UNC\' + $full.Substring(2) }
    return '\\?\' + $full
}

function Get-OrchExistingPathAttributes {
    param([Parameter(Mandatory)][string]$Path)
    try { return [IO.File]::GetAttributes((ConvertTo-OrchExtendedPath -Path $Path)) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}

function Remove-OrchOwnedDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$RuntimeHome)
    $homeFull = (Assert-OrchSafePath $RuntimeHome).TrimEnd('\') + '\'
    $full = Assert-OrchSafePath $Path
    if (-not $full.StartsWith($homeFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'RUNTIME_CLEANUP_PATH: refusing cleanup outside runtime home.' }
    $rootAttributes = Get-OrchExistingPathAttributes -Path $full
    if ($null -eq $rootAttributes) { return }
    if (-not ($rootAttributes -band [IO.FileAttributes]::Directory)) { throw 'RUNTIME_CLEANUP_PATH: refusing cleanup of a non-directory runtime path.' }
    # PowerShell 5.1's provider cannot enumerate a deep npm extraction path.
    # Traverse the validated private tree with .NET extended paths instead,
    # checking every entry for reparses before any attributes are changed or
    # deletion is attempted.
    $entries = [Collections.Generic.List[object]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push((ConvertTo-OrchExtendedPath -Path $full))
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        $attributes = Get-OrchExistingPathAttributes -Path $current
        if ($null -eq $attributes) { throw 'RUNTIME_CLEANUP_RACE: runtime path changed during guarded cleanup.' }
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RUNTIME_REPARSE_PATH: refusing recursive cleanup through a reparse point.' }
        [void]$entries.Add([pscustomobject]@{ Path = $current; Attributes = $attributes })
        if ($attributes -band [IO.FileAttributes]::Directory) {
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) { $pending.Push($entry) }
        }
    }
    # Clear only the ReadOnly bit after all reparse checks, preserving
    # Remove-Item -Force cleanup behavior without broadening the path scope.
    foreach ($entry in $entries) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReadOnly) {
            $attributes = [IO.FileAttributes](([int]$entry.Attributes) -band (-bnot [int][IO.FileAttributes]::ReadOnly))
            [IO.File]::SetAttributes($entry.Path, $attributes)
        }
    }
    [IO.Directory]::Delete((ConvertTo-OrchExtendedPath -Path $full), $true)
}

# CommandLineToArgvW/CRT encoding, never shell evaluation. Required by .NET Framework
# on Windows PowerShell 5.1, whose ProcessStartInfo has no ArgumentList property.
function ConvertTo-OrchNativeArgument {
    param([AllowEmptyString()][string]$Value)
    $result = [Text.StringBuilder]::new()
    [void]$result.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void]$result.Append(('\' * (2 * $slashes + 1)))
            [void]$result.Append('"')
        } else {
            [void]$result.Append(('\' * $slashes))
            [void]$result.Append($character)
        }
        $slashes = 0
    }
    [void]$result.Append(('\' * (2 * $slashes)))
    [void]$result.Append('"')
    return $result.ToString()
}

function Invoke-OrchProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [AllowEmptyCollection()][string[]]$ArgumentList = @(),
        [ValidateRange(1,1800)][int]$TimeoutSeconds = 15,
        [System.Collections.IDictionary]$Environment = $null,
        [AllowNull()][string]$WorkingDirectory = $null
    )
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $info.WorkingDirectory = $WorkingDirectory
    }
    if ($null -ne $Environment) {
        $info.EnvironmentVariables.Clear()
        foreach ($entry in $Environment.GetEnumerator()) {
            $name = [string]$entry.Key
            if ([string]::IsNullOrWhiteSpace($name)) { throw 'PROCESS_ENVIRONMENT: environment variable name is empty.' }
            if ($null -ne $entry.Value) { $info.EnvironmentVariables[$name] = [string]$entry.Value }
        }
    }
    if ($info.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($arg in $ArgumentList) { $info.ArgumentList.Add($arg) }
    } else {
        $info.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-OrchNativeArgument $_ }) -join ' ')
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # Only the process just created here and its descendants are owned.
            if ($PSVersionTable.PSVersion.Major -ge 7) { $process.Kill($true) }
            else {
                $system32 = [Environment]::SystemDirectory
                $taskkill = if ($system32) { Join-Path $system32 'taskkill.exe' } else { $null }
                if ($taskkill -and (Test-Path -LiteralPath $taskkill -PathType Leaf)) { & $taskkill /PID $process.Id /T /F 2>$null | Out-Null }
                else { $process.Kill() }
            }
            [void]$process.WaitForExit(5000)
            throw 'PROCESS_TIMEOUT: runtime preparation exceeded its bounded timeout.'
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout.GetAwaiter().GetResult(); Stderr = $stderr.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function Get-OrchTrustedNpmEnvironment {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$NpmPath,
        [Parameter(Mandatory)][string]$RuntimeHome,
        [Parameter(Mandatory)][string]$NpmCache,
        [Parameter(Mandatory)][string]$UserConfigPath,
        [Parameter(Mandatory)][string]$GlobalConfigPath,
        [Parameter(Mandatory)][bool]$NpmTrusted,
        [switch]$AllowUnverifiedNpm,
        [switch]$DependencyRepair
    )
    # Setup processes have no need for caller credentials, npm configuration,
    # Node loaders, or proxy routing. Give them a deterministic baseline instead
    # of filtering an ambient process environment incompletely.
    $system32 = [Environment]::SystemDirectory
    if ([string]::IsNullOrWhiteSpace($system32)) { throw 'NPM_REPAIR_ENVIRONMENT: Windows system directory is unavailable.' }
    $system32 = Assert-OrchSafePath $system32
    $systemRoot = Split-Path -Parent $system32
    $commandProcessor = Assert-OrchSafePath (Join-Path $system32 'cmd.exe')
    if (-not (Test-Path -LiteralPath $commandProcessor -PathType Leaf)) { throw 'NPM_REPAIR_ENVIRONMENT: Windows command processor is unavailable.' }
    $node = Assert-OrchSafePath $NodePath
    $npm = Assert-OrchSafePath $NpmPath
    foreach ($file in @($node,$npm)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'NPM_REPAIR_ENVIRONMENT: verified runtime file is unavailable.' }
        $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer) { throw 'NPM_REPAIR_ENVIRONMENT: verified runtime file is not a regular file.' }
    }
    $cache = Assert-OrchRuntimeIdentity -Path $NpmCache -RuntimeHome $RuntimeHome
    $userConfig = Assert-OrchRuntimeIdentity -Path $UserConfigPath -RuntimeHome $RuntimeHome
    $globalConfig = Assert-OrchRuntimeIdentity -Path $GlobalConfigPath -RuntimeHome $RuntimeHome
    if ([string]::Equals([IO.Path]::GetFullPath($userConfig), [IO.Path]::GetFullPath($globalConfig), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'NPM_REPAIR_ENVIRONMENT: user and global npm config paths must be distinct.'
    }
    $prefix = Assert-OrchRuntimeIdentity -Path (Join-Path $RuntimeHome 'cli') -RuntimeHome $RuntimeHome
    $npmHash = (Get-FileHash -LiteralPath $npm -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    $environment = [ordered]@{
        SystemRoot = $systemRoot
        windir = $systemRoot
        ComSpec = $commandProcessor
        Path = ((Split-Path -Parent $node) + ';' + $system32)
        PATHEXT = '.COM;.EXE;.BAT;.CMD'
        TEMP = $cache
        TMP = $cache
        npm_execpath = $npm
        ORCH_NPM_TRUSTED = if ($NpmTrusted) { '1' } else { '0' }
        ORCH_NPM_TRUSTED_PATH = $npm
        ORCH_NPM_TRUSTED_SHA256 = $npmHash
        NPM_CONFIG_USERCONFIG = $userConfig
        NPM_CONFIG_GLOBALCONFIG = $globalConfig
        NPM_CONFIG_PREFIX = $prefix
        NPM_CONFIG_CACHE = $cache
        NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
        NPM_CONFIG_PROXY = 'false'
        NPM_CONFIG_REPLACE_REGISTRY_HOST = 'never'
        NPM_CONFIG_STRICT_SSL = 'true'
        NPM_CONFIG_IGNORE_SCRIPTS = 'true'
        NPM_CONFIG_AUDIT = 'false'
        NPM_CONFIG_FUND = 'false'
        NPM_CONFIG_UPDATE_NOTIFIER = 'false'
    }
    if ($DependencyRepair) {
        $environment['ORCH_DEP_REPAIR_BOOTSTRAP'] = '1'
        $environment['NPM_CONFIG_OMIT'] = 'optional'
    }
    # This is deliberately an explicit argument, never a copied ambient
    # setting. Bootstrap permits it only with a caller-supplied Node path.
    if ($AllowUnverifiedNpm) { $environment['ORCH_ALLOW_UNVERIFIED_NPM'] = '1' }
    return $environment
}

function Get-OrchTrustedNpmRepairEnvironment {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$NpmPath,
        [Parameter(Mandatory)][string]$RuntimeHome,
        [Parameter(Mandatory)][string]$NpmCache,
        [Parameter(Mandatory)][string]$UserConfigPath,
        [Parameter(Mandatory)][string]$GlobalConfigPath,
        [Parameter(Mandatory)][bool]$NpmTrusted,
        [switch]$AllowUnverifiedNpm
    )
    return Get-OrchTrustedNpmEnvironment -NodePath $NodePath -NpmPath $NpmPath -RuntimeHome $RuntimeHome -NpmCache $NpmCache -UserConfigPath $UserConfigPath -GlobalConfigPath $GlobalConfigPath -NpmTrusted $NpmTrusted -AllowUnverifiedNpm:$AllowUnverifiedNpm -DependencyRepair
}

function Get-OrchOfficialDesktopLocalAppData {
    # GetFolderPath consults USERPROFILE. Setup deliberately strips that
    # caller-controlled value, so read Explorer's expanded per-user location
    # directly and refuse the desktop fallback if it is unavailable.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders', $false)
    if ($null -eq $key) { return $null }
    try {
        $value = $key.GetValue('Local AppData', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        $key.Dispose()
    }
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value) -or $value.Contains('%')) { return $null }
    try {
        $fullPath = [IO.Path]::GetFullPath($value)
        if (-not [IO.Path]::IsPathRooted($fullPath)) { return $null }
        return $fullPath
    } catch {
        return $null
    }
}

function Get-OrchTrustedNpmPreparationEnvironment {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$NpmPath,
        [Parameter(Mandatory)][string]$RuntimeHome,
        [Parameter(Mandatory)][string]$NpmCache,
        [Parameter(Mandatory)][string]$UserConfigPath,
        [Parameter(Mandatory)][string]$GlobalConfigPath,
        [Parameter(Mandatory)][bool]$NpmTrusted,
        [switch]$AllowUnverifiedNpm,
        [AllowEmptyString()][string]$PluginData = '',
        [AllowEmptyString()][string]$CodexHome = ''
    )
    $environment = Get-OrchTrustedNpmEnvironment -NodePath $NodePath -NpmPath $NpmPath -RuntimeHome $RuntimeHome -NpmCache $NpmCache -UserConfigPath $UserConfigPath -GlobalConfigPath $GlobalConfigPath -NpmTrusted $NpmTrusted -AllowUnverifiedNpm:$AllowUnverifiedNpm
    if (-not [string]::IsNullOrWhiteSpace($PluginData)) { $environment['PLUGIN_DATA'] = $PluginData }
    if (-not [string]::IsNullOrWhiteSpace($CodexHome)) { $environment['CODEX_HOME'] = $CodexHome }
    # The host verifier needs this one OS-derived location to validate a
    # rotated desktop CLI below the official Codex install root.
    $localAppData = Get-OrchOfficialDesktopLocalAppData
    if (-not [string]::IsNullOrWhiteSpace($localAppData)) { $environment['LOCALAPPDATA'] = $localAppData }
    # These are documented setup controls. Everything else stays out of the
    # child so npm and Node cannot consume ambient config, loaders, proxies, or
    # credentials before integrity checks complete.
    foreach ($name in @('ORCH_AUTO_INSTALL_DEPS','ORCH_AUTO_INSTALL_CLI','ORCH_CLI','CODEX_EXE','ORCH_ALLOW_UNVERIFIED_CLI','ORCH_CLI_INSTALL_SPEC','ORCH_CLI_INSTALL_TIMEOUT_MS')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($value)) { $environment[$name] = $value }
    }
    return $environment
}

function Get-OrchNodeProbeStartInfo {
    param([Parameter(Mandatory)][string]$NodePath)
    # Node/npm version probes are verification operations. They do not need the
    # caller's loaders, package-manager credentials, proxy routing, or working
    # directory, so use a fresh minimal process environment.
    $system32 = [Environment]::SystemDirectory
    if ([string]::IsNullOrWhiteSpace($system32)) { throw 'NODE_PROBE_ENVIRONMENT: Windows system directory is unavailable.' }
    $system32 = Assert-OrchSafePath $system32
    if (-not (Test-Path -LiteralPath $system32 -PathType Container)) { throw 'NODE_PROBE_ENVIRONMENT: Windows system directory is unavailable.' }
    $systemRoot = Split-Path -Parent $system32
    $commandProcessor = Assert-OrchSafePath (Join-Path $system32 'cmd.exe')
    if (-not (Test-Path -LiteralPath $commandProcessor -PathType Leaf)) { throw 'NODE_PROBE_ENVIRONMENT: Windows command processor is unavailable.' }
    $node = Assert-OrchSafePath $NodePath
    if (-not [IO.File]::Exists((ConvertTo-OrchExtendedPath -Path $node))) { throw 'NODE_PROBE_ENVIRONMENT: Node runtime is unavailable.' }
    $nodeAttributes = [IO.File]::GetAttributes((ConvertTo-OrchExtendedPath -Path $node))
    if (($nodeAttributes -band [IO.FileAttributes]::ReparsePoint) -or ($nodeAttributes -band [IO.FileAttributes]::Directory)) { throw 'NODE_PROBE_ENVIRONMENT: Node runtime is not a regular file.' }
    # npm accepts nonexistent user/global config files as empty files. Keep
    # them distinct: current npm rejects loading one path in both roles. Fresh
    # names under System32 prevent user or project .npmrc files from
    # contributing settings without leaving probe state on disk.
    $userConfig = Assert-OrchSafePath (Join-Path $system32 ('.codex-tui-orchestrator-probe-user-' + [guid]::NewGuid().ToString('N') + '.npmrc'))
    $globalConfig = Assert-OrchSafePath (Join-Path $system32 ('.codex-tui-orchestrator-probe-global-' + [guid]::NewGuid().ToString('N') + '.npmrc'))
    return [pscustomobject]@{
        Environment = [ordered]@{
            SystemRoot = $systemRoot
            windir = $systemRoot
            ComSpec = $commandProcessor
            Path = ((Split-Path -Parent $node) + ';' + $system32)
            PATHEXT = '.COM;.EXE;.BAT;.CMD'
            NPM_CONFIG_USERCONFIG = $userConfig
            NPM_CONFIG_GLOBALCONFIG = $globalConfig
            NPM_CONFIG_IGNORE_SCRIPTS = 'true'
            NPM_CONFIG_OFFLINE = 'true'
            NPM_CONFIG_AUDIT = 'false'
            NPM_CONFIG_FUND = 'false'
            NPM_CONFIG_UPDATE_NOTIFIER = 'false'
            NPM_CONFIG_STRICT_SSL = 'true'
            NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
            NPM_CONFIG_PROXY = 'false'
        }
        WorkingDirectory = $system32
    }
}

function Invoke-OrchAttachedProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [AllowEmptyCollection()][string[]]$ArgumentList = @(),
        [System.Collections.IDictionary]$Environment = $null
    )
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    if ($null -ne $Environment) {
        $info.EnvironmentVariables.Clear()
        foreach ($entry in $Environment.GetEnumerator()) {
            $name = [string]$entry.Key
            if ([string]::IsNullOrWhiteSpace($name)) { throw 'PROCESS_ENVIRONMENT: environment variable name is empty.' }
            if ($null -ne $entry.Value) { $info.EnvironmentVariables[$name] = [string]$entry.Value }
        }
    }
    if ($info.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($arg in $ArgumentList) { $info.ArgumentList.Add($arg) }
    } else { $info.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-OrchNativeArgument $_ }) -join ' ') }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
        $stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
        # Execution duration and cancellation belong to the orchestrator; do not
        # turn a setup timeout into a task timeout, or buffer live task status.
        $process.WaitForExit()
        $stdout.GetAwaiter().GetResult()
        $stderr.GetAwaiter().GetResult()
        return $process.ExitCode
    } finally { $process.Dispose() }
}

function Test-OrchTrustedSignature {
    param([Parameter(Mandatory)][string]$Path,
          [string[]]$AllowedThumbprints = @('DB9831002B26D78F14E07806F595C6A429E9B6E9', '8EA1D142EA3F46023BACA38C23A7E7AE6AFCE30C', '5A2C440219B027EF812E24A1E15F671D7CD379DE'))
    if (-not [IO.File]::Exists((ConvertTo-OrchExtendedPath -Path $Path))) { return $false }
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        if ([string]$signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { return $false }
        $thumbprint = ([string]$signature.SignerCertificate.Thumbprint).Replace(' ', '').ToUpperInvariant()
        foreach ($allowed in $AllowedThumbprints) {
            if ($thumbprint -eq $allowed.ToUpperInvariant()) { return $true }
        }
    } catch { return $false }
    return $false
}

# --pull may execute an external Git binary. Keep the Git for Windows
# certificate rotation policy in one release-sealed JSON file and require the
# registry-owned cmd\git.exe before the trusted bootstrap runs it.
function Get-OrchGitForWindowsTrustPolicy {
    param([Parameter(Mandatory)][string]$PolicyPath)
    $full = Assert-OrchSafePath $PolicyPath
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'GIT_TRUST_POLICY_INVALID: policy file is missing.' }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'GIT_TRUST_POLICY_INVALID: policy file must not be a reparse point.' }
    try { $policy = (Get-Content -LiteralPath $full -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'GIT_TRUST_POLICY_INVALID: policy file is invalid JSON.' }
    if ($null -eq $policy -or $policy.schema -ne 1) { throw 'GIT_TRUST_POLICY_INVALID: unsupported policy schema.' }
    if ($policy.registryPath -ne 'HKLM:\SOFTWARE\GitForWindows' -or $policy.registryValue -ne 'InstallPath' -or $policy.executableRelativePath -ne 'cmd\git.exe') {
        throw 'GIT_TRUST_POLICY_INVALID: registry or executable location differs from Git for Windows policy.'
    }
    $entries = @($policy.signers)
    if ($entries.Count -ne 2) { throw 'GIT_TRUST_POLICY_INVALID: exactly two pinned signers are required.' }
    $normalized = [Collections.Generic.List[object]]::new()
    foreach ($entry in $entries) {
        if ($null -eq $entry) { throw 'GIT_TRUST_POLICY_INVALID: signer entry is missing.' }
        $thumbprint = ([string]$entry.thumbprint).Replace(' ', '').ToUpperInvariant()
        if ($thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'GIT_TRUST_POLICY_INVALID: signer thumbprint must be a 40-character SHA-1 hex value.' }
        $subject = if ($entry.PSObject.Properties['subject']) { [string]$entry.subject } else { $null }
        $issuer = if ($entry.PSObject.Properties['issuer']) { [string]$entry.issuer } else { $null }
        if (($null -ne $subject -and -not $subject) -or ($null -ne $issuer -and -not $issuer)) { throw 'GIT_TRUST_POLICY_INVALID: signer identity must be non-empty when provided.' }
        $normalized.Add([pscustomobject]@{ Thumbprint = $thumbprint; Subject = $subject; Issuer = $issuer })
    }
    $legacy = @($normalized | Where-Object { $_.Thumbprint -eq '3E9627155B7A6F29856321EE56D7FC25CF808407' })
    $rotated = @($normalized | Where-Object { $_.Thumbprint -eq '2A1E97CBF0DFCDA15B0DA0AC9745014F989D4AD0' })
    if ($legacy.Count -ne 1 -or $rotated.Count -ne 1) { throw 'GIT_TRUST_POLICY_INVALID: policy must pin the exact legacy and rotated Git for Windows leaves.' }
    if ($null -ne $legacy[0].Subject -or $null -ne $legacy[0].Issuer) { throw 'GIT_TRUST_POLICY_INVALID: legacy Git for Windows leaf must not broaden its publisher policy.' }
    if ($rotated[0].Subject -ne 'CN=Johannes Schindelin, O=Johannes Schindelin, L=Bruehl, C=DE' -or $rotated[0].Issuer -ne 'CN=Microsoft ID Verified CS EOC CA 04, O=Microsoft Corporation, C=US') {
        throw 'GIT_TRUST_POLICY_INVALID: rotated Git for Windows leaf requires its observed subject and issuer.'
    }
    return [pscustomobject]@{
        Path = $full
        RegistryPath = $policy.registryPath
        RegistryValue = $policy.registryValue
        ExecutableRelativePath = $policy.executableRelativePath
        Signers = @($normalized)
    }
}

function Get-OrchGitForWindowsInstallPath {
    param([Parameter(Mandatory)][object]$Policy)
    try { $registry = Get-ItemProperty -LiteralPath $Policy.RegistryPath -Name $Policy.RegistryValue -ErrorAction Stop }
    catch { throw 'GIT_UNTRUSTED: Git for Windows InstallPath is unavailable from the machine registry.' }
    $property = $registry.PSObject.Properties[$Policy.RegistryValue]
    if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) { throw 'GIT_UNTRUSTED: Git for Windows InstallPath is empty.' }
    $value = [string]$property.Value
    if (-not [IO.Path]::IsPathRooted($value)) { throw 'GIT_UNTRUSTED: Git for Windows InstallPath must be absolute.' }
    return Assert-OrchSafePath $value
}

function Resolve-OrchTrustedGitForPull {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$PolicyPath = (Join-Path $PSScriptRoot 'git-for-windows-trust.json')
    )
    $policy = Get-OrchGitForWindowsTrustPolicy -PolicyPath $PolicyPath
    $installRoot = Get-OrchGitForWindowsInstallPath -Policy $policy
    $expected = Assert-OrchSafePath (Join-Path $installRoot $policy.ExecutableRelativePath)
    $candidate = Assert-OrchSafePath $Path
    if (-not [string]::Equals([IO.Path]::GetFullPath($candidate), [IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'GIT_UNTRUSTED: Git executable is not the registered Git for Windows cmd\git.exe.'
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'GIT_UNTRUSTED: registered Git for Windows executable is missing or is not a regular file.' }
    $candidateItem = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    if (($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $candidateItem.PSIsContainer) { throw 'GIT_UNTRUSTED: registered Git for Windows executable is not a regular file.' }
    try { $signature = Get-AuthenticodeSignature -LiteralPath $candidate -ErrorAction Stop }
    catch { throw 'GIT_UNTRUSTED: Git for Windows Authenticode signature is not valid.' }
    if ([string]$signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'GIT_UNTRUSTED: Git for Windows Authenticode signature is not valid.' }
    $thumbprint = ([string]$signature.SignerCertificate.Thumbprint).Replace(' ', '').ToUpperInvariant()
    $signer = @($policy.Signers | Where-Object { $_.Thumbprint -eq $thumbprint })
    if ($signer.Count -ne 1) { throw 'GIT_UNTRUSTED: Git for Windows signer leaf is not allowed.' }
    if ($null -ne $signer[0].Subject -and [string]$signature.SignerCertificate.Subject -ne $signer[0].Subject) { throw 'GIT_UNTRUSTED: Git for Windows signer subject does not match the pinned policy.' }
    if ($null -ne $signer[0].Issuer -and [string]$signature.SignerCertificate.Issuer -ne $signer[0].Issuer) { throw 'GIT_UNTRUSTED: Git for Windows signer issuer does not match the pinned policy.' }
    return [IO.Path]::GetFullPath($candidate)
}

function Get-OrchTrustedGitEnvironment {
    param(
        [Parameter(Mandatory)][string]$GitPath,
        [switch]$ReadSystemConfig,
        [switch]$ReadGlobalConfig
    )
    if ($ReadSystemConfig -and $ReadGlobalConfig) { throw 'GIT_UNTRUSTED: trusted Git child cannot read both global and system config.' }
    # A privileged checkout update must not inherit user-process routing,
    # startup, proxy, or configuration variables.  Derive the executable
    # search path from the verified Git binary and Windows system directory,
    # then provide Git only the small deterministic baseline it needs to run.
    $system32 = [Environment]::SystemDirectory
    if ([string]::IsNullOrWhiteSpace($system32)) { throw 'GIT_UNTRUSTED: Windows system directory is unavailable from the operating system.' }
    $system32 = [IO.Path]::GetFullPath($system32)
    $systemRoot = Split-Path -Parent $system32
    $commandProcessor = Join-Path $system32 'cmd.exe'
    if (-not (Test-Path -LiteralPath $commandProcessor -PathType Leaf)) { throw 'GIT_UNTRUSTED: Windows command processor is unavailable from the machine SystemRoot.' }
    $gitCommandDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $GitPath))
    $gitInstallRoot = Split-Path -Parent $gitCommandDirectory
    $pathEntries = [Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
        $system32,
        $gitCommandDirectory,
        (Join-Path $gitInstallRoot 'mingw64\bin'),
        (Join-Path $gitInstallRoot 'usr\bin'),
        (Join-Path $gitInstallRoot 'mingw64\libexec\git-core')
    )) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
        $full = [IO.Path]::GetFullPath($candidate)
        if (-not (@($pathEntries | Where-Object { [string]::Equals($_, $full, [StringComparison]::OrdinalIgnoreCase) }).Count)) { [void]$pathEntries.Add($full) }
    }
    if ($pathEntries.Count -eq 0) { throw 'GIT_UNTRUSTED: no trusted executable search path is available.' }
    # Both the Windows OpenSSH client and Git for Windows consult a home
    # directory for ordinary ~/.ssh configuration and keys. Derive it through
    # the Windows known-folder API rather than forwarding HOME or USERPROFILE
    # from the caller process.
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($userProfile) -or -not [IO.Path]::IsPathRooted($userProfile)) { throw 'GIT_UNTRUSTED: Windows user profile directory is unavailable from the operating system.' }
    $userProfile = [IO.Path]::GetFullPath($userProfile)
    if (-not (Test-Path -LiteralPath $userProfile -PathType Container)) { throw 'GIT_UNTRUSTED: Windows user profile directory is unavailable from the operating system.' }
    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrWhiteSpace($localAppData)) { throw 'GIT_UNTRUSTED: local application-data path is unavailable for the current Windows user.' }
    $temp = Join-Path $localAppData 'Temp'
    [void][IO.Directory]::CreateDirectory($temp)
    $environment = [ordered]@{
        SystemRoot = $systemRoot
        windir = $systemRoot
        ComSpec = $commandProcessor
        Path = ($pathEntries -join ';')
        PATHEXT = '.COM;.EXE;.BAT;.CMD'
        TEMP = $temp
        TMP = $temp
        HOME = $userProfile
        USERPROFILE = $userProfile
        # These fixed Git settings are not inherited caller input. They deny
        # interactive credential prompts during a bootstrap-owned update.
        GIT_TERMINAL_PROMPT = '0'
        # Restrict fetch and pull to Git's built-in HTTPS and SSH transports.
        # This wins over protocol.*.allow settings in checkout-local config.
        GIT_ALLOW_PROTOCOL = 'https:ssh'
    }
    # The two read-only scalar queries below obtain only core.autocrlf so a
    # clean checkout retains its line-ending normalization. Every status/pull
    # child still omits global and system configuration completely.
    if (-not $ReadGlobalConfig) { $environment['GIT_CONFIG_GLOBAL'] = 'NUL' }
    if (-not $ReadSystemConfig) { $environment['GIT_CONFIG_NOSYSTEM'] = '1' }
    return $environment
}

# Git inherits an unusually powerful set of process variables.  Do not let a
# caller alter repository discovery, configuration injection, SSH, or askpass
# while bootstrap performs its one privileged checkout update.
function Invoke-OrchSanitizedGit {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [AllowEmptyCollection()][string[]]$ArgumentList = @(),
        [ValidateRange(1,1800)][int]$TimeoutSeconds = 15,
        [switch]$ReadSystemConfig,
        [switch]$ReadGlobalConfig
    )
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $info.EnvironmentVariables.Clear()
    foreach ($entry in (Get-OrchTrustedGitEnvironment -GitPath $FilePath -ReadSystemConfig:$ReadSystemConfig -ReadGlobalConfig:$ReadGlobalConfig).GetEnumerator()) {
        $info.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
    }
    if ($info.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($arg in $ArgumentList) { $info.ArgumentList.Add($arg) }
    } else {
        $info.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-OrchNativeArgument $_ }) -join ' ')
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # This process is created by this function and is therefore the
            # only process tree bootstrap may terminate.
            if ($PSVersionTable.PSVersion.Major -ge 7) { $process.Kill($true) }
            else { & (Join-Path $info.EnvironmentVariables['SystemRoot'] 'System32\taskkill.exe') /PID $process.Id /T /F 2>$null | Out-Null }
            [void]$process.WaitForExit(5000)
            throw 'PROCESS_TIMEOUT: trusted Git pull exceeded its bounded timeout.'
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout.GetAwaiter().GetResult(); Stderr = $stderr.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function Get-OrchTrustedGitAutocrlf {
    param(
        [Parameter(Mandatory)][string]$GitPath,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$RepositoryArguments,
        [ValidateSet('global','system')][string]$Scope,
        [ValidateRange(1,1800)][int]$TimeoutSeconds = 15
    )
    # Do not admit global or system configuration into status/pull. This is a
    # separate, no-includes read of one non-executable scalar that Git uses to
    # decide whether CRLF worktree bytes match LF index bytes.
    $readSystem = $Scope -eq 'system'
    $readGlobal = $Scope -eq 'global'
    $result = Invoke-OrchSanitizedGit -FilePath $GitPath -ArgumentList ($RepositoryArguments + @('config',('--' + $Scope),'--no-includes','--get','core.autocrlf')) -TimeoutSeconds $TimeoutSeconds -ReadSystemConfig:$readSystem -ReadGlobalConfig:$readGlobal
    if ($result.ExitCode -eq 1) { return $null }
    if ($result.ExitCode -ne 0) {
        $detail = (($result.Stderr, $result.Stdout | Where-Object { $_ } | Select-Object -First 1) -join '').Trim()
        throw ('GIT_REQUIRED_FOR_PULL: Git ' + $Scope + ' autocrlf inspection failed: ' + $detail.Substring(0, [Math]::Min(400, $detail.Length)))
    }
    $values = @($result.Stdout -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($values.Count -ne 1) { throw ('GIT_REQUIRED_FOR_PULL: Git ' + $Scope + ' autocrlf inspection returned an invalid value.') }
    $value = ([string]$values[0]).Trim().ToLowerInvariant()
    if (@('true','yes','on','1') -contains $value) { return 'true' }
    if (@('false','no','off','0') -contains $value) { return 'false' }
    if ($value -eq 'input') { return 'input' }
    throw ('GIT_REQUIRED_FOR_PULL: Git ' + $Scope + ' autocrlf inspection returned an invalid value.')
}

function Get-OrchUnsafeCheckoutGitConfigReason {
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowEmptyString()][string]$Value = ''
    )
    $key = $Name.Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($key)) { return 'contains a malformed configuration key' }
    if ($key -match '^include(?:if)?\.') { return 'loads another configuration file' }
    if ($key -match '^core\.(hookspath|fsmonitor|sshcommand|askpass|gitproxy|alternaterefscommand)$') { return 'selects an executable helper' }
    if ($key -match '^filter\..+\.(clean|smudge|process)$') { return 'selects a filter command' }
    if ($key -match '^merge\..+\.driver$') { return 'selects a merge command' }
    if ($key -match '^credential(?:\..*)?\.helper$') { return 'selects a credential helper' }
    if ($key -match '^remote\..+\.(proxy|proxyauthmethod|vcs|uploadpack)$') { return 'changes the remote transport or helper' }
    if ($key -match '^url\..+\.insteadof$') { return 'rewrites the remote URL' }
    if ($key -eq 'protocol.ext.allow' -and $Value.Trim().ToLowerInvariant() -ne 'never') { return 'enables the ext transport' }
    if ($key -match '^http(?:\..*)?\.sslverify$') {
        $normalized = $Value.Trim().ToLowerInvariant()
        if (@('true','yes','on','1') -notcontains $normalized) { return 'weakens HTTP TLS verification' }
        return $null
    }
    if ($key -match '^http(?:\..*)?\.schannelcheckrevoke$') {
        $normalized = $Value.Trim().ToLowerInvariant()
        if (@('true','yes','on','1','best-effort') -notcontains $normalized) { return 'weakens HTTP TLS revocation checks' }
        return $null
    }
    if ($key -match '^http(?:\..*)?\.(proxy.*|ssl.*|schannel.*|extraheader|cookiefile|savecookies|emptyauth|proactiveauth|allowntlmauth|delegation)$') {
        return 'changes HTTP routing, credentials, or TLS handling'
    }
    return $null
}

function Assert-OrchTrustedCheckoutGitConfig {
    param(
        [Parameter(Mandatory)][string]$GitPath,
        [Parameter(Mandatory)][string[]]$RepositoryArguments,
        [ValidateRange(1,1800)][int]$TimeoutSeconds = 15
    )
    # `--no-includes` ensures this inspection never reads another caller-chosen
    # file. `--show-scope` includes both .git/config and config.worktree. Do
    # not pass the later command-scope overrides here: this output must expose
    # only checkout-owned settings for validation.
    $inspection = Invoke-OrchSanitizedGit -FilePath $GitPath -ArgumentList ($RepositoryArguments + @('config','--no-includes','--show-scope','--null','--list')) -TimeoutSeconds $TimeoutSeconds
    if ($inspection.ExitCode -ne 0) {
        $detail = (($inspection.Stderr, $inspection.Stdout | Where-Object { $_ } | Select-Object -First 1) -join '').Trim()
        throw ('GIT_REQUIRED_FOR_PULL: Git configuration inspection failed: ' + $detail.Substring(0, [Math]::Min(400, $detail.Length)))
    }
    $records = @($inspection.Stdout -split [char]0)
    if ((($records.Count % 2) -ne 1) -or -not [string]::IsNullOrEmpty([string]$records[$records.Count - 1])) {
        throw 'GIT_PULL_CONFIG_UNSAFE: checkout configuration inspection returned malformed records.'
    }
    $hasAutocrlf = $false
    for ($index = 0; $index -lt ($records.Count - 1); $index += 2) {
        $scope = [string]$records[$index]
        $entry = [string]$records[$index + 1]
        if ([string]::IsNullOrWhiteSpace($scope)) { throw 'GIT_PULL_CONFIG_UNSAFE: checkout configuration inspection returned a malformed scope.' }
        if ($scope -notin @('local','worktree')) { continue }
        $newline = $entry.IndexOf("`n")
        if ($newline -lt 1) { throw 'GIT_PULL_CONFIG_UNSAFE: checkout configuration contains a malformed entry.' }
        $name = $entry.Substring(0, $newline)
        $value = $entry.Substring($newline + 1)
        if ([string]::Equals($name, 'core.autocrlf', [StringComparison]::OrdinalIgnoreCase)) { $hasAutocrlf = $true }
        $reason = Get-OrchUnsafeCheckoutGitConfigReason -Name $name -Value $value
        if ($null -ne $reason) { throw ('GIT_PULL_CONFIG_UNSAFE: checkout configuration ' + $reason + '.') }
    }
    return [pscustomobject]@{ HasAutocrlf = $hasAutocrlf }
}

function Invoke-OrchTrustedCheckoutPull {
    param(
        [Parameter(Mandatory)][string]$Checkout,
        [ValidateRange(1,1800)][int]$TimeoutSeconds = 15
    )
    $policyPath = Join-Path $PSScriptRoot 'git-for-windows-trust.json'
    $policy = Get-OrchGitForWindowsTrustPolicy -PolicyPath $policyPath
    $installRoot = Get-OrchGitForWindowsInstallPath -Policy $policy
    $expectedGit = Join-Path $installRoot $policy.ExecutableRelativePath
    $git = Resolve-OrchTrustedGitForPull -Path $expectedGit -PolicyPath $policyPath
    $checkoutPath = Assert-OrchSafePath $Checkout
    # Worktree selection happens before config is applied, so it must be a
    # command option rather than a core.worktree override. The remaining
    # command-scope values keep normal HTTPS/SSH pulls deterministic after the
    # checkout-local configuration preflight below.
    $repositoryArguments = @(
        ('--work-tree=' + $checkoutPath),
        '--no-pager',
        '-C',$checkoutPath
    )
    $common = @($repositoryArguments + @(
        '-c','core.hooksPath=NUL',
        '-c','submodule.recurse=false',
        '-c','core.fsmonitor=false',
        '-c','credential.helper=',
        '-c','core.sshCommand=ssh',
        '-c','ssh.variant=ssh',
        '-c','core.askPass=',
        '-c','http.proxy=',
        '-c','http.sslVerify=true'
    ))
    $checkoutConfig = Assert-OrchTrustedCheckoutGitConfig -GitPath $git -RepositoryArguments $repositoryArguments -TimeoutSeconds $TimeoutSeconds
    if ($null -ne $checkoutConfig -and -not $checkoutConfig.HasAutocrlf) {
        $autocrlf = Get-OrchTrustedGitAutocrlf -GitPath $git -RepositoryArguments $repositoryArguments -Scope global -TimeoutSeconds $TimeoutSeconds
        if ($null -eq $autocrlf) { $autocrlf = Get-OrchTrustedGitAutocrlf -GitPath $git -RepositoryArguments $repositoryArguments -Scope system -TimeoutSeconds $TimeoutSeconds }
        if ($null -ne $autocrlf) { $common += @('-c', ('core.autocrlf=' + $autocrlf)) }
    }
    $status = Invoke-OrchSanitizedGit -FilePath $git -ArgumentList ($common + @('status','--porcelain=v1','--untracked-files=all','--ignore-submodules=all')) -TimeoutSeconds $TimeoutSeconds
    if ($status.ExitCode -ne 0) { throw ('GIT_REQUIRED_FOR_PULL: Git status failed: ' + (($status.Stderr, $status.Stdout | Where-Object { $_ } | Select-Object -First 1) -join '').Trim().Substring(0, [Math]::Min(400, (($status.Stderr, $status.Stdout | Where-Object { $_ } | Select-Object -First 1) -join '').Trim().Length))) }
    if ($status.Stdout.Trim()) { throw 'refusing to pull: the working tree has local changes' }
    $finalGit = Resolve-OrchTrustedGitForPull -Path $git -PolicyPath $policyPath
    if (-not [string]::Equals($git, $finalGit, [StringComparison]::OrdinalIgnoreCase)) { throw 'GIT_UNTRUSTED: Git path changed after the initial check.' }
    $pull = Invoke-OrchSanitizedGit -FilePath $finalGit -ArgumentList ($common + @('pull','--ff-only','--no-rebase','--no-squash','--no-autostash','--no-verify','--no-recurse-submodules','--upload-pack=git-upload-pack')) -TimeoutSeconds $TimeoutSeconds
    if ($pull.ExitCode -ne 0) { throw ('GIT_PULL_FAILED: ' + (($pull.Stderr, $pull.Stdout | Where-Object { $_ } | Select-Object -First 1) -join '').Trim().Substring(0, [Math]::Min(400, (($pull.Stderr, $pull.Stdout | Where-Object { $_ } | Select-Object -First 1) -join '').Trim().Length))) }
}

function Get-OrchTreeDigest {
    param([Parameter(Mandatory)][string]$Root)
    try {
        $rootFull = (Assert-OrchSafePath $Root).TrimEnd('\')
        $rootExtended = ConvertTo-OrchExtendedPath -Path $rootFull
        if (-not [IO.Directory]::Exists($rootExtended)) { return $null }
        $rows = [Collections.Generic.List[string]]::new()
        $stack = [Collections.Generic.Stack[string]]::new()
        $stack.Push($rootExtended)
        $totalBytes = [long]0
        while ($stack.Count -gt 0) {
            $directory = $stack.Pop()
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
                $attributes = [IO.File]::GetAttributes($entry)
                if ($attributes -band [IO.FileAttributes]::ReparsePoint) { return $null }
                if ($attributes -band [IO.FileAttributes]::Directory) { $stack.Push($entry); continue }
                $fileInfo = [IO.FileInfo]::new($entry)
                $totalBytes += $fileInfo.Length
                if ($rows.Count -ge 10000 -or $totalBytes -gt 200MB) { return $null }
                # Microsoft.PowerShell.Utility's Get-FileHash cannot open a file
                # whose path reaches the classic 260-character limit when the
                # bootstrap runs under Windows PowerShell 5.1; hash the
                # extended-length path with .NET instead.
                $relative = $entry.Substring($rootExtended.Length + 1).Replace('\', '/')
                $stream = $null
                $hasher = $null
                try {
                    $stream = [IO.File]::OpenRead($entry)
                    $hasher = [Security.Cryptography.SHA256]::Create()
                    $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')).ToLowerInvariant()
                } finally {
                    if ($hasher) { $hasher.Dispose() }
                    if ($stream) { $stream.Dispose() }
                }
                [void]$rows.Add("$relative`0$($fileInfo.Length)`0$hash`n")
            }
        }
        $rows.Sort([StringComparer]::Ordinal)
        $bytes = [Text.Encoding]::UTF8.GetBytes(($rows -join ''))
        $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
        return ([BitConverter]::ToString($digest).Replace('-', '')).ToLowerInvariant()
    } catch { return $null }
}

function Test-OrchTrustedNpm {
    param([Parameter(Mandatory)][string]$NpmPath,
          [string[]]$AllowedDigests = @('eeef933fe6227a6f65e8464a589a1b4812b01978c57703d9fe26e375991cd05e', '66efc12cb3dd07ec12c6d2a30353803445cc6ba476f35f679a3fe2c676ffc691'))
    try {
        $npmRoot = Split-Path -Parent (Split-Path -Parent $NpmPath)
        $digest = Get-OrchTreeDigest -Root $npmRoot
        return $null -ne $digest -and $AllowedDigests -contains $digest
    } catch { return $false }
}

function Test-OrchNode {
    param([Parameter(Mandatory)][string]$NodePath, [ValidateRange(1,1800)][int]$TimeoutSeconds = 20,
          [switch]$AllowUnverified, [switch]$AllowUnverifiedNpm)
    if (-not [IO.File]::Exists((ConvertTo-OrchExtendedPath -Path $NodePath))) { return $null }
    if (-not $AllowUnverified -and -not (Test-OrchTrustedSignature -Path $NodePath)) { return $null }
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $probeStart = Get-OrchNodeProbeStartInfo -NodePath $NodePath
        $probe = Invoke-OrchProcess -FilePath $NodePath -ArgumentList @('-p', 'JSON.stringify({version:process.versions.node,platform:process.platform})') -TimeoutSeconds ([Math]::Min(8,$TimeoutSeconds)) -Environment $probeStart.Environment -WorkingDirectory $probeStart.WorkingDirectory
        if ($probe.ExitCode -ne 0) { return $null }
        $version = $probe.Stdout.Trim() | ConvertFrom-Json
        if ($version.platform -ne 'win32' -or [int]($version.version.Split('.')[0]) -lt 22) { return $null }
        $nodeDir = Split-Path -Parent $NodePath
        $npmCandidates = @((Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'), (Join-Path (Split-Path -Parent $nodeDir) 'node_modules\npm\bin\npm-cli.js'))
        foreach ($npmPath in $npmCandidates) {
            if (-not [IO.File]::Exists((ConvertTo-OrchExtendedPath -Path $npmPath))) { continue }
            # An explicit development/test override authorizes an otherwise
            # untrusted npm tree. Do not still hash every file in that tree:
            # the digest is only evidence for the trusted path and can take a
            # long time on a cold Windows volume.
            $npmTrusted = if ($AllowUnverifiedNpm) { $false } else { Test-OrchTrustedNpm -NpmPath $npmPath }
            if (-not $npmTrusted -and -not $AllowUnverifiedNpm) { continue }
            $left = $TimeoutSeconds - [int][Math]::Floor($timer.Elapsed.TotalSeconds)
            if ($left -lt 1) { return $null }
            $npm = Invoke-OrchProcess -FilePath $NodePath -ArgumentList @($npmPath, '--version') -TimeoutSeconds ([Math]::Min(10,$left)) -Environment $probeStart.Environment -WorkingDirectory $probeStart.WorkingDirectory
            if ($npm.ExitCode -eq 0 -and $npm.Stdout.Trim() -match '^\d+\.\d+\.\d+') {
                return [pscustomobject]@{ NodePath = [IO.Path]::GetFullPath($NodePath); NpmPath = [IO.Path]::GetFullPath($npmPath); Version = $version.version; NpmTrusted = $npmTrusted }
            }
        }
    } catch { return $null }
    return $null
}

function Get-OrchNodeCandidates {
    param([Parameter(Mandatory)][string]$RuntimeHome, [string]$NodePath)
    if ($NodePath) { return @([IO.Path]::GetFullPath($NodePath)) }
    $candidates = [Collections.Generic.List[string]]::new()
    foreach ($dir in ($env:PATH -split ';')) {
        if ($dir) { $candidates.Add((Join-Path $dir.Trim('"') 'node.exe')) }
    }
    if ($env:LOCALAPPDATA) {
        $bundleRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
        foreach ($entry in @(Get-ChildItem -LiteralPath $bundleRoot -Directory -ErrorAction SilentlyContinue)) { $candidates.Add((Join-Path $entry.FullName 'bin\node.exe')) }
    }
    if ($env:USERPROFILE) {
        $candidates.Add((Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
    }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
    foreach ($entry in @(Get-ChildItem -LiteralPath $RuntimeHome -Directory -ErrorAction SilentlyContinue)) {
        if ($entry.Name -match '^node-v\d+\.\d+\.\d+-win-(x64|arm64)$') { $candidates.Add((Join-Path $entry.FullName 'node.exe')) }
    }
    return @($candidates | Select-Object -Unique)
}

function Enter-OrchRuntimeLock {
    param([Parameter(Mandatory)][string]$RuntimeHome, [ValidateRange(1,1800)][int]$TimeoutSeconds = 300)
    $full = Assert-OrchSafePath $RuntimeHome
    [void][IO.Directory]::CreateDirectory($full)
    # A missing root was checked through its parent before creation. Confirm
    # the actual inherited ACL before a lock, archive, or executable appears.
    $full = Assert-OrchPrivateRuntimeHome $full
    $lockPath = Join-Path $full '.bootstrap.lock'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        [void](Assert-OrchSafePath $lockPath)
        try { return [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] {
            if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'RUNTIME_INSTALL_BUSY: another runtime preparation owns the installation lock; retry after it finishes.' }
            Start-Sleep -Milliseconds 150
        }
    } while ($true)
}

function Install-OrchNodeArchive {
    param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedHash,
          [Parameter(Mandatory)][string]$RuntimeHome, [Parameter(Mandatory)][ValidatePattern('^node-v\d+\.\d+\.\d+-win-(x64|arm64)$')][string]$DirectoryName,
          [ValidateRange(1,1800)][int]$TimeoutSeconds = 300)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $hashStream = [IO.File]::OpenRead($Archive)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($hashStream)).Replace('-', '') }
    finally { $hashStream.Dispose(); $hasher.Dispose() }
    if ($actualHash -ne $ExpectedHash) { throw 'NODE_CHECKSUM_MISMATCH: downloaded Node archive does not match the pinned official SHA256; nothing was executed.' }
    $lock = Enter-OrchRuntimeLock -RuntimeHome $RuntimeHome -TimeoutSeconds $TimeoutSeconds
    $stage = Join-Path $RuntimeHome ('.stage-' + [guid]::NewGuid().ToString('N'))
    $target = Join-Path $RuntimeHome $DirectoryName
    try {
        [void](Assert-OrchSafePath $target)
        if ([IO.Directory]::Exists((ConvertTo-OrchExtendedPath -Path $target))) {
            if (Test-OrchNode (Join-Path $target 'node.exe')) { return $target }
            throw 'NODE_RUNTIME_INVALID: existing private runtime failed its probe; repair the named runtime directory before retrying.'
        }
        [void][IO.Directory]::CreateDirectory((ConvertTo-OrchExtendedPath -Path $stage))
        [void](Assert-OrchRuntimeIdentity -Path $stage -RuntimeHome $RuntimeHome)
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
        try {
            $total = [long]0
            foreach ($entry in $zip.Entries) {
                if ($timer.Elapsed.TotalSeconds -gt $TimeoutSeconds) { throw 'BOOTSTRAP_TIMEOUT: archive extraction exhausted its time budget.' }
                $name = $entry.FullName.Replace('\', '/')
                $parts = $name.Split('/')
                $total += $entry.Length
                if ($zip.Entries.Count -gt 20000 -or $total -gt 400MB) { throw 'NODE_ARCHIVE_SIZE: archive expansion exceeds the runtime limit.' }
                if ($parts[0] -ne $DirectoryName -or $name -match '(^/|:|[\x00-\x1f])' -or $parts -contains '..' -or $parts -contains '.' -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'NODE_ARCHIVE_PATH: unsafe archive member.' }
                $destination = [IO.Path]::GetFullPath((Join-Path $stage $name))
                if (-not $destination.StartsWith($stage.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'NODE_ARCHIVE_PATH: member escapes staging directory.' }
                [void](Assert-OrchSafePath $destination)
                [void](Assert-OrchRuntimeIdentity -Path $stage -RuntimeHome $RuntimeHome)
                if ($name.EndsWith('/')) { [void][IO.Directory]::CreateDirectory((ConvertTo-OrchExtendedPath -Path $destination)); continue }
                [void][IO.Directory]::CreateDirectory((ConvertTo-OrchExtendedPath -Path ([IO.Path]::GetDirectoryName($destination))))
                [void](Assert-OrchRuntimeIdentity -Path ([IO.Path]::GetDirectoryName($destination)) -RuntimeHome $RuntimeHome)
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (ConvertTo-OrchExtendedPath -Path $destination), $false)
                [void](Assert-OrchRuntimeIdentity -Path $destination -RuntimeHome $RuntimeHome)
            }
        } finally { $zip.Dispose() }
        $extracted = Join-Path $stage $DirectoryName
        [void](Assert-OrchRuntimeIdentity -Path $stage -RuntimeHome $RuntimeHome)
        [void](Assert-OrchRuntimeIdentity -Path $extracted -RuntimeHome $RuntimeHome)
        if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node.exe') -PathType Leaf)) { throw 'NODE_ARCHIVE_INVALID: expected node.exe is absent.' }
        [void](Assert-OrchSafePath $target)
        [void](Assert-OrchRuntimeIdentity -Path $target -RuntimeHome $RuntimeHome)
        Move-Item -LiteralPath $extracted -Destination $target -ErrorAction Stop
        return $target
    } finally {
        try { Remove-OrchOwnedDirectory -Path $stage -RuntimeHome $RuntimeHome } finally { $lock.Dispose() }
    }
}

function Get-OrchNodeRelease {
    # Official SHASUMS256.txt retrieved from https://nodejs.org/dist/v22.23.3/
    # Hashes are pinned here, so a mirror cannot redefine the expected digest.
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -eq 'ARM64') { $arch = 'arm64'; $hash = '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535' }
    elseif ($architecture -eq 'AMD64') { $arch = 'x64'; $hash = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71' }
    else { throw 'NODE_ARCH_UNSUPPORTED: Windows x64 or ARM64 is required.' }
    return [pscustomobject]@{ Version = '22.23.3'; DirectoryName = "node-v22.23.3-win-$arch"; Hash = $hash }
}

function New-OrchWebRequest {
    param([Parameter(Mandatory)][string]$Uri, [string]$Method = 'GET', [int]$TimeoutSeconds = 15)
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.Method = $Method
    $request.Timeout = $TimeoutSeconds * 1000
    $request.ReadWriteTimeout = $TimeoutSeconds * 1000
    $request.UserAgent = 'codex-tui-orchestrator-bootstrap/1'
    $request.MaximumAutomaticRedirections = 5
    # Respect the Windows system proxy; no shell, credentials, or proxy values are logged.
    return $request
}

function Get-OrchDownloadSources {
    param([Parameter(Mandatory)]$Release, [ValidateRange(1,1800)][int]$TimeoutSeconds = 60)
    $available = @()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    foreach ($base in @('https://nodejs.org/dist', 'https://npmmirror.com/mirrors/node', 'https://mirrors.huaweicloud.com/nodejs')) {
        $uri = "$base/v$($Release.Version)/$($Release.DirectoryName).zip"
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $response = $null
        try {
            $left = $TimeoutSeconds - [int][Math]::Floor($timer.Elapsed.TotalSeconds)
            if ($left -lt 1) { throw 'BOOTSTRAP_TIMEOUT: source probing exhausted its time budget.' }
            $response = (New-OrchWebRequest -Uri $uri -Method HEAD -TimeoutSeconds ([Math]::Min(15,$left))).GetResponse()
            if ([int]$response.StatusCode -eq 200 -and $response.ContentLength -le 200MB) { $available += [pscustomobject]@{ Uri = $uri; Milliseconds = $watch.ElapsedMilliseconds } }
        } catch { # Every candidate is probed before selection; errors contain no credentials.
        } finally { if ($response) { $response.Close() } }
    }
    if ($available.Count -eq 0) { throw 'NODE_DOWNLOAD_UNAVAILABLE: no candidate serves the pinned Node release; check HTTPS proxy connectivity and retry.' }
    return @($available | Sort-Object Milliseconds)
}

function Save-OrchNodeArchive {
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Destination, [ValidateRange(1,1800)][int]$TimeoutSeconds = 180)
    $response = $null; $inputStream = $null; $outputStream = $null
    try {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $response = (New-OrchWebRequest -Uri $Uri -TimeoutSeconds ([Math]::Min(60,$TimeoutSeconds))).GetResponse()
        if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 200MB) { throw 'NODE_DOWNLOAD_SIZE: invalid response.' }
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 65536
        $bytes = [long]0
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $bytes += $count
            if ($bytes -gt 200MB -or $watch.Elapsed.TotalSeconds -gt $TimeoutSeconds) { throw 'NODE_DOWNLOAD_LIMIT: download exceeded size or time limit.' }
            $outputStream.Write($buffer, 0, $count)
        }
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Close() }
    }
}

function Resolve-OrchNode {
    param([AllowEmptyCollection()][string[]]$Candidates = @(), [Parameter(Mandatory)][string]$RuntimeHome, [switch]$NoDownload, [switch]$AllowUnverified,
          [switch]$AllowUnverifiedNpm,
          [ValidateRange(1,1800)][int]$TimeoutSeconds = 900)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    function Get-RemainingNodeSeconds {
        $left = $TimeoutSeconds - [int][Math]::Floor($timer.Elapsed.TotalSeconds)
        if ($left -lt 1) { throw 'BOOTSTRAP_TIMEOUT: Node preparation exhausted its time budget.' }
        return $left
    }
    foreach ($candidate in $Candidates) {
        $runtime = Test-OrchNode $candidate -TimeoutSeconds (Get-RemainingNodeSeconds) -AllowUnverified:$AllowUnverified -AllowUnverifiedNpm:$AllowUnverifiedNpm
        if ($runtime) { return $runtime }
    }
    if ($NoDownload) { throw 'NODE_RUNTIME_MISSING: a Windows Node 22+ runtime with npm is required; rerun bootstrap without -NoDownload for verified automatic installation.' }
    $release = Get-OrchNodeRelease
    [void](Assert-OrchSafePath $RuntimeHome)
    [void][IO.Directory]::CreateDirectory($RuntimeHome)
    $download = Join-Path $RuntimeHome ('.download-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($download)
    $oldTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $oldTls -bor [Net.SecurityProtocolType]::Tls12
        $sources = @(Get-OrchDownloadSources $release -TimeoutSeconds (Get-RemainingNodeSeconds))
        $archive = Join-Path $download 'node.zip'
        $saved = $false
        foreach ($source in $sources) {
            try { Save-OrchNodeArchive -Uri $source.Uri -Destination $archive -TimeoutSeconds (Get-RemainingNodeSeconds); $saved = $true; break }
            catch { # The next verified existing source is attempted in measured-latency order.
            }
        }
        if (-not $saved) { throw 'NODE_DOWNLOAD_FAILED: pinned runtime could not be downloaded within the bounded attempts.' }
        $installed = Install-OrchNodeArchive -Archive $archive -ExpectedHash $release.Hash -RuntimeHome $RuntimeHome -DirectoryName $release.DirectoryName -TimeoutSeconds (Get-RemainingNodeSeconds)
        $runtime = Test-OrchNode (Join-Path $installed 'node.exe') -TimeoutSeconds (Get-RemainingNodeSeconds)
        if (-not $runtime) { throw 'NODE_RUNTIME_INVALID: installed Node/npm failed executable verification.' }
        return $runtime
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $oldTls
        Remove-OrchOwnedDirectory -Path $download -RuntimeHome $RuntimeHome
    }
}
