param([string]$Workspace=(Get-Location).Path,[string]$Terminal,[switch]$Legacy,[switch]$ContinuousInput,[switch]$SystemDefaultConsole)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
if(-not $env:PATHEXT){$env:PATHEXT='.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'}
try { chcp 65001 | Out-Null } catch { }
if($ContinuousInput -and (-not [Environment]::UserInteractive -or [Threading.Thread]::CurrentThread.ApartmentState -ne 'STA')){
 @{passed=$false;skipped=$true;reason='continuous-input probe requires an interactive STA Windows desktop';inputMode=$true} | ConvertTo-Json -Compress
 exit 0
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
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
$root=Join-Path $Workspace ('temp\inactive-window-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$title='ORCH-INACTIVE-'+[Guid]::NewGuid().ToString('N')
$initiator=$null;$inputBox=$null;$inputAttempts=0;$inputDelivered=0;$inputDuringLaunch=0;$inputLostFocus=$false;$inputLossHwnd=$null;$inputError=$null;$inputReady=(-not $ContinuousInput);$helper=$null
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
$probe=Join-Path $root 'probe.ps1'
$receipt=Join-Path $root 'receipt.json'
$escaped=$receipt.Replace("'","''")
[IO.File]::WriteAllText($probe,"`$Host.UI.RawUI.WindowTitle='$title'; @{executed=`$true;title='$title';cwd=(Get-Location).Path} | ConvertTo-Json | Set-Content -LiteralPath '$escaped' -Encoding UTF8; Start-Sleep -Seconds 8",[Text.UTF8Encoding]::new($false))
$repo=Split-Path $PSScriptRoot -Parent
$wt=Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
if($Terminal){$wt=$Terminal}
$request=@{file=$wt;parameters=('-w "'+$title+'" new-tab -d "'+$Workspace+'" --title "'+$title+'" --suppressApplicationTitle powershell.exe -NoProfile -File "'+$probe+'"');cwd=$Workspace} | ConvertTo-Json -Compress
if($Legacy -or $SystemDefaultConsole){
 $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 $request=@{file=$powershell;parameters=('-NoProfile -File "'+$probe+'"');cwd=$Workspace}
 if($Legacy){$request.file=Join-Path $env:SystemRoot 'System32\conhost.exe';$request.parameters='"'+$powershell+'" '+$request.parameters}
 $request=$request | ConvertTo-Json -Compress
}
$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($request))
$hook=[InactiveWindowProbe]::SetWinEventHook(3,3,[IntPtr]::Zero,[InactiveWindowProbe]::Callback,0,0,0)
if($hook -eq [IntPtr]::Zero){throw 'Cannot monitor foreground events'}
$seen=[IntPtr]::Zero;$windowClass=$null;$visible=$false;$minimized=$false;$samples=0;$foregroundSamples=0;$startedTick=[Environment]::TickCount;$baseline=[InactiveWindowProbe]::GetForegroundWindow().ToInt64()
try {
 if(-not $inputReady){
  $json=@{passed=$false;skipped=$true;reason='owned initiator did not acquire foreground before launch';inputMode=$true;inputReady=$false;inputAttempts=0;inputDelivered=0;inputDuringLaunch=0;initiatorVisible=[InactiveWindowProbe]::IsWindowVisible($initiator.Handle);initiatorHwnd=$initiator.Handle.ToInt64();foregroundHwnd=[InactiveWindowProbe]::GetForegroundWindow().ToInt64();textBoxFocused=$inputBox.Focused;root=$root} | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $root 'report.json'),$json,[Text.UTF8Encoding]::new($false));Write-Output $json
  exit 2
 }
 # Keep the probe message pump running throughout helper compilation and launch.
 # Synchronous invocation used to miss the entire startup/input boundary.
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 $start.Arguments='-NoProfile -NonInteractive -File "'+(Join-Path $repo 'scripts\core\inactive-window.ps1')+'" -Payload '+$payload
 $start.WorkingDirectory=$Workspace;$start.UseShellExecute=$false
 $start.CreateNoWindow=$true;$start.WindowStyle='Hidden'
 $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $helper=[Diagnostics.Process]::Start($start)
 $until=[DateTime]::UtcNow.AddSeconds(20)
 while([DateTime]::UtcNow -lt $until){
  [Windows.Forms.Application]::DoEvents()
  if($inputBox){$inputDelivered=$inputBox.Text.Length;if(-not $helper.HasExited){$inputDuringLaunch=$inputDelivered}}
  if($ContinuousInput -and $inputBox -and -not $inputLostFocus -and -not $inputError){
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
 $receiptData=$null;$receiptError=$null
 try {$receiptData=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json} catch {$receiptError=$_.Exception.Message}
 $receiptValid=$receiptData -and $receiptData.executed -eq $true -and $receiptData.title -ceq $title -and $receiptData.cwd -eq (Resolve-Path -LiteralPath $Workspace).Path
 $helperExitCode=$null;$helperError=$null
 if($helper.HasExited){$helperExitCode=$helper.ExitCode;$helperError=$helper.StandardError.ReadToEnd()}
 $inputOk=(-not $ContinuousInput) -or ($inputReady -and $inputDuringLaunch -gt 0 -and $inputDelivered -eq $inputAttempts -and -not $inputLostFocus -and -not $inputError)
 $passed=$seen -ne [IntPtr]::Zero -and $visible -and -not $minimized -and $targetForegroundEvents -eq 0 -and $foregroundSamples -eq 0 -and $receiptValid -and $helperExitCode -eq 0 -and [InactiveWindowProbe]::Find($title) -eq [IntPtr]::Zero -and $inputOk
 $report=@{passed=$passed;skipped=$false;root=$root;startedTick=$startedTick;endTick=[Environment]::TickCount;baseline=$baseline;visible=$visible;minimized=$minimized;startupForegroundEvents=$startupEvents;foregroundEvents=$activations;targetForegroundEvents=$targetForegroundEvents;foregroundSamples=$foregroundSamples;samples=$samples;events=@([InactiveWindowProbe]::Details);hwnd=$seen.ToInt64();closed=([InactiveWindowProbe]::Find($title) -eq [IntPtr]::Zero);inputMode=([bool]$ContinuousInput);inputReady=$inputReady;inputAttempts=$inputAttempts;inputDuringLaunch=$inputDuringLaunch;inputDelivered=$inputDelivered;inputLostFocus=$inputLostFocus;inputError=$inputError;receiptValid=([bool]$receiptValid);receiptError=$receiptError;helperExitCode=$helperExitCode;helperError=$helperError}
 $report.windowClass=$windowClass
 $report.inputLossHwnd=$inputLossHwnd
 $json=$report | ConvertTo-Json -Compress
 [IO.File]::WriteAllText((Join-Path $root 'report.json'),$json,[Text.UTF8Encoding]::new($false));Write-Output $json
 if(-not $passed){throw 'Inactive window acceptance failed'}
} finally {
 if($helper){if(-not $helper.HasExited){$helper.Kill();$helper.WaitForExit()};$helper.Dispose()}
 if($initiator){$initiator.Close();$initiator.Dispose()}
 [InactiveWindowProbe]::UnhookWinEvent($hook) | Out-Null
}
