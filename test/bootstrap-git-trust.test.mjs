import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const rotatedLeaf = '2A1E97CBF0DFCDA15B0DA0AC9745014F989D4AD0';
const rotatedSubject = 'CN=Johannes Schindelin, O=Johannes Schindelin, L=Bruehl, C=DE';
const rotatedIssuer = 'CN=Microsoft ID Verified CS EOC CA 04, O=Microsoft Corporation, C=US';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bootstrap-git-trust-'));
  const scripts = path.join(dir, 'scripts');
  const installRoot = path.join(dir, 'Git');
  const git = path.join(installRoot, 'cmd', 'git.exe');
  fs.mkdirSync(scripts, {recursive: true});
  fs.mkdirSync(path.dirname(git), {recursive: true});
  fs.writeFileSync(git, 'fixture');
  fs.copyFileSync(path.join(root, 'scripts', 'runtime-bootstrap.ps1'), path.join(scripts, 'runtime-bootstrap.ps1'));
  fs.copyFileSync(path.join(root, 'scripts', 'git-for-windows-trust.json'), path.join(scripts, 'git-for-windows-trust.json'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return {dir, scripts, installRoot, git};
}

function invoke(fixture, {candidate = fixture.git, subject = rotatedSubject, issuer = rotatedIssuer, reparse = false} = {}) {
  const runtime = path.join(fixture.scripts, 'runtime-bootstrap.ps1');
  const policy = path.join(fixture.scripts, 'git-for-windows-trust.json');
  const reparseOverride = reparse ? `
function Assert-OrchSafePath {
  param([Parameter(Mandatory)][string]$Path)
  if ([IO.Path]::GetFullPath($Path) -eq [IO.Path]::GetFullPath(${quote(candidate)})) { throw 'reparse point' }
  return [IO.Path]::GetFullPath($Path)
}
` : '';
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
function Get-ItemProperty {
  param([string]$LiteralPath, [string]$Name)
  [pscustomobject]@{ InstallPath = ${quote(fixture.installRoot)} }
}
function Get-AuthenticodeSignature {
  param([string]$LiteralPath)
  [pscustomobject]@{
    Status = 'Valid'
    SignerCertificate = [pscustomobject]@{
      Thumbprint = '${rotatedLeaf}'
      Subject = ${quote(subject)}
      Issuer = ${quote(issuer)}
    }
  }
}
${reparseOverride}
try {
  $result=Resolve-OrchTrustedGitForPull -Path ${quote(candidate)} -PolicyPath ${quote(policy)}
  [Console]::Out.Write($result)
} catch {
  [Console]::Out.Write('ERROR:' + $_.Exception.Message)
  exit 1
}
`;
  return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    // On a cold Windows host, initial PowerShell module preparation can exceed
    // the trust check itself.  Keep the test bound while allowing that host
    // startup cost, as the bootstrap entrypoint tests already do.
    encoding: 'utf8', windowsHide: true, timeout: 180000,
  });
}

function installedGit(t) {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Command git.exe -ErrorAction Stop).Source'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    t.skip('Git for Windows is required for checkout pull regressions');
    return null;
  }
  return result.stdout.trim();
}

function officialUserProfile(t) {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  if (!result.stdout.trim()) {
    t.skip('Windows user profile is required for SSH environment regression');
    return null;
  }
  return result.stdout.trim();
}

function runGit(git, argumentsList) {
  const result = spawnSync(git, argumentsList, {encoding: 'utf8', windowsHide: true, timeout: 30000});
  assert.equal(result.status, 0, `${result.stderr || result.stdout}\nGit arguments: ${argumentsList.join(' ')}`);
}

function createCheckout(fixture, git, name) {
  const checkout = path.join(fixture.dir, name);
  runGit(git, ['init', '--quiet', checkout]);
  return checkout;
}

function appendLocalGitConfig(checkout, text) {
  fs.appendFileSync(path.join(checkout, '.git', 'config'), `\n${text.trim()}\n`, 'utf8');
}

function psLiteral(value) {
  return value === null || value === undefined ? '$null' : quote(value);
}

function invokeTrustedCheckoutPull(fixture, git, cases, {trustedGlobalAutocrlf = null, trustedSystemAutocrlf = null} = {}) {
  const runtime = path.join(fixture.scripts, 'runtime-bootstrap.ps1');
  const installRoot = path.dirname(path.dirname(git));
  const caseValues = cases.map(({name, checkout}) => `[pscustomobject]@{ Name = ${quote(name)}; Checkout = ${quote(checkout)} }`).join(',');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
function Get-OrchGitForWindowsTrustPolicy {
  param([string]$PolicyPath)
  [pscustomobject]@{ ExecutableRelativePath = 'cmd\\git.exe' }
}
function Get-OrchGitForWindowsInstallPath {
  param([object]$Policy)
  return ${quote(installRoot)}
}
function Resolve-OrchTrustedGitForPull {
  param([string]$Path,[string]$PolicyPath)
  return ${quote(git)}
}
function Get-OrchTrustedGitAutocrlf {
  param([string]$GitPath,[string[]]$RepositoryArguments,[string]$Scope,[int]$TimeoutSeconds)
  if ($Scope -eq 'global') { return ${psLiteral(trustedGlobalAutocrlf)} }
  if ($Scope -eq 'system') { return ${psLiteral(trustedSystemAutocrlf)} }
  throw 'unexpected autocrlf scope'
}
$results = foreach ($case in @(${caseValues})) {
  try {
    Invoke-OrchTrustedCheckoutPull -Checkout $case.Checkout -TimeoutSeconds 20
    [pscustomobject]@{ Name = $case.Name; Error = $null }
  } catch {
    [pscustomobject]@{ Name = $case.Name; Error = $_.Exception.Message }
  }
}
[Console]::Out.Write(($results | ConvertTo-Json -Compress))
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 180000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

test('bootstrap Git trust accepts the registry-owned Git for Windows executable with the rotated publisher identity', {skip: !windows}, t => {
  const f = fixture(t);
  const result = invoke(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.resolve(f.git));
});

test('bootstrap Git trust rejects an equally signed executable outside the registry-owned install root', {skip: !windows}, t => {
  const f = fixture(t);
  const outside = path.join(f.dir, 'outside', 'git.exe');
  fs.mkdirSync(path.dirname(outside), {recursive: true});
  fs.writeFileSync(outside, 'fixture');
  const result = invoke(f, {candidate: outside});
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /GIT_UNTRUSTED: Git executable is not the registered Git for Windows cmd\\git\.exe/);
});

test('bootstrap Git trust rejects a rotated leaf with a mismatched publisher identity or reparse path', {skip: !windows}, t => {
  const f = fixture(t);
  const wrongPublisher = invoke(f, {subject: 'CN=Unexpected'});
  assert.notEqual(wrongPublisher.status, 0);
  assert.match(wrongPublisher.stdout, /GIT_UNTRUSTED: Git for Windows signer subject does not match the pinned policy/);
  const reparse = invoke(f, {reparse: true});
  assert.notEqual(reparse.status, 0);
  assert.match(reparse.stdout, /reparse point/);
});

test('trusted Git child rejects caller-controlled execution and configuration environment', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const userProfile = officialUserProfile(t);
  if (!userProfile) return;
  const stripped = [
    'GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_CEILING_DIRECTORIES','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_REPLACE_REF_BASE',
    'GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_CONFIG_PARAMETERS','GIT_CONFIG_SYSTEM',
    'GIT_SSH','GIT_SSH_COMMAND','GIT_SSH_VARIANT','GIT_ASKPASS','SSH_ASKPASS','SSH_ASKPASS_REQUIRE',
    'GIT_PROXY_COMMAND','GIT_SSL_NO_VERIFY','GIT_SSL_CERT','GIT_SSL_KEY','GIT_SSL_CAINFO','GIT_SSL_CAPATH','GIT_SSL_CIPHER_LIST','GIT_SSL_VERSION',
    'GIT_EXTERNAL_DIFF','GIT_PAGER','GIT_EDITOR','GIT_SEQUENCE_EDITOR','GIT_EXEC_PATH','GIT_ATTR_NOSYSTEM'
  ];
  const rebuilt = ['PATH','ComSpec','XDG_CONFIG_HOME','XDG_CONFIG_DIRS','HTTP_PROXY','HTTPS_PROXY','BASH_ENV','NODE_OPTIONS'];
  const fixed = {HOME: userProfile, USERPROFILE: userProfile, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh'};
  const names = [...stripped, ...rebuilt, ...Object.keys(fixed)];
  const child = path.join(f.dir, 'sanitized-environment-probe.mjs');
  fs.writeFileSync(child, `const names=${JSON.stringify(names)}; const out=Object.fromEntries(names.map(name=>[name,process.env[name] ?? null])); process.stdout.write(JSON.stringify(out));`, 'utf8');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
${names.map((name,index) => `$env:${name}='injected-${index}'`).join('\n')}
$result=Invoke-OrchSanitizedGit -FilePath ${quote(process.execPath)} -ArgumentList @(${quote(child)}) -TimeoutSeconds 30
if($result.ExitCode -ne 0){throw $result.Stderr}
[Console]::Out.Write($result.Stdout)
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  for (const name of stripped) assert.equal(observed[name], null, `${name} reached the trusted Git child`);
  for (const name of rebuilt) {
    const index = names.indexOf(name);
    assert.notEqual(observed[name], `injected-${index}`, `${name} reached the trusted Git child from the caller environment`);
  }
  for (const [name, value] of Object.entries(fixed)) {
    const actual = name === 'HOME' || name === 'USERPROFILE' ? observed[name]?.toLowerCase() : observed[name];
    const expected = name === 'HOME' || name === 'USERPROFILE' ? value.toLowerCase() : value;
    assert.equal(actual, expected, `${name} must be set to the fixed trusted value`);
  }
});

test('trusted Git environment builds PATH from the verified executable instead of machine or caller search paths', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$env:PATH='C:\\caller-controlled-bin'
$environment=Get-OrchTrustedGitEnvironment -GitPath ${quote(f.git)}
[Console]::Out.Write(($environment | ConvertTo-Json -Compress))
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const environment = JSON.parse(result.stdout);
  const entries = environment.Path.split(';').map(entry => path.resolve(entry).toLowerCase());
  assert.deepEqual(entries, [path.resolve(process.env.SystemRoot, 'System32').toLowerCase(), path.dirname(f.git).toLowerCase()]);
  assert.equal(entries.includes(path.resolve('C:\\caller-controlled-bin').toLowerCase()), false);
});

test('trusted autocrlf lookup opens only its selected config layer and reads one scalar', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const repositoryArguments = [`--work-tree=${path.resolve(f.dir)}`, '--no-pager', '-C', path.resolve(f.dir)];
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$records=[Collections.Generic.List[object]]::new()
function Invoke-OrchSanitizedGit {
  param([string]$FilePath,[string[]]$ArgumentList,[int]$TimeoutSeconds,[switch]$ReadSystemConfig,[switch]$ReadGlobalConfig)
  [void]$records.Add([pscustomobject]@{
    Arguments = @($ArgumentList)
    ReadSystemConfig = [bool]$ReadSystemConfig
    ReadGlobalConfig = [bool]$ReadGlobalConfig
  })
  return [pscustomobject]@{ ExitCode = 0; Stdout = "true\`n"; Stderr = '' }
}
$repositoryArguments=@(${repositoryArguments.map(quote).join(',')})
$global=Get-OrchTrustedGitAutocrlf -GitPath ${quote(f.git)} -RepositoryArguments $repositoryArguments -Scope global -TimeoutSeconds 23
$system=Get-OrchTrustedGitAutocrlf -GitPath ${quote(f.git)} -RepositoryArguments $repositoryArguments -Scope system -TimeoutSeconds 23
[Console]::Out.Write(([pscustomobject]@{ Global = $global; System = $system; Records = @($records) } | ConvertTo-Json -Depth 4 -Compress))
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.Global, 'true');
  assert.equal(observed.System, 'true');
  assert.equal(observed.Records.length, 2);
  assert.deepEqual(observed.Records[0].Arguments, [...repositoryArguments, 'config', '--global', '--no-includes', '--get', 'core.autocrlf']);
  assert.equal(observed.Records[0].ReadGlobalConfig, true);
  assert.equal(observed.Records[0].ReadSystemConfig, false);
  assert.deepEqual(observed.Records[1].Arguments, [...repositoryArguments, 'config', '--system', '--no-includes', '--get', 'core.autocrlf']);
  assert.equal(observed.Records[1].ReadGlobalConfig, false);
  assert.equal(observed.Records[1].ReadSystemConfig, true);
});

test('trusted autocrlf lookup normalizes Git boolean spellings and rejects invalid scalars', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$script:nextValue=''
function Invoke-OrchSanitizedGit {
  param([string]$FilePath,[string[]]$ArgumentList,[int]$TimeoutSeconds,[switch]$ReadSystemConfig,[switch]$ReadGlobalConfig)
  return [pscustomobject]@{ ExitCode = 0; Stdout = ($script:nextValue + "\`n"); Stderr = '' }
}
$values=foreach($scope in @('global','system')) {
  foreach($raw in @('true','yes','on','1','false','no','off','0','input')) {
    $script:nextValue=$raw
    Get-OrchTrustedGitAutocrlf -GitPath ${quote(f.git)} -RepositoryArguments @() -Scope $scope
  }
}
$script:nextValue='always'
$invalid=$null
try { Get-OrchTrustedGitAutocrlf -GitPath ${quote(f.git)} -RepositoryArguments @() -Scope system } catch { $invalid=$_.Exception.Message }
[Console]::Out.Write(([pscustomobject]@{ Values = @($values); Invalid = $invalid } | ConvertTo-Json -Compress))
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  const normalized = ['true', 'true', 'true', 'true', 'false', 'false', 'false', 'false', 'input'];
  assert.deepEqual(observed.Values, [...normalized, ...normalized]);
  assert.match(observed.Invalid, /autocrlf inspection returned an invalid value/);
});

test('trusted global autocrlf lookup ignores values supplied through an include', {skip: !windows}, t => {
  const f = fixture(t);
  const git = installedGit(t);
  if (!git) return;
  const checkout = createCheckout(f, git, 'global-include-checkout');
  const home = path.join(f.dir, 'isolated-home');
  const included = path.join(f.dir, 'included-global.config');
  fs.mkdirSync(home, {recursive: true});
  fs.writeFileSync(path.join(home, '.gitconfig'), `[include]\n\tpath = "${included.replaceAll('\\', '/')}"\n`, 'utf8');
  fs.writeFileSync(included, '[core]\n\tautocrlf = on\n', 'utf8');
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const repositoryArguments = [`--work-tree=${path.resolve(checkout)}`, '--no-pager', '-C', path.resolve(checkout)];
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$originalTrustedGitEnvironment=(Get-Command Get-OrchTrustedGitEnvironment -CommandType Function).ScriptBlock
function Get-OrchTrustedGitEnvironment {
  param([string]$GitPath,[switch]$ReadSystemConfig,[switch]$ReadGlobalConfig)
  $environment=& $originalTrustedGitEnvironment -GitPath $GitPath -ReadSystemConfig:$ReadSystemConfig -ReadGlobalConfig:$ReadGlobalConfig
  $environment['HOME']=${quote(home)}
  $environment['USERPROFILE']=${quote(home)}
  return $environment
}
$repositoryArguments=@(${repositoryArguments.map(quote).join(',')})
$result=Get-OrchTrustedGitAutocrlf -GitPath ${quote(git)} -RepositoryArguments $repositoryArguments -Scope global -TimeoutSeconds 23
if($null -eq $result){[Console]::Out.Write('null')}else{[Console]::Out.Write($result)}
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'null');
});

test('autocrlf lookup exposes global or system config only for that scalar child', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$default=Get-OrchTrustedGitEnvironment -GitPath ${quote(f.git)}
$global=Get-OrchTrustedGitEnvironment -GitPath ${quote(f.git)} -ReadGlobalConfig
$system=Get-OrchTrustedGitEnvironment -GitPath ${quote(f.git)} -ReadSystemConfig
[Console]::Out.Write(([pscustomobject]@{ Default = $default; Global = $global; System = $system } | ConvertTo-Json -Compress))
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.Default.GIT_CONFIG_GLOBAL, 'NUL');
  assert.equal(observed.Default.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(Object.hasOwn(observed.Global, 'GIT_CONFIG_GLOBAL'), false);
  assert.equal(observed.Global.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(observed.System.GIT_CONFIG_GLOBAL, 'NUL');
  assert.equal(Object.hasOwn(observed.System, 'GIT_CONFIG_NOSYSTEM'), false);
});

test('Git child cannot re-enable global and system config together', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$caughtMessage=$null
try { Get-OrchTrustedGitEnvironment -GitPath ${quote(f.git)} -ReadGlobalConfig -ReadSystemConfig | Out-Null } catch { $caughtMessage=$_.Exception.Message }
[Console]::Out.Write($caughtMessage)
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /both global and system config/);
});

test('checkout-local and worktree autocrlf take precedence over external scalar fallback', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$records=[Collections.Generic.List[object]]::new()
$script:configScope=''
function Get-OrchGitForWindowsTrustPolicy { param([string]$PolicyPath); [pscustomobject]@{ ExecutableRelativePath = 'cmd\\git.exe' } }
function Get-OrchGitForWindowsInstallPath { param([object]$Policy); return ${quote(f.installRoot)} }
function Resolve-OrchTrustedGitForPull { param([string]$Path,[string]$PolicyPath); return ${quote(f.git)} }
function Assert-OrchSafePath { param([string]$Path); return [IO.Path]::GetFullPath($Path) }
function Get-OrchTrustedGitAutocrlf { throw 'external autocrlf fallback must not run when checkout config sets it' }
function Invoke-OrchSanitizedGit {
  param([string]$FilePath,[string[]]$ArgumentList,[int]$TimeoutSeconds,[switch]$ReadSystemConfig,[switch]$ReadGlobalConfig)
  [void]$records.Add([pscustomobject]@{ Arguments = @($ArgumentList) })
  if($ArgumentList -contains 'config'){
    return [pscustomobject]@{ ExitCode = 0; Stdout = ($script:configScope + "\`0core.autocrlf\`nfalse\`0"); Stderr = '' }
  }
  return [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
$outcomes=foreach($scope in @('local','worktree')){
  $script:configScope=$scope
  $caughtMessage=$null
  try { Invoke-OrchTrustedCheckoutPull -Checkout ${quote(f.dir)} -TimeoutSeconds 23 } catch { $caughtMessage=$_.Exception.Message }
  [pscustomobject]@{ Scope = $scope; Error = $caughtMessage }
}
[Console]::Out.Write(([pscustomobject]@{ Outcomes = @($outcomes); Records = $records.ToArray() } | ConvertTo-Json -Depth 4 -Compress))
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.Outcomes, [{Scope: 'local', Error: null}, {Scope: 'worktree', Error: null}]);
  assert.equal(observed.Records.length, 6);
  for (const record of observed.Records) {
    assert.equal(record.Arguments.some(argument => argument === `--work-tree=${path.resolve(f.dir)}`), true);
    assert.equal(record.Arguments.includes('core.autocrlf=true'), false);
    assert.equal(record.Arguments.includes('core.autocrlf=false'), false);
  }
});

test('trusted checkout pull resolves Git from the signed registry policy without a caller PATH lookup', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$records=[Collections.Generic.List[object]]::new()
function Get-OrchGitForWindowsTrustPolicy {
  param([string]$PolicyPath)
  [pscustomobject]@{ ExecutableRelativePath = 'cmd\\git.exe' }
}
function Get-OrchGitForWindowsInstallPath {
  param([object]$Policy)
  return ${quote(f.installRoot)}
}
function Resolve-OrchTrustedGitForPull {
  param([string]$Path,[string]$PolicyPath)
  return [IO.Path]::GetFullPath($Path)
}
function Get-OrchTrustedGitAutocrlf {
  param([string]$GitPath,[string[]]$RepositoryArguments,[string]$Scope,[int]$TimeoutSeconds)
  return $null
}
function Invoke-OrchSanitizedGit {
  param([string]$FilePath,[string[]]$ArgumentList,[int]$TimeoutSeconds)
  [void]$records.Add([pscustomobject]@{ FilePath = $FilePath; Arguments = @($ArgumentList); TimeoutSeconds = $TimeoutSeconds })
  return [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = '' }
}
function Get-Command { throw 'caller PATH lookup must not run for a trusted checkout pull' }
Invoke-OrchTrustedCheckoutPull -Checkout ${quote(f.dir)} -TimeoutSeconds 23
[Console]::Out.Write(($records | ConvertTo-Json -Depth 4 -Compress))
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout);
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.FilePath, path.resolve(f.git));
    assert.equal(record.TimeoutSeconds, 23);
    assert.equal(record.Arguments.some(argument => argument === `--work-tree=${path.resolve(f.dir)}`), true);
    assert.equal(record.Arguments.includes('--no-pager'), true);
  }
  assert.equal(records[0].Arguments.includes('config'), true);
  assert.equal(records[0].Arguments.includes('credential.helper='), false);
  assert.equal(records[1].Arguments.includes('status'), true);
  assert.equal(records[1].Arguments.includes('--porcelain=v1'), true);
  assert.equal(records[1].Arguments.includes('--untracked-files=all'), true);
  assert.equal(records[1].Arguments.includes('credential.helper='), true);
  assert.equal(records[2].Arguments.includes('pull'), true);
  assert.equal(records[2].Arguments.includes('credential.helper='), true);
  assert.equal(records[2].Arguments.includes('--no-rebase'), true);
  assert.equal(records[2].Arguments.includes('--no-squash'), true);
  assert.equal(records[2].Arguments.includes('--no-autostash'), true);
  assert.equal(records[2].Arguments.includes('--no-verify'), true);
  assert.equal(records[2].Arguments.includes('--upload-pack=git-upload-pack'), true);
});

test('trusted checkout pull rejects protocol.ext.allow before a status, pull, or transport helper can run', {skip: !windows}, t => {
  const f = fixture(t);
  const runtime = path.join(f.scripts, 'runtime-bootstrap.ps1');
  const script = `
$ErrorActionPreference='Stop'
. ${quote(runtime)}
$records=[Collections.Generic.List[object]]::new()
function Get-OrchGitForWindowsTrustPolicy { [pscustomobject]@{ ExecutableRelativePath = 'cmd\\git.exe' } }
function Get-OrchGitForWindowsInstallPath { return ${quote(f.installRoot)} }
function Resolve-OrchTrustedGitForPull { return ${quote(f.git)} }
function Assert-OrchSafePath { param([string]$Path) return [IO.Path]::GetFullPath($Path) }
function Invoke-OrchSanitizedGit {
  param([string]$FilePath,[string[]]$ArgumentList,[int]$TimeoutSeconds,[switch]$ReadSystemConfig,[switch]$ReadGlobalConfig)
  [void]$records.Add([pscustomobject]@{ Arguments = @($ArgumentList) })
  return [pscustomobject]@{ ExitCode = 0; Stdout = "local\`0protocol.ext.allow\`nalways\`0"; Stderr = '' }
}
$caughtMessage=$null
try { Invoke-OrchTrustedCheckoutPull -Checkout ${quote(f.dir)} -TimeoutSeconds 23 } catch { $caughtMessage=$_.Exception.Message }
[Console]::Out.Write(([pscustomobject]@{ Error = $caughtMessage; Records = $records.ToArray() } | ConvertTo-Json -Depth 4 -Compress))
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.Error, 'GIT_PULL_CONFIG_UNSAFE: checkout configuration enables the ext transport.');
  assert.equal(observed.Records.length, 1);
  assert.equal(observed.Records[0].Arguments.includes('config'), true);
  assert.equal(observed.Records[0].Arguments.includes('--no-includes'), true);
  assert.equal(observed.Records[0].Arguments.includes('status'), false);
  assert.equal(observed.Records[0].Arguments.includes('pull'), false);
});

test('trusted checkout pull pins status to the requested worktree despite a local core.worktree redirect', {skip: !windows}, t => {
  const f = fixture(t);
  const git = installedGit(t);
  if (!git) return;
  const checkout = createCheckout(f, git, 'checkout');
  const outside = path.join(f.dir, 'outside');
  fs.mkdirSync(outside, {recursive: true});
  fs.writeFileSync(path.join(outside, 'outside-only.txt'), 'untracked outside content', 'utf8');
  appendLocalGitConfig(checkout, `[core]\n\tworktree = ${outside.replaceAll('\\', '/')}`);
  const [result] = invokeTrustedCheckoutPull(f, git, [{name: 'redirected-worktree', checkout}]);
  assert.match(result.Error, /^GIT_PULL_FAILED:/, result.Error);
  assert.doesNotMatch(result.Error, /refusing to pull: the working tree has local changes/);
});

test('trusted checkout pull always checks untracked files even when local status config hides them', {skip: !windows}, t => {
  const f = fixture(t);
  const git = installedGit(t);
  if (!git) return;
  const checkout = createCheckout(f, git, 'checkout');
  fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'must be observed', 'utf8');
  appendLocalGitConfig(checkout, '[status]\n\tshowUntrackedFiles = no');
  const [result] = invokeTrustedCheckoutPull(f, git, [{name: 'hidden-untracked', checkout}]);
  assert.equal(result.Error, 'refusing to pull: the working tree has local changes');
});

function createForcedCrlfCheckout(fixture, git, name) {
  const checkout = createCheckout(fixture, git, name);
  runGit(git, ['-C', checkout, 'config', 'user.email', 'fixture@example.invalid']);
  runGit(git, ['-C', checkout, 'config', 'user.name', 'fixture']);
  fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'one\r\ntwo\r\n', 'utf8');
  runGit(git, ['-C', checkout, '-c', 'core.autocrlf=true', 'add', 'tracked.txt']);
  runGit(git, ['-C', checkout, 'commit', '--quiet', '-m', 'initial']);
  runGit(git, ['-C', checkout, '-c', 'core.autocrlf=true', 'checkout', '--', 'tracked.txt']);
  const trackedPath = path.join(checkout, 'tracked.txt');
  assert.deepEqual(fs.readFileSync(trackedPath), Buffer.from('one\r\ntwo\r\n', 'utf8'));
  fs.utimesSync(trackedPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const recheck = spawnSync(git, ['-C', checkout, '-c', 'core.autocrlf=false', 'update-index', '--really-refresh'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.notEqual(recheck.status, 0, 'the fixture must force Git to recheck the CRLF working file under false autocrlf');
  assert.match(`${recheck.stdout}${recheck.stderr}`, /tracked\.txt: needs update/i);
  return checkout;
}

test('trusted checkout pull preserves a clean CRLF checkout after a forced index recheck', {skip: !windows}, t => {
  const f = fixture(t);
  const git = installedGit(t);
  if (!git) return;
  const checkout = createForcedCrlfCheckout(f, git, 'crlf-system-checkout');
  const [result] = invokeTrustedCheckoutPull(f, git, [{name: 'crlf-system-checkout', checkout}], {
    trustedSystemAutocrlf: 'true',
  });
  assert.match(result.Error, /^GIT_PULL_FAILED:/, result.Error);
  assert.doesNotMatch(result.Error, /refusing to pull: the working tree has local changes/);
});

test('trusted checkout pull uses the trusted global autocrlf scalar before system config', {skip: !windows}, t => {
  const f = fixture(t);
  const git = installedGit(t);
  if (!git) return;
  const checkout = createForcedCrlfCheckout(f, git, 'crlf-global-checkout');
  const [result] = invokeTrustedCheckoutPull(f, git, [{name: 'crlf-global-checkout', checkout}], {
    trustedGlobalAutocrlf: 'true',
    trustedSystemAutocrlf: 'false',
  });
  assert.match(result.Error, /^GIT_PULL_FAILED:/, result.Error);
  assert.doesNotMatch(result.Error, /refusing to pull: the working tree has local changes/);
});

test('trusted checkout pull rejects checkout-local executable, transport, and TLS selectors before invoking pull', {skip: !windows}, t => {
  const f = fixture(t);
  const git = installedGit(t);
  if (!git) return;
  const unsafeConfigurations = [
    {name: 'included-config', config: '[include]\n\tpath = C:/attacker/include.config'},
    {name: 'hook-command', config: '[core]\n\thooksPath = C:/attacker/hooks'},
    {name: 'fsmonitor-command', config: '[core]\n\tfsmonitor = C:/attacker/fsmonitor.cmd'},
    {name: 'alternate-refs-command', config: '[core]\n\talternateRefsCommand = cmd /c attacker'},
    {name: 'ssh-command', config: '[core]\n\tsshCommand = cmd /c attacker'},
    {name: 'askpass-command', config: '[core]\n\taskPass = C:/attacker/askpass.cmd'},
    {name: 'git-proxy-command', config: '[core]\n\tgitProxy = cmd /c attacker'},
    {name: 'filter-command', config: '[filter "unsafe"]\n\tsmudge = cmd /c attacker'},
    {name: 'merge-command', config: '[merge "unsafe"]\n\tdriver = cmd /c attacker'},
    {name: 'credential-helper', config: '[credential]\n\thelper = !cmd /c attacker'},
    {name: 'remote-proxy', config: '[remote "origin"]\n\tproxy = http://127.0.0.1:9'},
    {name: 'remote-helper', config: '[remote "origin"]\n\tvcs = attacker'},
    {name: 'remote-upload-pack', config: '[remote "origin"]\n\tuploadpack = attacker'},
    {name: 'url-rewrite', config: '[url "ssh://example.invalid/"]\n\tinsteadOf = https://example.invalid/'},
    {name: 'protocol-ext-allow', config: '[protocol "ext"]\n\tallow = always'},
    {name: 'http-proxy', config: '[http "https://example.invalid"]\n\tproxy = http://127.0.0.1:9'},
    {name: 'http-tls-override', config: '[http "https://example.invalid"]\n\tsslVerify = false'},
    {name: 'http-revocation-override', config: '[http "https://example.invalid"]\n\tschannelCheckRevoke = false'},
    {name: 'http-credential-option', config: '[http "https://example.invalid"]\n\temptyAuth = true'},
    {name: 'http-header', config: '[http "https://example.invalid"]\n\textraHeader = Authorization: unsafe'},
    {name: 'worktree-scoped-ssh-command', config: '[extensions]\n\tworktreeConfig = true', worktreeConfig: ['core.sshCommand', 'cmd /c attacker']},
  ];
  const cases = unsafeConfigurations.map(({name, config, worktreeConfig}) => {
    const checkout = createCheckout(f, git, name);
    appendLocalGitConfig(checkout, config);
    if (worktreeConfig) runGit(git, ['-C', checkout, 'config', '--worktree', ...worktreeConfig]);
    return {name, checkout};
  });
  const results = invokeTrustedCheckoutPull(f, git, cases);
  assert.equal(results.length, unsafeConfigurations.length);
  for (const result of results) {
    assert.match(result.Error, /^GIT_PULL_CONFIG_UNSAFE:/, `${result.Name}: ${result.Error}`);
  }
});

test('trusted checkout pull permits benign local configuration while enforcing safe status and pull options', {skip: !windows}, t => {
  const f = fixture(t);
  const git = installedGit(t);
  if (!git) return;
  const checkout = createCheckout(f, git, 'benign-local-config');
  appendLocalGitConfig(checkout, '[user]\n\tname = local developer\n[http]\n\tsslVerify = true\n\tschannelCheckRevoke = best-effort\n[protocol "ext"]\n\tallow = never\n[status]\n\tshowUntrackedFiles = no');
  const [result] = invokeTrustedCheckoutPull(f, git, [{name: 'benign-local-config', checkout}]);
  assert.match(result.Error, /^GIT_PULL_FAILED:/, result.Error);
  assert.doesNotMatch(result.Error, /^GIT_PULL_CONFIG_UNSAFE:/, result.Error);
});
