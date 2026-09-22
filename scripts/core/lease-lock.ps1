param([string]$Directory,[string]$Ticket,[int]$Owner,[string]$Started)
$ErrorActionPreference='Stop'
$hash=[Security.Cryptography.SHA256]::Create()
$name='Local\TuiOrchestrator.Leases.'+[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Directory.ToLowerInvariant()))).Replace('-','')
$mutex=[Threading.Mutex]::new($false,$name)
$held=$false
try {
  try {$held=$mutex.WaitOne(15000)} catch [Threading.AbandonedMutexException] {$held=$true}
  if(-not $held){exit 2}
  [IO.File]::WriteAllText($Ticket+'.ready','ready')
  while(-not [IO.File]::Exists($Ticket+'.release')) {
    # Never query WMI/CIM inside the critical section: this loop runs while the
    # global coordinator mutex is held (measured 55.8s per CIM query on a busy
    # machine), which turns millisecond transactions into minutes and amplifies
    # every identity-enumeration failure. An in-process liveness probe is enough.
    $alive=$false
    try{
      $p=[Diagnostics.Process]::GetProcessById($Owner)
      # 期望值来自 WMI/CIM 的 CreationDate，它与 .NET 的 StartTime 在最末一位（100ns）上可能有差
      # （实测 CIM …068120Z vs .NET …068128Z），所以按毫秒前缀比较；函数语义不变：
      # "PID 还活着而且确实是当初那个进程"。
      $a=$p.StartTime.ToUniversalTime().ToString('o');$b=[string]$Started
      $alive=($a.Length -ge 23 -and $b.Length -ge 23 -and $a.Substring(0,23) -eq $b.Substring(0,23))
    }catch{$alive=$false}
    if(-not $alive){break}
    Start-Sleep -Milliseconds 100
  }
} finally {
  if($held){$mutex.ReleaseMutex()}
  $mutex.Dispose()
  foreach($suffix in @('.ready','.release')){[IO.File]::Delete($Ticket+$suffix)}
}
