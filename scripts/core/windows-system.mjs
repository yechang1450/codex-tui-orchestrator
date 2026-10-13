import fs from 'node:fs';
import path from 'node:path';
import {assertNoReparsePoints} from './runtime-context.mjs';

// Windows helper resolution lives in this acyclic module so controller-state
// can validate durable roots without importing the lease implementation.
// GLOBALROOT resolves through the system object-manager root instead of the
// caller's SystemRoot/WINDIR/ComSpec environment variables.
const GLOBAL_SYSTEM_ROOT='\\\\?\\GLOBALROOT\\SystemRoot';

export function trustedWindowsRoot() {
  if(process.platform!=='win32')throw new Error('Trusted Windows helpers require Windows');
  let resolved;
  try{resolved=fs.realpathSync.native(GLOBAL_SYSTEM_ROOT);}catch(error){throw new Error('Trusted Windows system root is unavailable: '+(error?.message||error));}
  if(!path.win32.isAbsolute(resolved))throw new Error('Trusted Windows system root is unavailable');
  const root=assertNoReparsePoints(path.win32.normalize(resolved),'Windows system root');
  try{if(!fs.statSync(root).isDirectory())throw new Error('Windows system root is not a directory');}
  catch(error){throw new Error('Trusted Windows system root is unavailable: '+(error?.message||error));}
  const expectedCommandProcessor=path.win32.join(root,'System32','cmd.exe');
  try{
    assertNoReparsePoints(expectedCommandProcessor,'Windows command processor');
    if(!fs.statSync(expectedCommandProcessor).isFile())throw new Error('Windows command processor is not a regular file');
  }catch(error){throw new Error('Trusted Windows system root is unavailable: '+(error?.message||error));}
  return root;
}

const WINDOWS_HELPERS=Object.freeze({
  powershell:path.win32.join('System32','WindowsPowerShell','v1.0','powershell.exe'),
  taskkill:path.win32.join('System32','taskkill.exe'),
  tasklist:path.win32.join('System32','tasklist.exe'),
  where:path.win32.join('System32','where.exe'),
  reg:path.win32.join('System32','reg.exe'),
  chcp:path.win32.join('System32','chcp.com'),
  conhost:path.win32.join('System32','conhost.exe'),
});

export function trustedWindowsHelper(name) {
  const relative=WINDOWS_HELPERS[name];
  if(!relative)throw new Error('Unknown Windows helper: '+name);
  const root=trustedWindowsRoot(),file=path.win32.join(root,relative);
  assertNoReparsePoints(file,'Windows helper');
  let stat;try{stat=fs.statSync(file);}catch(error){throw new Error('Trusted Windows helper unavailable: '+file+' ('+(error?.message||error)+')');}
  if(!stat.isFile())throw new Error('Trusted Windows helper is not a regular file: '+file);
  return file;
}

export function controllerEnvironment(extra={}) {
  const root=trustedWindowsRoot();
  const commandProcessor=path.win32.join(root,'System32','cmd.exe');
  const out={};
  const allow=new Set(['ComSpec','COMSPEC','SystemRoot','WINDIR','TEMP','TMP','Path','PATH','PATHEXT','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','OS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS','CODEX_HOME','ORCH_CONTROLLER_ROOT','LANG','LC_ALL','NO_PROXY','no_proxy']);
  const reserved=new Set(['comspec','systemroot','windir']);
  for(const [key,value] of Object.entries(process.env)) {
    if(reserved.has(key.toLowerCase())||!allow.has(key)||/(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key))continue;
    if(typeof value==='string'&&value.length<=4096)out[key]=value;
  }
  for(const [key,value] of Object.entries(extra))if(!reserved.has(key.toLowerCase()))out[key]=value;
  out.SystemRoot=root;
  out.WINDIR=root;
  out.ComSpec=commandProcessor;
  return out;
}
