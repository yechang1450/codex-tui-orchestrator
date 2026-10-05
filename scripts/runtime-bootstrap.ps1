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
            if ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) { throw 'RUNTIME_REPARSE_PATH: runtime paths must not contain junctions or symbolic links.' }
        } catch [IO.FileNotFoundException] { # Missing ancestors will be created after validation.
        } catch [IO.DirectoryNotFoundException] {
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
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

function Remove-OrchOwnedDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$RuntimeHome)
    $homeFull = (Assert-OrchSafePath $RuntimeHome).TrimEnd('\') + '\'
    $full = Assert-OrchSafePath $Path
    if (-not $full.StartsWith($homeFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'RUNTIME_CLEANUP_PATH: refusing cleanup outside runtime home.' }
    if (Test-Path -LiteralPath $full) {
        foreach ($entry in Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction Stop) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RUNTIME_REPARSE_PATH: refusing recursive cleanup through a reparse point.' }
        }
        Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    }
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
    param([Parameter(Mandatory)][string]$FilePath, [AllowEmptyCollection()][string[]]$ArgumentList = @(), [ValidateRange(1,1800)][int]$TimeoutSeconds = 15)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
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
            else { & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>$null | Out-Null }
            [void]$process.WaitForExit(5000)
            throw 'PROCESS_TIMEOUT: runtime preparation exceeded its bounded timeout.'
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout.GetAwaiter().GetResult(); Stderr = $stderr.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function Invoke-OrchAttachedProcess {
    param([Parameter(Mandatory)][string]$FilePath, [AllowEmptyCollection()][string[]]$ArgumentList = @())
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
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
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
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

function Get-OrchTreeDigest {
    param([Parameter(Mandatory)][string]$Root)
    try {
        $rootFull = (Assert-OrchSafePath $Root).TrimEnd('\')
        if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) { return $null }
        $rows = [Collections.Generic.List[string]]::new()
        $stack = [Collections.Generic.Stack[string]]::new()
        $stack.Push($rootFull)
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
                $relative = $entry.Substring($rootFull.Length + 1).Replace('\', '/')
                $hash = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
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
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $null }
    if (-not $AllowUnverified -and -not (Test-OrchTrustedSignature -Path $NodePath)) { return $null }
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $probe = Invoke-OrchProcess -FilePath $NodePath -ArgumentList @('-p', 'JSON.stringify({version:process.versions.node,platform:process.platform})') -TimeoutSeconds ([Math]::Min(8,$TimeoutSeconds))
        if ($probe.ExitCode -ne 0) { return $null }
        $version = $probe.Stdout.Trim() | ConvertFrom-Json
        if ($version.platform -ne 'win32' -or [int]($version.version.Split('.')[0]) -lt 22) { return $null }
        $nodeDir = Split-Path -Parent $NodePath
        $npmCandidates = @((Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'), (Join-Path (Split-Path -Parent $nodeDir) 'node_modules\npm\bin\npm-cli.js'))
        foreach ($npmPath in $npmCandidates) {
            if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) { continue }
            $npmTrusted = Test-OrchTrustedNpm -NpmPath $npmPath
            if (-not $npmTrusted -and -not $AllowUnverifiedNpm) { continue }
            $left = $TimeoutSeconds - [int][Math]::Floor($timer.Elapsed.TotalSeconds)
            if ($left -lt 1) { return $null }
            $npm = Invoke-OrchProcess -FilePath $NodePath -ArgumentList @($npmPath, '--version') -TimeoutSeconds ([Math]::Min(10,$left))
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
        if (Test-Path -LiteralPath $target) {
            if (Test-OrchNode (Join-Path $target 'node.exe')) { return $target }
            throw 'NODE_RUNTIME_INVALID: existing private runtime failed its probe; repair the named runtime directory before retrying.'
        }
        [void][IO.Directory]::CreateDirectory($stage)
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
                if ($name.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($destination); continue }
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
                [void](Assert-OrchRuntimeIdentity -Path ([IO.Path]::GetDirectoryName($destination)) -RuntimeHome $RuntimeHome)
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
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
