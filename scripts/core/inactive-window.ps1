param(
 [Parameter(Mandatory=$true)][string]$Payload,
 [Parameter(Mandatory=$true)][string]$EnvironmentFile,
 [Parameter(Mandatory=$true)][string]$EnvironmentToken
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
if(-not $env:PATHEXT){$env:PATHEXT='.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'}
# PowerShell 5.1 does not rescan PATHEXT after startup, so a process launched from WSL
# may not resolve chcp. Encoding is already set above, so chcp is only hardening here.
try {
  $chcp = Join-Path ([Environment]::GetEnvironmentVariable('SystemRoot')) 'System32\chcp.com'
  & $chcp 65001 | Out-Null
} catch { }
function Read-OrchestratorTargetEnvironment {
 param([string]$File,[string]$Token)
 if([string]::IsNullOrWhiteSpace($File) -or [string]::IsNullOrWhiteSpace($Token) -or $Token -notmatch '^[A-Za-z0-9_-]{43}$'){throw 'invalid target environment reference'}
 if($File -notmatch '^[A-Za-z]:\\'){throw 'target environment path must be absolute'}
 $full=[IO.Path]::GetFullPath($File)
 if([IO.Path]::GetFileName($full) -notmatch '^inactive-env-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.dpapi$'){throw 'invalid target environment file'}
 $info=[IO.FileInfo]::new($full)
 if(-not $info.Exists -or $info.Length -le 0 -or $info.Length -gt 524288 -or (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'target environment file is unavailable'}
 $verified=$false
 try {
  $sealed=[IO.File]::ReadAllText($full,[Text.UTF8Encoding]::new($false)).Trim()
  if($sealed.Length -eq 0 -or $sealed.Length -gt 524288 -or $sealed -notmatch '^[A-Za-z0-9+/]+={0,2}$'){throw 'target environment file is invalid'}
  Add-Type -AssemblyName System.Security
  $raw=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($sealed),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $plain=[Text.Encoding]::UTF8.GetString($raw)
  if([Text.Encoding]::UTF8.GetByteCount($plain) -gt 262144){throw 'target environment payload is too large'}
  $record=$plain|ConvertFrom-Json
  $properties=@($record.PSObject.Properties)
  if($record -is [Array] -or $properties.Count -ne 3 -or $null -eq $record.PSObject.Properties['version'] -or $null -eq $record.PSObject.Properties['token'] -or $null -eq $record.PSObject.Properties['environment']){throw 'target environment payload is invalid'}
  if($record.version -isnot [int] -or $record.version -ne 1 -or $record.token -isnot [string] -or -not [string]::Equals($record.token,$Token,[StringComparison]::Ordinal) -or $record.environment -isnot [PSCustomObject]){throw 'target environment payload is invalid'}
  $names=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $entries=[System.Collections.Generic.List[string]]::new()
  $count=0;$characters=1
  foreach($property in @($record.environment.PSObject.Properties)){
   $name=[string]$property.Name;$value=$property.Value
   if([string]::IsNullOrEmpty($name) -or $name.Length -gt 256 -or $name.IndexOf([char]0) -ge 0 -or $name.IndexOf('=') -ge 0 -or $value -isnot [string] -or $value.IndexOf([char]0) -ge 0){throw 'target environment entry is invalid'}
   if(-not $names.Add($name)){throw 'target environment contains duplicate names'}
   $count++;$characters+=$name.Length+$value.Length+2
   if($count -gt 256 -or $characters -gt 30000){throw 'target environment exceeds its safety limit'}
   [void]$entries.Add($name+'='+$value)
  }
  if($count -eq 0){throw 'target environment is empty'}
  # CreateProcess requires an explicitly supplied environment block to be
  # alphabetically ordered. Sort only after validation so the names remain
  # data and cannot affect the launch command.
  $entries.Sort([StringComparer]::OrdinalIgnoreCase)
  $verified=$true
  $separator=[string][char]0
  return [string]::Join($separator,$entries.ToArray())+$separator
 } finally {
  if($verified){try{[IO.File]::Delete($full)}catch{}}
 }
}
try {
  $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  try {$targetEnvironment=Read-OrchestratorTargetEnvironment $EnvironmentFile $EnvironmentToken}
  catch {throw 'target environment payload is unavailable'}
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrchestratorInactiveShell {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Startup {
  public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xCount,yCount,fill,flags;
  public short show,reserved2;public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool CreateProcessW(string app,System.Text.StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
 delegate bool EnumProc(IntPtr window,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,System.Text.StringBuilder name,int size);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window,int command);
 [StructLayout(LayoutKind.Sequential)] struct LastInput {public uint cbSize;public uint dwTime;}
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
 public static void Launch(string file,string parameters,string cwd,string environmentBlock){
  var baseline=GetForegroundWindow();var input=new LastInput();input.cbSize=(uint)Marshal.SizeOf(input);GetLastInputInfo(ref input);var baselineInput=input.dwTime;
  var consoleHost=String.Equals(System.IO.Path.GetFileName(file),"conhost.exe",StringComparison.OrdinalIgnoreCase);
  var s=new Startup();s.cb=Marshal.SizeOf(s);s.flags=1;s.show=(short)(consoleHost?0:4);ProcessInfo p;IntPtr environment=IntPtr.Zero;
  try {
   if(String.IsNullOrEmpty(environmentBlock))throw new ArgumentException("Missing target environment");
   environment=Marshal.StringToHGlobalUni(environmentBlock);
   if(!CreateProcessW(file,new System.Text.StringBuilder("\""+file+"\" "+parameters),IntPtr.Zero,IntPtr.Zero,false,0x410,environment,cwd,ref s,out p))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  } finally { if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment); }
  CloseHandle(p.thread);
  if(consoleHost){
   // Let the owned console initialize hidden, then display it without activating.
   // Direct PowerShell startup can be delegated to the user's default terminal.
   try {
    IntPtr window=IntPtr.Zero;var ready=System.Diagnostics.Stopwatch.StartNew();
    while(window==IntPtr.Zero&&ready.ElapsedMilliseconds<5000){
     EnumWindows((w,d)=>{uint owner;GetWindowThreadProcessId(w,out owner);var name=new System.Text.StringBuilder(64);GetClassName(w,name,64);if(owner==p.pid&&name.ToString()=="ConsoleWindowClass"){window=w;return false;}return true;},IntPtr.Zero);
     if(window==IntPtr.Zero)System.Threading.Thread.Sleep(10);
    }
    if(window==IntPtr.Zero)throw new InvalidOperationException("Console window was not created");
    if(!ShowWindowAsync(window,4))throw new InvalidOperationException("Console window could not be shown");
   } catch {
    // Failed admission must not leave the newly-created console hidden and running.
    TerminateProcess(p.process,1);
    throw;
   } finally {
    CloseHandle(p.process);
   }
   return;
  }
  CloseHandle(p.process);
  var guard=System.Diagnostics.Stopwatch.StartNew();
  while(guard.ElapsedMilliseconds<2500){
   var now=new LastInput();now.cbSize=(uint)Marshal.SizeOf(now);GetLastInputInfo(ref now);
   if(now.dwTime!=baselineInput&&GetForegroundWindow()!=baseline)break;
   if(baseline!=IntPtr.Zero&&GetForegroundWindow()!=baseline)SetForegroundWindow(baseline);
   System.Threading.Thread.Sleep(20);
  }
 }
}
'@
  [OrchestratorInactiveShell]::Launch([string]$request.file,[string]$request.parameters,[string]$request.cwd,$targetEnvironment)
} catch {
  [Console]::Error.WriteLine('INACTIVE_WINDOW_LAUNCH_FAILED: '+$_.Exception.Message)
  exit 1
}
