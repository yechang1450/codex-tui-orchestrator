import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {statSync} from 'node:fs';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {controllerEnvironment,trustedWindowsHelper,trustedWindowsRoot} from './windows-system.mjs';

export function isWindowsTerminalAlias(candidate,{localAppData=process.env.LOCALAPPDATA,platform=process.platform}={}){
 if(platform!=='win32'||typeof candidate!=='string'||!candidate||typeof localAppData!=='string'||!localAppData)return false;
 const alias=path.win32.join(localAppData,'Microsoft','WindowsApps','wt.exe');
 return path.win32.normalize(candidate).toLowerCase()===path.win32.normalize(alias).toLowerCase();
}

// The per-user WindowsApps entry is an App Execution Alias (a reparse point).
// Resolve the package executable instead, while preserving the same strict
// reparse and containment checks for every returned path.
export function resolveWindowsTerminalExecutable({
 programFiles=process.env.ProgramFiles||process.env.ProgramW6432||'C:\\Program Files'
}={}){
 if(process.platform!=='win32')return '';
 const packageRoot=path.join(programFiles,'WindowsApps');
 let locations=[];
 try{
  assertNoReparsePoints(packageRoot,'Windows Terminal package root');
  const script="$ErrorActionPreference='Stop'; Get-AppxPackage -Name Microsoft.WindowsTerminal | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation";
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
   cwd:trustedWindowsRoot(),env:controllerEnvironment(),windowsHide:true,shell:false,encoding:'utf8',timeout:5000,
  });
  if(result.status===0)locations=String(result.stdout||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 }catch{return '';}
 for(const location of locations){
  const candidate=path.join(location,'wt.exe');
  const relative=path.relative(packageRoot,candidate);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||isWindowsTerminalAlias(candidate))continue;
  try{
   assertNoReparsePoints(candidate,'Windows Terminal executable');
   if(statSync(candidate).isFile())return candidate;
  }catch{
   // An incomplete or unreadable package is ignored; try the next installed version.
  }
 }
 return '';
}
