[CmdletBinding()]
param()

$ErrorActionPreference='Stop'

function Write-Result($value) {
  [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 8))
}

function Write-Failure($code) {
  Write-Result ([ordered]@{ok=$false;version=1;code=$code})
  exit 0
}

function Request-String($value,$name) {
  if($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value) -or $value.Length -gt 32760){throw [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]::new('SAFE_WORKSPACE_READ_REQUEST')}
  return [string]$value
}

function Assert-OrdinaryWindowsPath($value) {
  $path=Request-String $value 'path'
  if($path.IndexOf([char]0) -ge 0 -or $path -match '^(?:\\\\[.?]|\\\?\\GLOBALROOT)'){throw [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]::new('SAFE_WORKSPACE_READ_PATH')}
  if($path -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\?)'){throw [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]::new('SAFE_WORKSPACE_READ_PATH')}
  if($path -match '^[A-Za-z]:.*:.+$' -or ($path -notmatch '^[A-Za-z]:' -and $path.Contains(':'))){throw [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]::new('SAFE_WORKSPACE_READ_ADS')}
  return [IO.Path]::GetFullPath($path)
}

if(-not ('TuiOrchestrator.SafeWorkspaceRead' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace TuiOrchestrator {
  public static class SafeWorkspaceRead {
    const uint GenericRead=0x80000000;
    const uint FileReadAttributes=0x00000080;
    const uint FileShareRead=0x00000001;
    const uint OpenExisting=3;
    const uint FileFlagOpenReparsePoint=0x00200000;
    const uint FileFlagBackupSemantics=0x02000000;
    const uint FileFlagSequentialScan=0x08000000;
    const uint FileAttributeDirectory=0x00000010;
    const uint FileAttributeReparsePoint=0x00000400;

    [StructLayout(LayoutKind.Sequential, Pack=4)]
    struct NativeFileTime { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential, Pack=4)]
    struct ByHandleFileInformation {
      public uint Attributes;
      public NativeFileTime CreationTime,LastAccessTime,LastWriteTime;
      public uint VolumeSerialNumber;
      public uint FileSizeHigh,FileSizeLow;
      public uint NumberOfLinks;
      public uint FileIndexHigh,FileIndexLow;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="CreateFileW",SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle,out ByHandleFileInformation information);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="GetFinalPathNameByHandleW",SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder buffer,uint capacity,uint flags);

    public sealed class SafeReadException : IOException {
      public readonly string Code;
      public SafeReadException(string code) : base(code) { Code=code; }
    }
    public sealed class RootBinding {
      public string volumeSerial {get;set;}
      public string fileIndex {get;set;}
      public string finalPath {get;set;}
    }
    public sealed class ReadResult {
      public long size {get;set;}
      public string sha256 {get;set;}
      public string textBase64 {get;set;}
    }

    static SafeReadException Fail(string code) { return new SafeReadException(code); }
    static SafeFileHandle Open(string path,uint access,uint flags) {
      SafeFileHandle handle=CreateFileW(path,access,FileShareRead,IntPtr.Zero,OpenExisting,flags,IntPtr.Zero);
      if(handle==null||handle.IsInvalid) { if(handle!=null)handle.Dispose(); throw Fail("SAFE_WORKSPACE_READ_OPEN"); }
      return handle;
    }
    static SafeFileHandle TryOpen(string path,uint access,uint flags) {
      SafeFileHandle handle=CreateFileW(path,access,FileShareRead,IntPtr.Zero,OpenExisting,flags,IntPtr.Zero);
      if(handle==null||handle.IsInvalid) {
        int error=Marshal.GetLastWin32Error();
        if(handle!=null)handle.Dispose();
        if(error==2||error==3)return null; // ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND
        throw Fail("SAFE_WORKSPACE_READ_OPEN");
      }
      return handle;
    }
    static ByHandleFileInformation Info(SafeFileHandle handle) {
      ByHandleFileInformation information;
      if(!GetFileInformationByHandle(handle,out information)) throw Fail("SAFE_WORKSPACE_READ_INFO");
      return information;
    }
    static string FinalPath(SafeFileHandle handle) {
      uint capacity=512;
      while(capacity<=65536) {
        StringBuilder value=new StringBuilder((int)capacity);
        uint written=GetFinalPathNameByHandle(handle,value,capacity,0);
        if(written==0)throw Fail("SAFE_WORKSPACE_READ_FINAL_PATH");
        if(written<capacity)return Normalize(value.ToString());
        capacity=written+1;
      }
      throw Fail("SAFE_WORKSPACE_READ_FINAL_PATH");
    }
    static string Normalize(string value) {
      if(value.StartsWith("\\\\?\\UNC\\",StringComparison.OrdinalIgnoreCase))value="\\\\"+value.Substring(8);
      else if(value.StartsWith("\\\\?\\",StringComparison.OrdinalIgnoreCase))value=value.Substring(4);
      if(value.Length>3)value=value.TrimEnd('\\');
      return value;
    }
    static string FileIndex(ByHandleFileInformation information) {
      return (((ulong)information.FileIndexHigh<<32)|information.FileIndexLow).ToString();
    }
    static string Volume(ByHandleFileInformation information) { return information.VolumeSerialNumber.ToString(); }
    static RootBinding Binding(ByHandleFileInformation information,string finalPath) {
      return new RootBinding {volumeSerial=Volume(information),fileIndex=FileIndex(information),finalPath=finalPath};
    }
    static void AssertRoot(SafeFileHandle handle,RootBinding expected) {
      ByHandleFileInformation information=Info(handle);
      if((information.Attributes&FileAttributeDirectory)==0||(information.Attributes&FileAttributeReparsePoint)!=0)throw Fail("SAFE_WORKSPACE_READ_ROOT");
      string finalPath=FinalPath(handle);
      if(expected!=null&&(!String.Equals(expected.volumeSerial,Volume(information),StringComparison.Ordinal)||!String.Equals(expected.fileIndex,FileIndex(information),StringComparison.Ordinal)||!String.Equals(Normalize(expected.finalPath??""),finalPath,StringComparison.OrdinalIgnoreCase)))throw Fail("SAFE_WORKSPACE_READ_ROOT_BINDING");
    }
    static void AssertTarget(SafeFileHandle handle) {
      ByHandleFileInformation information=Info(handle);
      if((information.Attributes&(FileAttributeDirectory|FileAttributeReparsePoint))!=0)throw Fail("SAFE_WORKSPACE_READ_TARGET");
      if(information.NumberOfLinks!=1)throw Fail("SAFE_WORKSPACE_READ_MULTIPLE_LINKS");
    }
    static void AssertDirectory(SafeFileHandle handle) {
      ByHandleFileInformation information=Info(handle);
      if((information.Attributes&FileAttributeReparsePoint)!=0)throw Fail("SAFE_WORKSPACE_READ_TARGET");
      if((information.Attributes&FileAttributeDirectory)==0)throw Fail("SAFE_WORKSPACE_READ_TARGET");
    }
    static bool ChildOf(string root,string target) {
      root=Normalize(root);target=Normalize(target);
      if(!root.EndsWith("\\",StringComparison.Ordinal))root+="\\";
      return target.StartsWith(root,StringComparison.OrdinalIgnoreCase);
    }
    public static RootBinding BindRoot(string root) {
      using(SafeFileHandle handle=Open(root,FileReadAttributes,FileFlagOpenReparsePoint|FileFlagBackupSemantics)) {
        AssertRoot(handle,null);
        return Binding(Info(handle),FinalPath(handle));
      }
    }
    public static ReadResult Read(string root,string target,RootBinding binding,long maxBytes,bool includeText) {
      if(maxBytes<1||maxBytes>67108864)throw Fail("SAFE_WORKSPACE_READ_LIMIT");
      using(SafeFileHandle rootHandle=Open(root,FileReadAttributes,FileFlagOpenReparsePoint|FileFlagBackupSemantics)) {
        AssertRoot(rootHandle,binding);
        string rootFinal=FinalPath(rootHandle);
        using(SafeFileHandle targetHandle=Open(target,GenericRead,FileFlagOpenReparsePoint|FileFlagBackupSemantics|FileFlagSequentialScan)) {
          AssertTarget(targetHandle);
          if(!ChildOf(rootFinal,FinalPath(targetHandle)))throw Fail("SAFE_WORKSPACE_READ_OUTSIDE_ROOT");
          ByHandleFileInformation initial=Info(targetHandle);
          ulong initialSize=((ulong)initial.FileSizeHigh<<32)|initial.FileSizeLow;
          if(initialSize>(ulong)maxBytes)throw Fail("SAFE_WORKSPACE_READ_LIMIT");
          using(FileStream stream=new FileStream(targetHandle,FileAccess.Read,65536,false)) {
            byte[] buffer=new byte[65536];long total=0;int count;
            MemoryStream text=includeText?new MemoryStream((int)initialSize):null;
            using(SHA256 sha=SHA256.Create()) {
              while((count=stream.Read(buffer,0,buffer.Length))>0) {
                total+=count;if(total>maxBytes)throw Fail("SAFE_WORKSPACE_READ_LIMIT");
                sha.TransformBlock(buffer,0,count,null,0);
                if(text!=null)text.Write(buffer,0,count);
              }
              sha.TransformFinalBlock(new byte[0],0,0);
              string payload=null;
              if(text!=null) {
                byte[] bytes=text.ToArray();
                try { new UTF8Encoding(false,true).GetString(bytes); } catch(DecoderFallbackException) { throw Fail("SAFE_WORKSPACE_READ_UTF8"); }
                payload=Convert.ToBase64String(bytes);text.Dispose();
              }
              return new ReadResult {size=total,sha256=BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant(),textBase64=payload};
            }
          }
        }
      }
    }
    // Absence is necessarily a point-in-time observation, but it must not
    // follow a workspace link while making that observation. Hold no-follow
    // handles on every existing component from the bound root to the first
    // missing one. FileShareRead prevents a new writer from replacing one of
    // those components during the probe.
    public static void AssertAbsent(string root,string target,RootBinding binding) {
      using(SafeFileHandle rootHandle=Open(root,FileReadAttributes,FileFlagOpenReparsePoint|FileFlagBackupSemantics)) {
        AssertRoot(rootHandle,binding);
        string rootFinal=FinalPath(rootHandle);
        string rootLex=Path.GetFullPath(root);
        if(!rootLex.EndsWith("\\",StringComparison.Ordinal))rootLex+="\\";
        string targetLex=Path.GetFullPath(target);
        if(!targetLex.StartsWith(rootLex,StringComparison.OrdinalIgnoreCase))throw Fail("SAFE_WORKSPACE_READ_OUTSIDE_ROOT");
        string relative=targetLex.Substring(rootLex.Length);
        if(String.IsNullOrEmpty(relative))throw Fail("SAFE_WORKSPACE_READ_EXISTS");
        string[] segments=relative.Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries);
        if(segments.Length==0)throw Fail("SAFE_WORKSPACE_READ_EXISTS");
        string current=rootFinal;
        var held=new List<SafeFileHandle>();
        try {
          for(int i=0;i<segments.Length;i++) {
            if(segments[i]=="."||segments[i]=="..")throw Fail("SAFE_WORKSPACE_READ_PATH");
            string candidate=Path.Combine(current,segments[i]);
            SafeFileHandle handle=TryOpen(candidate,FileReadAttributes,FileFlagOpenReparsePoint|FileFlagBackupSemantics);
            if(handle==null)return;
            held.Add(handle);
            ByHandleFileInformation information=Info(handle);
            if((information.Attributes&FileAttributeReparsePoint)!=0)throw Fail("SAFE_WORKSPACE_READ_TARGET");
            string finalPath=FinalPath(handle);
            if(!ChildOf(rootFinal,finalPath))throw Fail("SAFE_WORKSPACE_READ_OUTSIDE_ROOT");
            if(i==segments.Length-1)throw Fail("SAFE_WORKSPACE_READ_EXISTS");
            if((information.Attributes&FileAttributeDirectory)==0)throw Fail("SAFE_WORKSPACE_READ_TARGET");
            current=finalPath;
          }
        } finally {
          for(int i=held.Count-1;i>=0;i--)held[i].Dispose();
        }
      }
    }
  }
}
'@ -ErrorAction Stop
}

try {
  $raw=[Console]::In.ReadToEnd()
  if([string]::IsNullOrWhiteSpace($raw)){throw [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]::new('SAFE_WORKSPACE_READ_REQUEST')}
  $request=$raw | ConvertFrom-Json -ErrorAction Stop
  if($request.version -ne 1){throw [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]::new('SAFE_WORKSPACE_READ_REQUEST')}
  $root=Assert-OrdinaryWindowsPath $request.root
  if($request.operation -eq 'bind-root') {
    $binding=[TuiOrchestrator.SafeWorkspaceRead]::BindRoot($root)
    Write-Result ([ordered]@{ok=$true;version=1;binding=$binding})
    exit 0
  }
  if($request.operation -notin @('read-utf8','sha256','assert-absent')){throw [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]::new('SAFE_WORKSPACE_READ_REQUEST')}
  if($null -eq $request.binding){throw [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]::new('SAFE_WORKSPACE_READ_REQUEST')}
  $target=Assert-OrdinaryWindowsPath $request.target
  $max=[long]$request.maxBytes
  $binding=New-Object TuiOrchestrator.SafeWorkspaceRead+RootBinding
  $binding.volumeSerial=Request-String $request.binding.volumeSerial 'volumeSerial'
  $binding.fileIndex=Request-String $request.binding.fileIndex 'fileIndex'
  $binding.finalPath=Request-String $request.binding.finalPath 'finalPath'
  if($request.operation -eq 'assert-absent') {
    [TuiOrchestrator.SafeWorkspaceRead]::AssertAbsent($root,$target,$binding)
    Write-Result ([ordered]@{ok=$true;version=1})
    exit 0
  }
  $result=[TuiOrchestrator.SafeWorkspaceRead]::Read($root,$target,$binding,$max,$request.operation -eq 'read-utf8')
  $file=[ordered]@{size=$result.size;sha256=$result.sha256}
  if($request.operation -eq 'read-utf8'){$file.textBase64=$result.textBase64}
  Write-Result ([ordered]@{ok=$true;version=1;file=$file})
} catch {
  $code='SAFE_WORKSPACE_READ_FAILED';$current=$_.Exception
  while($null -ne $current) {
    if($current -is [TuiOrchestrator.SafeWorkspaceRead+SafeReadException]){$code=$current.Code;break}
    $current=$current.InnerException
  }
  Write-Failure $code
}
