import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {trustedWindowsHelper,trustedWindowsRoot} from './leases.mjs';

// Windows command-line quoting, including quotes and trailing backslashes.
export function quoteWindowsArgument(value){
 const text=String(value);
 if(text.includes('\0'))throw new Error('Invalid NUL in window argument');
 return '"'+text.replace(/(\\*)"/g,'$1$1\\"').replace(/\\+$/g,'$&$&')+'"';
}
export function spawnInactiveWindow(file,args,cwd,{invoke=spawnSync}={}){
 validateLaunchBoundary(file,args,cwd);
 const payload=Buffer.from(JSON.stringify({file,parameters:args.map(quoteWindowsArgument).join(' '),cwd}),'utf8').toString('base64');
 const result=invoke(powerShellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./inactive-window.ps1',import.meta.url)),'-Payload',payload],{...helperOptions(cwd),windowsHide:true,shell:false,encoding:'utf8',timeout:15000});
 if(result.error||result.status!==0)throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: '+(result.error?.message||result.stderr||result.status));
}

// Start asynchronously but retain a hidden console: DETACHED_PROCESS makes
// Windows PowerShell exit 0 without executing -File on supported Windows hosts.
// Keep the short-lived helper referenced until it exits so an awaiting controller
// cannot exit early with an unsettled promise. launchResult reports real errors.
export function spawnInactiveWindowDetached(file,args,cwd,{invoke=spawn}={}){
 validateLaunchBoundary(file,args,cwd);
 const payload=Buffer.from(JSON.stringify({file,parameters:args.map(quoteWindowsArgument).join(' '),cwd}),'utf8').toString('base64');
 let child;
 try{
  child=invoke(powerShellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./inactive-window.ps1',import.meta.url)),'-Payload',payload],{...helperOptions(cwd),windowsHide:true,shell:false,stdio:'ignore'});
 }catch(error){throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: '+(error?.message||String(error)));}
 if(!child||typeof child.unref!=='function')throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: helper did not return a detached process');
 child.launchResult=new Promise(resolve=>{
  child.once('error',error=>resolve({ok:false,error:error.message}));
  child.once('exit',code=>resolve(code===0?{ok:true}:{ok:false,error:'helper exited with code '+code}));
 });
 return child;
}

function powerShellPath(){return process.platform==='win32'?trustedWindowsHelper('powershell'):'powershell.exe';}
function helperOptions(cwd){
 if(process.platform!=='win32')return {cwd};
 const root=trustedWindowsRoot();
 // Preserve the initiating agent's credentials/configuration, but pin the
 // system-root variables used by the helper script to the verified root.
 return {cwd:root,env:{...process.env,SystemRoot:root,WINDIR:root}};
}
function validateLaunchBoundary(file,args,cwd){
 if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target executable must be absolute');
 if(!Array.isArray(args)||args.some(arg=>typeof arg!=='string'))throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target arguments must be strings');
 if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: working directory must be absolute');
 assertNoReparsePoints(file,'inactive target executable');assertNoReparsePoints(cwd,'inactive target working directory');
 let stat;try{stat=fs.statSync(file);}catch{throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target executable is missing');}
 if(!stat.isFile())throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target executable is not a regular file');
}
