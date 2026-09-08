// Windows PowerShell 5 uses legacy native argv serialization. Preserve embedded
// quotes and trailing backslashes in quoted arguments; PowerShell 7 uses Standard.
export function nativeArgumentLines() {
  return [
    "if($PSVersionTable.PSVersion.Major -ge 7){$PSNativeCommandArgumentPassing='Standard'}else{",
    "  $agentArgs=@($agentArgs|ForEach-Object{$v=[regex]::Replace($_,'(\\\\*)\"','${1}${1}\\\"'); if($_ -match '\\s'){$v=[regex]::Replace($v,'\\\\+$','$0$0')}; $v})",
    "}",
  ];
}
