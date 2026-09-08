param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference='Stop'
try {
  $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
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
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
 [StructLayout(LayoutKind.Sequential)] struct LastInput {public uint cbSize;public uint dwTime;}
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
 public static void Launch(string file,string parameters,string cwd){
  var baseline=GetForegroundWindow();var input=new LastInput();input.cbSize=(uint)Marshal.SizeOf(input);GetLastInputInfo(ref input);var baselineInput=input.dwTime;
  var s=new Startup();s.cb=Marshal.SizeOf(s);s.flags=1;s.show=4;ProcessInfo p;
  if(!CreateProcessW(file,new System.Text.StringBuilder("\""+file+"\" "+parameters),IntPtr.Zero,IntPtr.Zero,false,0x10,IntPtr.Zero,cwd,ref s,out p))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  CloseHandle(p.thread);CloseHandle(p.process);
  var until=Environment.TickCount+2500;
  while(Environment.TickCount<until){
   var now=new LastInput();now.cbSize=(uint)Marshal.SizeOf(now);GetLastInputInfo(ref now);
   if(now.dwTime!=baselineInput)break;
   if(baseline!=IntPtr.Zero&&GetForegroundWindow()!=baseline)SetForegroundWindow(baseline);
   System.Threading.Thread.Sleep(20);
  }
 }
}
'@
  [OrchestratorInactiveShell]::Launch([string]$request.file,[string]$request.parameters,[string]$request.cwd)
} catch {
  [Console]::Error.WriteLine('INACTIVE_WINDOW_LAUNCH_FAILED: '+$_.Exception.Message)
  exit 1
}
