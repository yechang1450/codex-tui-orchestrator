param([string]$Directory,[string]$Ticket,[string]$Nonce,[int]$Owner,[string]$Started,[int]$WaitMs=120000)
$ErrorActionPreference='Stop'
$hash=[Security.Cryptography.SHA256]::Create()
$name='Local\TuiOrchestrator.Leases.'+[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Directory.ToLowerInvariant()))).Replace('-','')
$mutex=[Threading.Mutex]::new($false,$name)
$held=$false
try {
  try {$held=$mutex.WaitOne([Math]::Max(1000,$WaitMs))} catch [Threading.AbandonedMutexException] {$held=$true}
  if(-not $held){exit 2}
  if([string]::IsNullOrWhiteSpace($Nonce)){throw 'Missing coordinator handshake nonce.'}
  [IO.File]::WriteAllText($Ticket+'.ready','ready:'+ $Nonce)
  while(-not [IO.File]::Exists($Ticket+'.release')) {
    # Never query WMI/CIM inside the critical section: this loop runs while the
    # global coordinator mutex is held (measured 55.8s per CIM query on a busy
    # machine), which turns millisecond transactions into minutes and amplifies
    # every identity-enumeration failure. An in-process liveness probe is enough.
    $alive=$false
    try{
      $p=[Diagnostics.Process]::GetProcessById($Owner)
      # CIM CreationDate and .NET StartTime can differ by a few milliseconds
      # (and by more on a busy Windows host).  Keep the PID binding, but use a
      # small parsed-time tolerance so a valid owner does not disappear before
      # the parent observes the ready nonce.
      $a=[DateTimeOffset]$p.StartTime.ToUniversalTime();$b=[DateTimeOffset]::Parse([string]$Started)
      $alive=(-not $p.HasExited -and [Math]::Abs(($a-$b).TotalSeconds) -le 5)
    }catch{$alive=$false}
    if(-not $alive){break}
    Start-Sleep -Milliseconds 100
  }
} finally {
  if($held){$mutex.ReleaseMutex()}
  $mutex.Dispose()
  foreach($suffix in @('.ready','.release')){[IO.File]::Delete($Ticket+$suffix)}
}
