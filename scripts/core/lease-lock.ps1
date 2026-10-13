param([string]$Directory,[string]$Ticket,[string]$Nonce,[int]$Owner,[string]$Started,[int]$WaitMs=120000,[int]$ReceiptAckWaitMs=5000,[Int64]$ReadyDeadlineAt=0,[string]$ReceiptPublicationBarrier='',[string]$ReceiptCleanupBarrier='')
$ErrorActionPreference='Stop'
$hash=[Security.Cryptography.SHA256]::Create()
$name='Local\TuiOrchestrator.Leases.'+[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Directory.ToLowerInvariant()))).Replace('-','')
$mutex=[Threading.Mutex]::new($false,$name)
$held=$false
$releaseAccepted=$false
$mutexReleased=$false
$readyPublished=$false
$utf8=[Text.UTF8Encoding]::new($false,$true)
$script:fileIdentityInteropState=0

function Test-NonceMarker([string]$Path,[string]$Prefix) {
  $parentHandle=$null
  try {
    $parentHandle=Open-SafeMarkerParent $Path
    if(-not [IO.File]::Exists($Path)){return $false}
    $item=Get-Item -LiteralPath $Path -Force
    if($item -isnot [IO.FileInfo] -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0 -or $item.Length -gt 128){return $false}
    $text=[IO.File]::ReadAllText($Path,$utf8)
    $verified=Get-Item -LiteralPath $Path -Force
    if($verified -isnot [IO.FileInfo] -or ($verified.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $verified.Length -ne $item.Length){return $false}
    return $text -ceq ($Prefix+':'+$Nonce)
  }catch{
    if(Test-UnsafeMarkerParentFailure $_.Exception){throw}
    return $false
  }finally{if($null -ne $parentHandle){$parentHandle.Dispose()}}
}

function Write-NonceMarker([string]$Path,[string]$Prefix) {
  $parentHandle=$null
  $stream=$null
  try {
    $parentHandle=Open-SafeMarkerParent $Path
    $bytes=$utf8.GetBytes($Prefix+':'+$Nonce)
    if($bytes.Length -le 0 -or $bytes.Length -gt 128){throw 'Invalid coordinator marker payload.'}
    # CreateNew refuses an already-present reparse point or hard link before
    # opening it, so this helper never follows or truncates a foreign target.
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $stream.Write($bytes,0,$bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream=$null
    if(-not (Test-NonceMarker $Path $Prefix)){throw 'Coordinator marker publication did not verify.'}
  } finally {
    if($null -ne $stream){$stream.Dispose()}
    if($null -ne $parentHandle){$parentHandle.Dispose()}
  }
}

function Initialize-LeaseFileIdentity {
  if($script:fileIdentityInteropState -eq 1){return $true}
  if($script:fileIdentityInteropState -eq -1){return $false}
  try {
    if($null -eq ('TuiOrchestrator.LeaseFileIdentity' -as [type])){
      Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace TuiOrchestrator {
  [StructLayout(LayoutKind.Sequential, Pack=4)]
  internal struct NativeFileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential, Pack=4)]
  internal struct ByHandleFileInformation {
    public uint Attributes;
    public NativeFileTime CreationTime;
    public NativeFileTime LastAccessTime;
    public NativeFileTime LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }
  public static class LeaseFileIdentity {
    const uint FileReadAttributes=0x00000080;
    const uint FileShareRead=0x00000001;
    const uint FileShareWrite=0x00000002;
    const uint FileShareDelete=0x00000004;
    const uint OpenExisting=3;
    const uint FileFlagOpenReparsePoint=0x00200000;
    const uint FileFlagBackupSemantics=0x02000000;
    const uint FileAttributeDirectory=0x00000010;
    const uint FileAttributeReparsePoint=0x00000400;
    const string UnsafeMarkerParentDataKey="TuiOrchestrator.UnsafeMarkerParent";
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, EntryPoint="CreateFileW", SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation information);
    static SafeFileHandle OpenNoFollow(string path) {
      SafeFileHandle handle=CreateFileW(path,FileReadAttributes,FileShareRead|FileShareWrite|FileShareDelete,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero);
      if(handle==null || handle.IsInvalid) {
        int error=Marshal.GetLastWin32Error();
        if(handle!=null) handle.Dispose();
        throw new Win32Exception(error);
      }
      return handle;
    }
    static SafeFileHandle OpenNoFollowDirectory(string path) {
      SafeFileHandle handle=CreateFileW(path,FileReadAttributes,FileShareRead|FileShareWrite,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint|FileFlagBackupSemantics,IntPtr.Zero);
      if(handle==null || handle.IsInvalid) {
        int error=Marshal.GetLastWin32Error();
        if(handle!=null) handle.Dispose();
        throw new Win32Exception(error);
      }
      return handle;
    }
    static ByHandleFileInformation Info(SafeFileHandle handle) {
      ByHandleFileInformation information;
      if(!GetFileInformationByHandle(handle,out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return information;
    }
    static bool IsRegular(ByHandleFileInformation information) {
      return (information.Attributes & (FileAttributeDirectory|FileAttributeReparsePoint))==0;
    }
    static IOException UnsafeMarkerParent() {
      IOException failure=new IOException("Unsafe coordinator marker parent.");
      failure.Data[UnsafeMarkerParentDataKey]=true;
      return failure;
    }
    public static SafeFileHandle OpenRegularDirectoryNoFollow(string path) {
      SafeFileHandle handle=OpenNoFollowDirectory(path);
      try {
        ByHandleFileInformation information=Info(handle);
        if((information.Attributes & FileAttributeDirectory)==0 || (information.Attributes & FileAttributeReparsePoint)!=0) throw UnsafeMarkerParent();
        return handle;
      } catch {
        handle.Dispose();
        throw;
      }
    }
    public static bool SameRegularHardLinkedFile(string left,string right) {
      using(SafeFileHandle a=OpenNoFollow(left))
      using(SafeFileHandle b=OpenNoFollow(right)) {
        ByHandleFileInformation ai=Info(a), bi=Info(b);
        return IsRegular(ai) && IsRegular(bi) &&
          ai.NumberOfLinks>=2 && bi.NumberOfLinks>=2 &&
          ai.VolumeSerialNumber==bi.VolumeSerialNumber &&
          ai.FileIndexHigh==bi.FileIndexHigh && ai.FileIndexLow==bi.FileIndexLow;
      }
    }
  }
}
'@ -ErrorAction Stop
    }
    $script:fileIdentityInteropState=1
    return $true
  }catch{$script:fileIdentityInteropState=-1;return $false}
}

function Test-UnsafeMarkerParentFailure([Exception]$Failure) {
  $current=$Failure
  while($null -ne $current) {
    try {
      if($null -ne $current.Data -and
         $current.Data.Contains('TuiOrchestrator.UnsafeMarkerParent') -and
         $current.Data['TuiOrchestrator.UnsafeMarkerParent'] -eq $true){return $true}
    }catch{}
    $current=$current.InnerException
  }
  return $false
}

function Test-SameAttemptReceiptHardLink([string]$Receipt,[string]$Acknowledgement) {
  $receiptParent=$null
  $acknowledgementParent=$null
  try {
    $receiptParent=Open-SafeMarkerParent $Receipt
    $acknowledgementParent=Open-SafeMarkerParent $Acknowledgement
    if(-not (Initialize-LeaseFileIdentity)){return $false}
    return [TuiOrchestrator.LeaseFileIdentity]::SameRegularHardLinkedFile($Receipt,$Acknowledgement)
  }catch{
    if(Test-UnsafeMarkerParentFailure $_.Exception){throw}
    return $false
  }finally{
    if($null -ne $acknowledgementParent){$acknowledgementParent.Dispose()}
    if($null -ne $receiptParent){$receiptParent.Dispose()}
  }
}

function Open-SafeMarkerParent([string]$Path) {
  $parent=[IO.Path]::GetDirectoryName($Path)
  if([string]::IsNullOrWhiteSpace($parent)){throw 'Unsafe coordinator marker parent.'}
  if(-not (Initialize-LeaseFileIdentity)){throw 'Coordinator marker parent validation is unavailable.'}
  return [TuiOrchestrator.LeaseFileIdentity]::OpenRegularDirectoryNoFollow($parent)
}

function Remove-AttemptMarker([string]$Path) {
  $parentHandle=$null
  try {
    $parentHandle=Open-SafeMarkerParent $Path
    # Never delete through a replaced parent junction. The helper owns only
    # markers in its original non-reparse coordinator directory.
    if(-not [IO.File]::Exists($Path)){return}
    $item=Get-Item -LiteralPath $Path -Force
    if($item -is [IO.FileInfo] -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){[IO.File]::Delete($Path)}
  }catch{
    if(Test-UnsafeMarkerParentFailure $_.Exception){throw}
  }finally{if($null -ne $parentHandle){$parentHandle.Dispose()}}
}

function Wait-ForReceiptCleanupBarrier {
  # Direct test fixtures may hold receipt cleanup until they have inspected the
  # hard-link acknowledgement. Production never passes this optional path.
  if([string]::IsNullOrWhiteSpace($ReceiptCleanupBarrier)){return}
  $deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+30000
  while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
    try {
      if([IO.File]::Exists($ReceiptCleanupBarrier)){
        $item=Get-Item -LiteralPath $ReceiptCleanupBarrier -Force
        if($item -is [IO.FileInfo] -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){return}
      }
    }catch{}
    Start-Sleep -Milliseconds 10
  }
}

function Wait-ForReceiptPublicationBarrier {
  # Direct test fixtures can hold publication after ReleaseMutex so a queued
  # contender proves the runtime ordering. Production never passes this path.
  if([string]::IsNullOrWhiteSpace($ReceiptPublicationBarrier)){return}
  $deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+30000
  while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
    try {
      if([IO.File]::Exists($ReceiptPublicationBarrier)){
        $item=Get-Item -LiteralPath $ReceiptPublicationBarrier -Force
        if($item -is [IO.FileInfo] -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){return}
      }
    }catch{}
    Start-Sleep -Milliseconds 10
  }
}

function Test-OwnerAlive {
  try{
    $p=[Diagnostics.Process]::GetProcessById($Owner)
    try{
      # CIM CreationDate and .NET StartTime can differ by a few milliseconds
      # (and by more on a busy Windows host). Keep the PID binding, but use a
      # small parsed-time tolerance so a valid owner does not disappear before
      # the parent observes the ready nonce.
      $a=[DateTimeOffset]$p.StartTime.ToUniversalTime();$b=[DateTimeOffset]::Parse([string]$Started)
      return (-not $p.HasExited -and [Math]::Abs(($a-$b).TotalSeconds) -le 5)
    }finally{$p.Dispose()}
  }catch{return $false}
}

$releaseWaitMs=[Math]::Max(1000,[Math]::Min(120000,$WaitMs))
$ackWaitMs=[Math]::Max(100,[Math]::Min(5000,$ReceiptAckWaitMs))
try {
  # Compile the fixed no-follow interop before owning the named mutex. This
  # initialization has no ticket or coordinator path access; the actual
  # reparse and hard-link checks remain in every marker operation below.
  if(-not (Initialize-LeaseFileIdentity)){throw 'Coordinator marker parent validation is unavailable.'}
  $acquisitionWaitMs=$releaseWaitMs
  if($ReadyDeadlineAt -gt 0){
    $readyRemaining=$ReadyDeadlineAt-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if($readyRemaining -le 0){throw 'Coordinator ready handshake deadline expired before mutex acquisition.'}
    $acquisitionWaitMs=[int][Math]::Max(1,[Math]::Min([int64]$acquisitionWaitMs,[int64]$readyRemaining))
  }
  try {$held=$mutex.WaitOne($acquisitionWaitMs)} catch [Threading.AbandonedMutexException] {$held=$true}
  if(-not $held){exit 2}
  if($ReadyDeadlineAt -gt 0 -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $ReadyDeadlineAt){throw 'Coordinator ready handshake deadline expired after mutex acquisition.'}
  if([string]::IsNullOrWhiteSpace($Nonce)){throw 'Missing coordinator handshake nonce.'}
  Write-NonceMarker ($Ticket+'.ready') 'ready'
  $readyPublished=$true
  $releaseDeadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$releaseWaitMs
  while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $releaseDeadline) {
    # A matching content proof is required; the existence of a stale or
    # attacker-created marker is never authority to release this attempt.
    if(Test-NonceMarker ($Ticket+'.release') 'release'){$releaseAccepted=$true;break}
    if(-not (Test-OwnerAlive)){break}
    Start-Sleep -Milliseconds 25
  }
} finally {
  try {
    if($held){
      $mutex.ReleaseMutex()
      $mutexReleased=$true
      $held=$false
      # The receipt is emitted only after the kernel mutex has been released;
      # a second contender can therefore acquire before a parent observes it.
      if($releaseAccepted -and $mutexReleased){
        Wait-ForReceiptPublicationBarrier
        Write-NonceMarker ($Ticket+'.released') 'released'
        Wait-ForReceiptCleanupBarrier
        $ackDeadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$ackWaitMs
        while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $ackDeadline) {
          # Node can publish `.ack` only as an exclusive hard link to the
          # still-present receipt. Require both nonce-bound views before
          # treating the receipt as observed and starting final cleanup.
          $receipt=$Ticket+'.released';$acknowledgement=$Ticket+'.ack'
          if((Test-NonceMarker $receipt 'released') -and
             (Test-NonceMarker $acknowledgement 'released') -and
             (Test-SameAttemptReceiptHardLink $receipt $acknowledgement) -and
             (Test-NonceMarker $receipt 'released') -and
             (Test-NonceMarker $acknowledgement 'released')){break}
          Start-Sleep -Milliseconds 10
        }
      }
    }
  } finally {
    $mutex.Dispose()
    # This helper owns all cleanup. In particular, a late receipt is removed
    # here after its bounded acknowledgement window instead of becoming an
    # orphan after a timed-out Node caller has already returned.
    # Before a verified ready marker exists, this helper has not established
    # ownership of any ticket marker. Never clean ordinary foreign files after
    # an initialization or pre-acquisition failure.
    if($readyPublished){foreach($suffix in @('.ready','.release','.released','.ack')){Remove-AttemptMarker ($Ticket+$suffix)}}
  }
}
