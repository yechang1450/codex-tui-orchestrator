param([string]$Workspace=(Get-Location).Path,[string]$Terminal,[string]$NodePath,[switch]$Legacy,[switch]$ContinuousInput,[switch]$SystemDefaultConsole)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
if(-not $env:PATHEXT){$env:PATHEXT='.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'}
function ConvertTo-InactiveProbeNativeArgument {
 param([AllowEmptyString()][string]$Value)
 $result=[Text.StringBuilder]::new();[void]$result.Append('"');$slashes=0
 foreach($character in $Value.ToCharArray()){
  if([int][char]$character -eq 92){$slashes++;continue}
  if($character -eq '"'){[void]$result.Append(([string][char]92*(2*$slashes+1)));[void]$result.Append('"')}
  else {[void]$result.Append(([string][char]92*$slashes));[void]$result.Append($character)}
  $slashes=0
 }
 [void]$result.Append(([string][char]92*(2*$slashes)));[void]$result.Append('"');return $result.ToString()
}
function Set-InactiveProbeArguments {
 param([Diagnostics.ProcessStartInfo]$Info,[AllowEmptyCollection()][string[]]$ArgumentList=@())
 if($Info.PSObject.Properties.Name -contains 'ArgumentList'){
  foreach($argument in $ArgumentList){[void]$Info.ArgumentList.Add($argument)}
 } else {$Info.Arguments=(($ArgumentList|ForEach-Object{ConvertTo-InactiveProbeNativeArgument $_}) -join ' ')}
}
function Resolve-InactiveProbeLocalPath {
 param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Label,[switch]$Directory)
 if([string]::IsNullOrWhiteSpace($Path) -or $Path.IndexOf([char]0) -ge 0 -or $Path -notmatch '^[A-Za-z]:[\\/]'){throw "Inactive probe $Label must be a local drive-qualified path"}
 $full=[IO.Path]::GetFullPath($Path)
 if($full -notmatch '^[A-Za-z]:\\' -or $full.Substring(2).Contains(':')){throw "Inactive probe $Label must be a local drive-qualified path"}
 try {$item=Get-Item -LiteralPath $full -Force} catch {throw "Inactive probe $Label is unavailable"}
 if($Directory){if(-not $item.PSIsContainer){throw "Inactive probe $Label must be a directory"}}
 elseif($item.PSIsContainer){throw "Inactive probe $Label must be a regular file"}
 $current=$full
 while($true){
  try {$entry=Get-Item -LiteralPath $current -Force} catch {throw "Inactive probe $Label is unavailable"}
  if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "Inactive probe $Label contains a reparse point"}
  $parent=[IO.Directory]::GetParent($current)
  if($null -eq $parent -or $parent.FullName -eq $current){break}
  $current=$parent.FullName
 }
 return $full
}
function Test-InactiveProbeOutsideWorkspace {
 param([Parameter(Mandatory)][string]$Candidate,[Parameter(Mandatory)][string]$Workspace)
 $candidateFull=[IO.Path]::GetFullPath($Candidate).TrimEnd('\')
 $workspaceFull=[IO.Path]::GetFullPath($Workspace).TrimEnd('\')
 if($candidateFull -ieq $workspaceFull){return $false}
 return -not $candidateFull.StartsWith($workspaceFull+'\',[StringComparison]::OrdinalIgnoreCase)
}
function Get-InactiveProbeArtifacts {
 param([Parameter(Mandatory)][string]$Json,[Parameter(Mandatory)][string]$Workspace)
 if([Text.Encoding]::UTF8.GetByteCount($Json) -lt 1 -or [Text.Encoding]::UTF8.GetByteCount($Json) -gt 16384){throw 'Inactive window adapter artifact response is invalid'}
 try {$record=$Json.Trim() | ConvertFrom-Json} catch {throw 'Inactive window adapter artifact response is invalid'}
 $names=@($record.PSObject.Properties.Name | Sort-Object)
 if($record -is [Array] -or ($names -join ',') -cne 'ok,receipt,report,version' -or $record.version -ne 3 -or $record.ok -isnot [bool] -or -not $record.ok -or $record.receipt -isnot [string] -or $record.report -isnot [string]){throw 'Inactive window adapter artifact response is invalid'}
 $receipt=Resolve-InactiveProbeLocalPath -Path $record.receipt -Label 'protected receipt'
 $report=Resolve-InactiveProbeLocalPath -Path $record.report -Label 'protected report'
 if($receipt -ieq $report -or -not (Test-InactiveProbeOutsideWorkspace -Candidate $receipt -Workspace $Workspace) -or -not (Test-InactiveProbeOutsideWorkspace -Candidate $report -Workspace $Workspace)){throw 'Inactive window adapter artifact response is invalid'}
 return [PSCustomObject]@{receipt=$receipt;report=$report}
}
function Resolve-InactiveProbeNode {
 param([string]$Override)
 $candidate=if($Override){$Override}else{Join-Path ([InactiveWindowKnownFolders]::Profile()) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
 $node=Resolve-InactiveProbeLocalPath -Path $candidate -Label 'Node executable'
 if([IO.Path]::GetFileName($node) -ine 'node.exe'){throw 'Inactive probe Node executable must be named node.exe'}
 return $node
}
function Get-InactiveProbeNodeEnvironment {
 $profile=Resolve-InactiveProbeLocalPath -Path ([InactiveWindowKnownFolders]::Profile()) -Label 'profile directory' -Directory
 $systemRoot=Resolve-InactiveProbeLocalPath -Path ([InactiveWindowKnownFolders]::WindowsDirectory()) -Label 'Windows directory' -Directory
 $systemDirectory=Resolve-InactiveProbeLocalPath -Path (Join-Path $systemRoot 'System32') -Label 'Windows system directory' -Directory
 $localAppData=Resolve-InactiveProbeLocalPath -Path ([InactiveWindowKnownFolders]::LocalAppData()) -Label 'local application data' -Directory
 $command=Resolve-InactiveProbeLocalPath -Path (Join-Path $systemDirectory 'cmd.exe') -Label 'Windows command processor'
 $homeDrive=$profile.Substring(0,2);$homePath=$profile.Substring(2)
 if($homeDrive -notmatch '^[A-Za-z]:$' -or [string]::IsNullOrWhiteSpace($homePath)){throw 'Inactive probe profile directory is invalid'}
 return [ordered]@{SystemRoot=$systemRoot;WINDIR=$systemRoot;ComSpec=$command;PATHEXT='.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL';Path=($systemDirectory+';'+$systemRoot);LOCALAPPDATA=$localAppData;USERPROFILE=$profile;HOMEDRIVE=$homeDrive;HOMEPATH=$homePath}
}
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class InactiveWindowKnownFolders {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SHGetKnownFolderPath(ref Guid id,uint flags,IntPtr token,out IntPtr value);
 [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr value);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetWindowsDirectory(StringBuilder value,uint size);
 static string Known(string text){var id=new Guid(text);IntPtr value=IntPtr.Zero;var hr=SHGetKnownFolderPath(ref id,0,IntPtr.Zero,out value);if(hr<0||value==IntPtr.Zero)throw new InvalidOperationException("known folder unavailable");try{var path=Marshal.PtrToStringUni(value);if(String.IsNullOrWhiteSpace(path))throw new InvalidOperationException("known folder unavailable");return path;}finally{CoTaskMemFree(value);}}
 public static string Profile(){return Known("5E6C858F-0E22-4760-9AFE-EA3317B67173");}
 public static string LocalAppData(){return Known("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");}
 public static string WindowsDirectory(){var value=new StringBuilder(32768);var length=GetWindowsDirectory(value,(uint)value.Capacity);if(length==0||length>=value.Capacity)throw new InvalidOperationException("Windows directory unavailable");return value.ToString();}
}
public static class InactiveWindowProbe {
 public delegate void EventProc(IntPtr h,uint e,IntPtr w,int o,int c,uint t,uint ms);
 public delegate bool EnumProc(IntPtr w,IntPtr p);
 public static List<long> Events=new List<long>();
 public static List<string> Details=new List<string>();
 public static EventProc Callback=(h,e,w,o,c,t,ms)=>{Events.Add(w.ToInt64());Details.Add(w.ToInt64()+":"+ms+":actual="+GetForegroundWindow().ToInt64()+":now="+Environment.TickCount);};
 [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint a,uint b,IntPtr m,EventProc p,uint process,uint thread,uint flags);
 [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr w,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr w,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
 public static string Class(IntPtr w){var c=new StringBuilder(256);GetClassName(w,c,256);return c.ToString();}
 public static IntPtr Find(string title){IntPtr found=IntPtr.Zero;EnumWindows((w,p)=>{var s=new StringBuilder(1024);var c=new StringBuilder(256);GetWindowText(w,s,1024);GetClassName(w,c,256);if(s.ToString().Contains(title)&&(c.ToString()=="CASCADIA_HOSTING_WINDOW_CLASS"||c.ToString()=="ConsoleWindowClass"))found=w;return true;},IntPtr.Zero);return found;}
}
'@
$node=Resolve-InactiveProbeNode -Override $NodePath
if($ContinuousInput -and (-not [Environment]::UserInteractive -or [Threading.Thread]::CurrentThread.ApartmentState -ne 'STA')){
 @{passed=$false;skipped=$true;reason='continuous-input probe requires an interactive STA Windows desktop';inputMode=$true;nodePath=$node} | ConvertTo-Json -Compress
 exit 0
}
Add-Type -AssemblyName System.Windows.Forms
$Workspace=Resolve-InactiveProbeLocalPath -Path $Workspace -Label 'workspace' -Directory
$title='ORCH-INACTIVE-'+[Guid]::NewGuid().ToString('N')
$initiator=$null;$inputBox=$null;$inputAttempts=0;$inputDelivered=0;$inputDuringLaunch=0;$inputLostFocus=$false;$inputLossHwnd=$null;$inputError=$null;$inputReady=(-not $ContinuousInput);$helper=$null;$hook=[IntPtr]::Zero
try {
 if($ContinuousInput){
  # This is an opt-in, synthetic-input probe. It creates an owned WinForms
  # initiator and stops sending as soon as it observes loss of ownership.
  $initiator=New-Object Windows.Forms.Form
  $initiator.Text='ORCH-INITIATOR-'+[Guid]::NewGuid().ToString('N')
  $initiator.StartPosition='CenterScreen';$initiator.Width=480;$initiator.Height=120
  $initiator.ShowInTaskbar=$true
  $inputBox=New-Object Windows.Forms.TextBox
  $inputBox.Dock='Fill';$inputBox.Multiline=$true;$inputBox.ReadOnly=$false
  $initiator.Controls.Add($inputBox)
  $initiator.Show();$initiator.Activate();$inputBox.Focus() | Out-Null
  [InactiveWindowProbe]::SetForegroundWindow($initiator.Handle) | Out-Null
  $readyUntil=[DateTime]::UtcNow.AddSeconds(3)
  while([DateTime]::UtcNow -lt $readyUntil){
   [Windows.Forms.Application]::DoEvents()
   if([InactiveWindowProbe]::GetForegroundWindow() -eq $initiator.Handle -and $inputBox.Focused){$inputReady=$true;break}
   Start-Sleep -Milliseconds 10
  }
 }
 $receiptNonce=[Guid]::NewGuid().ToString('N')
 # Keep the executable body in memory until it crosses the adapter's stdin
 # boundary. The adapter verifies its digest and writes the only launchable
 # copy under the protected controller root, then allocates the receipt and
 # report there as well. The target receives only the protected receipt path.
 $scriptText="param([Parameter(Mandatory=`$true)][string]`$ReceiptPath)`n`$Host.UI.RawUI.WindowTitle='$title'; try { @{executed=`$true;title='$title';cwd=(Get-Location).Path;nonce='$receiptNonce'} | ConvertTo-Json | Set-Content -LiteralPath `$ReceiptPath -Encoding UTF8; Start-Sleep -Seconds 8 } finally { Remove-Item -LiteralPath `$PSCommandPath -Force -ErrorAction SilentlyContinue }"
 $scriptBytes=[Text.Encoding]::UTF8.GetBytes($scriptText)
 $hasher=[Security.Cryptography.SHA256]::Create()
 try {$scriptSha256=([BitConverter]::ToString($hasher.ComputeHash($scriptBytes))).Replace('-','').ToLowerInvariant()} finally {$hasher.Dispose()}
 $scriptBase64=[Convert]::ToBase64String($scriptBytes)
 $repo=Resolve-InactiveProbeLocalPath -Path (Split-Path $PSScriptRoot -Parent) -Label 'probe repository' -Directory
 $targetLauncher='windows-terminal';$targetFile=$null;$targetArgs=@('-w',$title,'new-tab','-d',$Workspace,'--title',$title,'--suppressApplicationTitle')
 if($Terminal){$targetLauncher='explicit-terminal';$targetFile=$Terminal}
 if($SystemDefaultConsole){$targetLauncher='system-console';$targetFile=$null;$targetArgs=@()}
 if($Legacy){$targetLauncher='legacy-console';$targetFile=$null;$targetArgs=@()}
 $request=[ordered]@{version=3;launcher=$targetLauncher;file=$targetFile;args=$targetArgs;scriptBase64=$scriptBase64;scriptSha256=$scriptSha256;cwd=$Workspace}
 $requestJson=$request | ConvertTo-Json -Compress
 if([Text.Encoding]::UTF8.GetByteCount($requestJson) -gt 131072){throw 'Inactive window adapter request is too large'}
 $adapter=Resolve-InactiveProbeLocalPath -Path (Join-Path $PSScriptRoot 'live-inactive-window-adapter.mjs') -Label 'Node adapter'
 $nodeEnvironment=Get-InactiveProbeNodeEnvironment
 $hook=[InactiveWindowProbe]::SetWinEventHook(3,3,[IntPtr]::Zero,[InactiveWindowProbe]::Callback,0,0,0)
 if($hook -eq [IntPtr]::Zero){throw 'Cannot monitor foreground events'}
 $seen=[IntPtr]::Zero;$windowClass=$null;$visible=$false;$minimized=$false;$samples=0;$foregroundSamples=0;$startedTick=[Environment]::TickCount;$baseline=[InactiveWindowProbe]::GetForegroundWindow().ToInt64()
 if(-not $inputReady){
  $json=@{passed=$false;skipped=$true;reason='owned initiator did not acquire foreground before launch';inputMode=$true;inputReady=$false;inputAttempts=0;inputDelivered=0;inputDuringLaunch=0;initiatorVisible=[InactiveWindowProbe]::IsWindowVisible($initiator.Handle);initiatorHwnd=$initiator.Handle.ToInt64();foregroundHwnd=[InactiveWindowProbe]::GetForegroundWindow().ToInt64();textBoxFocused=$inputBox.Focused} | ConvertTo-Json -Compress
  Write-Output $json
  exit 2
 }
 # Keep the probe message pump running throughout helper compilation and launch.
 # Synchronous invocation used to miss the entire startup/input boundary.
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=$node
 Set-InactiveProbeArguments $start @($adapter)
 $start.WorkingDirectory=$repo;$start.UseShellExecute=$false
 $start.CreateNoWindow=$true;$start.WindowStyle='Hidden'
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $start.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
 $start.EnvironmentVariables.Clear()
 foreach($entry in $nodeEnvironment.GetEnumerator()){$start.EnvironmentVariables[$entry.Key]=$entry.Value}
 $helper=[Diagnostics.Process]::Start($start)
 try {$helper.StandardInput.Write($requestJson);$helper.StandardInput.Close()} catch {if($helper -and -not $helper.HasExited){$helper.Kill();$helper.WaitForExit()};throw}
 $until=[DateTime]::UtcNow.AddSeconds(20)
 while([DateTime]::UtcNow -lt $until){
  [Windows.Forms.Application]::DoEvents()
  if($inputBox){$inputDelivered=$inputBox.Text.Length;if(-not $helper.HasExited){$inputDuringLaunch=$inputDelivered}}
  # Stop sending once the target window has exited: the final attempt would otherwise
  # land on a text box that is being torn down and skew inputAttempts vs inputDelivered.
  if($ContinuousInput -and $inputBox -and -not $inputLostFocus -and -not $inputError -and -not $helper.HasExited){
   if([InactiveWindowProbe]::GetForegroundWindow() -ne $initiator.Handle -or -not $inputBox.Focused){
    # Disarm permanently on focus loss; never send subsequent keys elsewhere.
    $inputLostFocus=$true;$inputLossHwnd=[InactiveWindowProbe]::GetForegroundWindow().ToInt64()
   } else {
    try {
     $inputAttempts++
     $launching=-not $helper.HasExited
     [Windows.Forms.SendKeys]::SendWait('.')
     [Windows.Forms.Application]::DoEvents()
     $inputDelivered=$inputBox.Text.Length
     if($launching){$inputDuringLaunch=$inputDelivered}
     if([InactiveWindowProbe]::GetForegroundWindow() -ne $initiator.Handle){$inputLostFocus=$true;$inputLossHwnd=[InactiveWindowProbe]::GetForegroundWindow().ToInt64()}
    } catch {$inputError=$_.Exception.Message}
   }
  }
  $window=[InactiveWindowProbe]::Find($title)
  if($window -ne [IntPtr]::Zero){$seen=$window;$windowClass=[InactiveWindowProbe]::Class($window);$visible=$visible -or [InactiveWindowProbe]::IsWindowVisible($window);$minimized=$minimized -or [InactiveWindowProbe]::IsIconic($window);if([InactiveWindowProbe]::GetForegroundWindow() -eq $window){$foregroundSamples++}}
  elseif($seen -ne [IntPtr]::Zero){break}
  $samples++;Start-Sleep -Milliseconds 5
 }
 [Windows.Forms.Application]::DoEvents()
 if($inputBox){$inputDelivered=$inputBox.Text.Length}
 $activations=@([InactiveWindowProbe]::Events | Where-Object {$_ -eq $seen.ToInt64()}).Count
 $targetForegroundEvents=@([InactiveWindowProbe]::Details | Where-Object {$parts=$_ -split ':'; $parts[0] -eq [string]$seen.ToInt64() -and $parts[2] -eq ('actual='+$seen.ToInt64())}).Count
 $startupEvents=@([InactiveWindowProbe]::Details | Where-Object {$parts=$_ -split ':'; $parts[0] -eq [string]$seen.ToInt64() -and ([long]$parts[1]-$startedTick) -lt 3000}).Count
 # A user may deliberately click the visible window later. That is supported;
 # distinguish those later activations from the initial launch phase.
 $receiptPath=$null;$reportPath=$null;$adapterError=$null;$helperExitCode=$null;$helperError=$null
 if($helper.HasExited){
  $helperExitCode=$helper.ExitCode;$helperError=$helper.StandardError.ReadToEnd()
  try {
   if($helperExitCode -ne 0){throw 'adapter did not complete'}
   $artifacts=Get-InactiveProbeArtifacts -Json $helper.StandardOutput.ReadToEnd() -Workspace $Workspace
   $receiptPath=$artifacts.receipt;$reportPath=$artifacts.report
  } catch {$adapterError='protected adapter artifact response is invalid'}
 }
 $receiptData=$null;$receiptError=$null
 if($receiptPath){try {$receiptData=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json} catch {$receiptError='protected receipt is unavailable'}}
 else {$receiptError='protected receipt path is unavailable'}
 $receiptValid=$receiptData -and $receiptData.executed -eq $true -and $receiptData.title -ceq $title -and $receiptData.nonce -ceq $receiptNonce -and $receiptData.cwd -eq (Resolve-Path -LiteralPath $Workspace).Path
 $inputOk=(-not $ContinuousInput) -or ($inputReady -and $inputDuringLaunch -gt 0 -and $inputDelivered -eq $inputAttempts -and -not $inputLostFocus -and -not $inputError)
 $passed=$seen -ne [IntPtr]::Zero -and $visible -and -not $minimized -and $targetForegroundEvents -eq 0 -and $foregroundSamples -eq 0 -and $receiptValid -and $receiptPath -and $reportPath -and -not $adapterError -and $helperExitCode -eq 0 -and [InactiveWindowProbe]::Find($title) -eq [IntPtr]::Zero -and $inputOk
 $report=@{passed=$passed;skipped=$false;startedTick=$startedTick;endTick=[Environment]::TickCount;baseline=$baseline;visible=$visible;minimized=$minimized;startupForegroundEvents=$startupEvents;foregroundEvents=$activations;targetForegroundEvents=$targetForegroundEvents;foregroundSamples=$foregroundSamples;samples=$samples;events=@([InactiveWindowProbe]::Details);hwnd=$seen.ToInt64();closed=([InactiveWindowProbe]::Find($title) -eq [IntPtr]::Zero);inputMode=([bool]$ContinuousInput);inputReady=$inputReady;inputAttempts=$inputAttempts;inputDuringLaunch=$inputDuringLaunch;inputDelivered=$inputDelivered;inputLostFocus=$inputLostFocus;inputError=$inputError;receiptValid=([bool]$receiptValid);receiptError=$receiptError;adapterError=$adapterError;helperExitCode=$helperExitCode;helperError=$helperError}
 $report.windowClass=$windowClass
 $report.inputLossHwnd=$inputLossHwnd
 $json=$report | ConvertTo-Json -Compress
 if($reportPath){[IO.File]::WriteAllText($reportPath,$json,[Text.UTF8Encoding]::new($false))}
 Write-Output $json
 if(-not $passed){throw 'Inactive window acceptance failed'}
} finally {
 if($helper){try{if(-not $helper.HasExited){$helper.Kill();$helper.WaitForExit()}}catch{}finally{$helper.Dispose()}}
 if($initiator){try{$initiator.Close()}catch{}finally{$initiator.Dispose()}}
 if($hook -ne [IntPtr]::Zero){[InactiveWindowProbe]::UnhookWinEvent($hook) | Out-Null}
}
