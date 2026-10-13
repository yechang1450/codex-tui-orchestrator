import {spawn,spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {trustedWindowsHelper,trustedWindowsRoot} from './leases.mjs';
import {trustedPowerShellEnvironment} from './private-root.mjs';
import {controllerStateDir} from './controller-state.mjs';
import {writeProtectedText} from './private-run-state.mjs';

const MAX_TARGET_ENVIRONMENT_ENTRIES=256;
const MAX_TARGET_ENVIRONMENT_CHARS=30_000;
const ENVIRONMENT_NAME=/^[^=\0]{1,256}$/;

// Windows command-line quoting, including quotes and trailing backslashes.
export function quoteWindowsArgument(value){
 const text=String(value);
 if(text.includes('\0'))throw new Error('Invalid NUL in window argument');
 return '"'+text.replace(/(\\*)"/g,'$1$1\\"').replace(/\\+$/g,'$&$&')+'"';
}
export function spawnInactiveWindow(file,args,cwd,{invoke=spawnSync,timeoutMs=15000}={}){
 validateLaunchBoundary(file,args,cwd);
 const payload=Buffer.from(JSON.stringify({file,parameters:args.map(quoteWindowsArgument).join(' '),cwd}),'utf8').toString('base64');
 const environmentPayload=createTargetEnvironmentPayload(cwd);
  const timeout=Math.max(1,Math.min(15000,Number(timeoutMs)||15000));
 try{
  let result;
  try{result=invoke(powerShellPath(),helperArguments(payload,environmentPayload),{...helperOptions(cwd),windowsHide:true,shell:false,encoding:'utf8',timeout});}
  catch(error){throw helperStartError(error);}
  if(result?.error)throw helperStartError(result.error);
  if(!result||result.status!==0)throw helperExitError(result);
 }finally{removeTargetEnvironmentPayload(environmentPayload);}
}

// Start asynchronously but retain a hidden console: DETACHED_PROCESS makes
// Windows PowerShell exit 0 without executing -File on supported Windows hosts.
// Keep the short-lived helper referenced until it exits so an awaiting controller
// cannot exit early with an unsettled promise. launchResult reports real errors.
export function spawnInactiveWindowDetached(file,args,cwd,{invoke=spawn}={}){
 validateLaunchBoundary(file,args,cwd);
 const payload=Buffer.from(JSON.stringify({file,parameters:args.map(quoteWindowsArgument).join(' '),cwd}),'utf8').toString('base64');
 const environmentPayload=createTargetEnvironmentPayload(cwd);let child;
 try{
  child=invoke(powerShellPath(),helperArguments(payload,environmentPayload),{...helperOptions(cwd),windowsHide:true,shell:false,stdio:'ignore'});
 }catch(error){removeTargetEnvironmentPayload(environmentPayload);throw helperStartError(error);}
 if(!child||typeof child.unref!=='function'||typeof child.once!=='function'){
  removeTargetEnvironmentPayload(environmentPayload);
  throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: helper did not return a detached process');
 }
 let settled=false,resolveLaunch;
 child.launchResult=new Promise(resolve=>{resolveLaunch=resolve;});
 const settle=result=>{
  if(settled)return;
  settled=true;
  try{removeTargetEnvironmentPayload(environmentPayload);}
  catch(error){result={ok:false,error:error.message};}
  resolveLaunch(result);
 };
 try{
  child.once('error',error=>settle({ok:false,error:helperStartError(error).message}));
  child.once('exit',code=>settle(code===0?{ok:true}:{ok:false,error:'helper exited with code '+code}));
 }catch(error){
  removeTargetEnvironmentPayload(environmentPayload);
  throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: helper could not report completion');
 }
 if(child.exitCode!==undefined&&child.exitCode!==null)
  settle(child.exitCode===0?{ok:true}:{ok:false,error:'helper exited with code '+child.exitCode});
 return child;
}

function powerShellPath(){return process.platform==='win32'?trustedWindowsHelper('powershell'):'powershell.exe';}
function helperErrorCode(error){
 const code=String(error?.code??'');
 return /^[A-Z0-9_]+$/.test(code)?' '+code:'';
}
function helperStartError(error){return new Error('INACTIVE_WINDOW_LAUNCH_FAILED: helper could not start'+helperErrorCode(error));}
function helperExitError(result){
 const status=result?.status;
 return new Error('INACTIVE_WINDOW_LAUNCH_FAILED: '+(Number.isInteger(status)?'helper exited with code '+status:'helper did not complete'));
}
function helperArguments(payload,environmentPayload){
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./inactive-window.ps1',import.meta.url))];
 if(environmentPayload)args.push('-EnvironmentFile',environmentPayload.file,'-EnvironmentToken',environmentPayload.token);
 args.push('-Payload',payload);
 return args;
}
function helperOptions(cwd){
 if(process.platform!=='win32')return {cwd};
 const root=trustedWindowsRoot();
 return {cwd:root,env:trustedPowerShellEnvironment()};
}
function targetEnvironmentError(){return new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target environment is invalid');}
function targetEnvironmentSnapshot(environment=process.env){
 const result=Object.create(null),names=new Set();let count=0,characters=1;
 for(const [name,value] of Object.entries(environment)){
  if(!ENVIRONMENT_NAME.test(name)||typeof value!=='string'||value.includes('\0'))throw targetEnvironmentError();
  const normalized=name.toUpperCase();
  if(names.has(normalized))throw targetEnvironmentError();
  names.add(normalized);count++;
  characters+=name.length+value.length+2;
  if(count>MAX_TARGET_ENVIRONMENT_ENTRIES||characters>MAX_TARGET_ENVIRONMENT_CHARS)throw targetEnvironmentError();
  Object.defineProperty(result,name,{value,enumerable:true,configurable:false,writable:false});
 }
 if(count===0)throw targetEnvironmentError();
 return result;
}
function createTargetEnvironmentPayload(workspace){
 if(process.platform!=='win32')return null;
 const token=crypto.randomBytes(32).toString('base64url');
 const environment=targetEnvironmentSnapshot();
 const root=controllerStateDir(workspace);
 const file=path.join(root,'inactive-window-environments',`inactive-env-${crypto.randomUUID()}.dpapi`);
 try{
  writeProtectedText({workspace,file,text:JSON.stringify({version:1,token,environment})});
 }catch(error){throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: could not protect the target environment');}
 return Object.freeze({file,token});
}
function removeTargetEnvironmentPayload(payload){
 if(!payload)return;
 try{fs.rmSync(payload.file,{force:true,maxRetries:3,retryDelay:50});}
 catch{throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: could not remove target environment payload');}
}
function validateLaunchBoundary(file,args,cwd){
 if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target executable must be absolute');
 if(!Array.isArray(args)||args.some(arg=>typeof arg!=='string'))throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target arguments must be strings');
 if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: working directory must be absolute');
 assertNoReparsePoints(file,'inactive target executable');assertNoReparsePoints(cwd,'inactive target working directory');
 let stat;try{stat=fs.statSync(file);}catch{throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target executable is missing');}
 if(!stat.isFile())throw new Error('INACTIVE_WINDOW_LAUNCH_FAILED: target executable is not a regular file');
}
