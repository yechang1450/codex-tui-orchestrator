param([string]$Workspace=(Get-Location).Path,[string]$Terminal,[switch]$Legacy)
$ErrorActionPreference='Stop'
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
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
 public static IntPtr Find(string title){IntPtr found=IntPtr.Zero;EnumWindows((w,p)=>{var s=new StringBuilder(1024);var c=new StringBuilder(256);GetWindowText(w,s,1024);GetClassName(w,c,256);if(s.ToString().Contains(title)&&(c.ToString()=="CASCADIA_HOSTING_WINDOW_CLASS"||c.ToString()=="ConsoleWindowClass"))found=w;return true;},IntPtr.Zero);return found;}
}
'@
$root=Join-Path $Workspace ('temp\inactive-window-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$title='ORCH-INACTIVE-'+[Guid]::NewGuid().ToString('N')
$probe=Join-Path $root 'probe.ps1'
$receipt=Join-Path $root 'receipt.json'
$escaped=$receipt.Replace("'","''")
[IO.File]::WriteAllText($probe,"`$Host.UI.RawUI.WindowTitle='$title'; [IO.File]::WriteAllText('$escaped','{`"executed`":true}'); Start-Sleep -Seconds 8",[Text.UTF8Encoding]::new($false))
$repo=Split-Path $PSScriptRoot -Parent
$wt=Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
if($Terminal){$wt=$Terminal}
$request=@{file=$wt;parameters=('-w "'+$title+'" new-tab --title "'+$title+'" --suppressApplicationTitle powershell.exe -NoProfile -File "'+$probe+'"');cwd=$Workspace} | ConvertTo-Json -Compress
if($Legacy){$request=@{file=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe');parameters=('-NoProfile -File "'+$probe+'"');cwd=$Workspace} | ConvertTo-Json -Compress}
$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($request))
$hook=[InactiveWindowProbe]::SetWinEventHook(3,3,[IntPtr]::Zero,[InactiveWindowProbe]::Callback,0,0,0)
if($hook -eq [IntPtr]::Zero){throw 'Cannot monitor foreground events'}
$seen=[IntPtr]::Zero;$visible=$false;$minimized=$false;$samples=0;$foregroundSamples=0;$startedTick=[Environment]::TickCount;$baseline=[InactiveWindowProbe]::GetForegroundWindow().ToInt64()
try {
 & (Join-Path $repo 'scripts\core\inactive-window.ps1') -Payload $payload
 $until=[DateTime]::UtcNow.AddSeconds(20)
 while([DateTime]::UtcNow -lt $until){
  [Windows.Forms.Application]::DoEvents()
  $window=[InactiveWindowProbe]::Find($title)
  if($window -ne [IntPtr]::Zero){$seen=$window;$visible=$visible -or [InactiveWindowProbe]::IsWindowVisible($window);$minimized=$minimized -or [InactiveWindowProbe]::IsIconic($window);if([InactiveWindowProbe]::GetForegroundWindow() -eq $window){$foregroundSamples++}}
  elseif($seen -ne [IntPtr]::Zero){break}
  $samples++;Start-Sleep -Milliseconds 5
 }
 [Windows.Forms.Application]::DoEvents()
 $activations=@([InactiveWindowProbe]::Events | Where-Object {$_ -eq $seen.ToInt64()}).Count
 $targetForegroundEvents=@([InactiveWindowProbe]::Details | Where-Object {$parts=$_ -split ':'; $parts[0] -eq [string]$seen.ToInt64() -and $parts[2] -eq ('actual='+$seen.ToInt64())}).Count
 $startupEvents=@([InactiveWindowProbe]::Details | Where-Object {$parts=$_ -split ':'; $parts[0] -eq [string]$seen.ToInt64() -and ([long]$parts[1]-$startedTick) -lt 3000}).Count
 # A user may deliberately click the visible window later. That is supported;
 # distinguish those later activations from the initial launch phase.
 $passed=$seen -ne [IntPtr]::Zero -and $visible -and -not $minimized -and $targetForegroundEvents -eq 0 -and $foregroundSamples -eq 0 -and (Test-Path -LiteralPath $receipt) -and [InactiveWindowProbe]::Find($title) -eq [IntPtr]::Zero
 $report=@{passed=$passed;root=$root;startedTick=$startedTick;endTick=[Environment]::TickCount;baseline=$baseline;visible=$visible;minimized=$minimized;startupForegroundEvents=$startupEvents;foregroundEvents=$activations;targetForegroundEvents=$targetForegroundEvents;foregroundSamples=$foregroundSamples;samples=$samples;events=@([InactiveWindowProbe]::Details);hwnd=$seen.ToInt64();closed=([InactiveWindowProbe]::Find($title) -eq [IntPtr]::Zero)}
 $json=$report | ConvertTo-Json -Compress
 [IO.File]::WriteAllText((Join-Path $root 'report.json'),$json,[Text.UTF8Encoding]::new($false));Write-Output $json
 if(-not $passed){throw 'Inactive window acceptance failed'}
} finally {[InactiveWindowProbe]::UnhookWinEvent($hook) | Out-Null}
