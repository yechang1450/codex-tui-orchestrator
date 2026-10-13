import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnInactiveWindow} from '../scripts/core/inactive-window.mjs';
import {assertControllerPath,controllerStateDir} from '../scripts/core/controller-state.mjs';
import {assertNoReparsePoints} from '../scripts/core/runtime-context.mjs';
import {trustedWindowsHelper} from '../scripts/core/windows-system.mjs';
import {isWindowsTerminalAlias,resolveWindowsTerminalExecutable} from '../scripts/core/windows-terminal.mjs';

const MAX_REQUEST_BYTES=128*1024;
const MAX_SCRIPT_BYTES=64*1024;
const MAX_ARGUMENTS=256;
const MAX_ARGUMENT_CHARS=64*1024;
const LAUNCHERS=new Set(['explicit-terminal','windows-terminal','system-console','legacy-console']);
const SHA256=/^[a-f0-9]{64}$/;

function invalidRequest(){throw new Error('LIVE_INACTIVE_WINDOW_REQUEST_INVALID');}

function localAbsolutePath(value){
 if(typeof value!=='string'||!value||value.includes('\0'))invalidRequest();
 const raw=value.replaceAll('/','\\');
 if(!/^[A-Za-z]:\\/.test(raw)||raw.slice(2).includes(':'))invalidRequest();
 const resolved=path.win32.resolve(raw);
 if(!/^[A-Za-z]:\\/.test(resolved)||resolved.slice(2).includes(':'))invalidRequest();
 return resolved;
}

function verifiedFile(value,label){
 const file=localAbsolutePath(value);
 try{
  assertNoReparsePoints(file,label);
  if(!fs.statSync(file).isFile())invalidRequest();
 }catch{invalidRequest();}
 return file;
}

function verifiedDirectory(value,label){
 const directory=localAbsolutePath(value);
 try{
  assertNoReparsePoints(directory,label);
  if(!fs.statSync(directory).isDirectory())invalidRequest();
 }catch{invalidRequest();}
 return directory;
}

function sameOrChild(candidate,parent){
 const relative=path.win32.relative(parent.toLowerCase(),candidate.toLowerCase());
 return relative===''||(!relative.startsWith('..\\')&&relative!=='..'&&!path.win32.isAbsolute(relative));
}

function decodeBoundScript(base64,digest){
 if(typeof base64!=='string'||typeof digest!=='string'||!SHA256.test(digest)||base64.length<4||base64.length>Math.ceil(MAX_SCRIPT_BYTES/3)*4)invalidRequest();
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))invalidRequest();
 let bytes;try{bytes=Buffer.from(base64,'base64');}catch{invalidRequest();}
 if(bytes.length<1||bytes.length>MAX_SCRIPT_BYTES||bytes.toString('base64')!==base64)invalidRequest();
 const observed=crypto.createHash('sha256').update(bytes).digest('hex');
 if(!crypto.timingSafeEqual(Buffer.from(observed,'ascii'),Buffer.from(digest,'ascii')))invalidRequest();
 return bytes;
}

function requestObject(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||
   JSON.stringify(Object.keys(value).sort())!==JSON.stringify(['args','cwd','file','launcher','scriptBase64','scriptSha256','version']))invalidRequest();
 if(value.version!==3||!LAUNCHERS.has(value.launcher)||!Array.isArray(value.args)||value.args.length>MAX_ARGUMENTS)invalidRequest();
 const args=[];let characters=0;
 for(const argument of value.args){
  if(typeof argument!=='string'||argument.includes('\0'))invalidRequest();
  characters+=argument.length;
  if(characters>MAX_ARGUMENT_CHARS)invalidRequest();
  args.push(argument);
 }
 const cwd=verifiedDirectory(value.cwd,'live inactive-window target working directory');
 const scriptBytes=decodeBoundScript(value.scriptBase64,value.scriptSha256);
 let file=null;
 if(value.launcher==='explicit-terminal'){
  if(typeof value.file!=='string')invalidRequest();
  file=verifiedFile(value.file,'live inactive-window target executable');
 }else if(value.file!==null)invalidRequest();
 if((value.launcher==='system-console'||value.launcher==='legacy-console')&&args.length!==0)invalidRequest();
 return Object.freeze({version:3,launcher:value.launcher,file,args:Object.freeze(args),scriptBytes,scriptSha256:value.scriptSha256,cwd});
}

export function readLiveInactiveWindowRequest(input){
 if(typeof input!=='string'||Buffer.byteLength(input,'utf8')<1||Buffer.byteLength(input,'utf8')>MAX_REQUEST_BYTES)invalidRequest();
 try{return requestObject(JSON.parse(input));}catch{invalidRequest();}
}

function protectedProbeDirectory(cwd,requestedDirectory){
 let directory=requestedDirectory;
 if(directory===undefined){
  const root=controllerStateDir(cwd);
  directory=assertControllerPath(cwd,path.join(root,'live-inactive-window-probes'),'live inactive-window probe scripts');
 }
 directory=localAbsolutePath(directory);
 if(sameOrChild(directory,cwd))invalidRequest();
 try{
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  assertNoReparsePoints(directory,'live inactive-window protected probe directory');
  if(!fs.statSync(directory).isDirectory())invalidRequest();
 }catch{invalidRequest();}
 return directory;
}

// The probe author gives us only exact script bytes and their digest over a
// private stdin pipe. Materialize them below the controller root before the
// production launcher sees a path. A workspace writer can then neither swap
// the executable after validation nor replace it with a receipt-forging body.
export function materializeLiveInactiveWindowScript(request,{scriptDirectory}={}){
 if(!request||!Buffer.isBuffer(request.scriptBytes)||!SHA256.test(String(request.scriptSha256||'')))invalidRequest();
 const directory=protectedProbeDirectory(request.cwd,scriptDirectory);
 const file=path.join(directory,`probe-${crypto.randomUUID()}.ps1`);let descriptor,complete=false;
 try{
  descriptor=fs.openSync(file,'wx',0o600);
  fs.writeFileSync(descriptor,request.scriptBytes);
  fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;
  assertNoReparsePoints(file,'live inactive-window protected probe script');
  if(!fs.statSync(file).isFile())invalidRequest();
  const bytes=fs.readFileSync(file);
  const observed=crypto.createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==request.scriptBytes.length||!crypto.timingSafeEqual(Buffer.from(observed,'ascii'),Buffer.from(request.scriptSha256,'ascii')))invalidRequest();
  complete=true;
  return file;
 }catch{
  invalidRequest();
 }finally{
  if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}
  if(!complete)try{fs.rmSync(file,{force:true});}catch{}
 }
}

function reserveLiveInactiveWindowArtifact(directory,kind){
 const file=path.join(directory,`${kind}-${crypto.randomUUID()}.json`);let descriptor,complete=false;
 try{
  descriptor=fs.openSync(file,'wx',0o600);
  fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;
  assertNoReparsePoints(file,`live inactive-window protected ${kind}`);
  if(!fs.statSync(file).isFile())invalidRequest();
  complete=true;
  return file;
 }catch{
  invalidRequest();
 }finally{
  if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}
  if(!complete)try{fs.rmSync(file,{force:true});}catch{}
 }
}

// The adapter, rather than the writable workspace, allocates both evidence
// files. The target receives only the private receipt path; the parent probe
// writes the report after it has evaluated the receipt and window telemetry.
export function allocateLiveInactiveWindowArtifacts(request,{artifactDirectory,scriptDirectory}={}){
 if(!request||typeof request.cwd!=='string')invalidRequest();
 const directory=protectedProbeDirectory(request.cwd,artifactDirectory??scriptDirectory);
 let receipt,report,complete=false;
 try{
  receipt=reserveLiveInactiveWindowArtifact(directory,'receipt');
  report=reserveLiveInactiveWindowArtifact(directory,'report');
  complete=true;
  return Object.freeze({directory,receipt,report});
 }finally{
  if(!complete){
   for(const file of [receipt,report])if(file)try{fs.rmSync(file,{force:true});}catch{}
  }
 }
}

function trustedHelper(name,resolveSystemHelper){
 if(typeof resolveSystemHelper!=='function')invalidRequest();
 let helper;try{helper=resolveSystemHelper(name);}catch{invalidRequest();}
 return verifiedFile(helper,`live inactive-window trusted ${name} helper`);
}

function terminalTarget(request,{resolveTerminal,isTerminalAlias,resolveSystemHelper}){
 const powershell=trustedHelper('powershell',resolveSystemHelper);
 const scriptArgs=['-NoProfile','-File',request.script,'-ReceiptPath',request.receipt];
 if(request.launcher==='system-console')return {file:powershell,args:scriptArgs};
 if(request.launcher==='legacy-console'){
  const conhost=trustedHelper('conhost',resolveSystemHelper);
  return {file:conhost,args:[powershell,...scriptArgs]};
 }
 let file;
 if(request.launcher==='windows-terminal'){
  if(typeof resolveTerminal!=='function'||typeof isTerminalAlias!=='function')invalidRequest();
  try{file=resolveTerminal();}catch{invalidRequest();}
 }else file=request.file;
 if(typeof isTerminalAlias==='function'&&isTerminalAlias(file))invalidRequest();
 file=verifiedFile(file,'live inactive-window target executable');
 return {file,args:[...request.args,powershell,...scriptArgs]};
}

export function launchLiveInactiveWindowRequest(input,{launch=spawnInactiveWindow,resolveTerminal=resolveWindowsTerminalExecutable,isTerminalAlias=isWindowsTerminalAlias,resolveSystemHelper=trustedWindowsHelper,scriptDirectory,artifactDirectory}={}){
 if(typeof launch!=='function')invalidRequest();
 const request=readLiveInactiveWindowRequest(input);let script,artifacts;let launched=false;
 try{
  script=materializeLiveInactiveWindowScript(request,{scriptDirectory});
  artifacts=allocateLiveInactiveWindowArtifacts(request,{artifactDirectory,scriptDirectory});
  const target=terminalTarget({...request,script,receipt:artifacts.receipt},{resolveTerminal,isTerminalAlias,resolveSystemHelper});
  launch(target.file,target.args,request.cwd);
  launched=true;
  return Object.freeze({version:3,launcher:request.launcher,file:target.file,args:Object.freeze([...target.args]),script,scriptSha256:request.scriptSha256,cwd:request.cwd,receipt:artifacts.receipt,report:artifacts.report});
 }finally{
  // On a failed admission no target has an open script handle, so do not leave
  // a stale private copy. On success the generated probe removes itself after
  // it emits its receipt and finishes its observation interval.
  if(!launched){
   if(script)try{fs.rmSync(script,{force:true});}catch{}
   for(const file of [artifacts?.receipt,artifacts?.report])if(file)try{fs.rmSync(file,{force:true});}catch{}
  }
 }
}

export function readBoundedStdin(input=process.stdin,{maxBytes=MAX_REQUEST_BYTES}={}){
 return new Promise((resolve,reject)=>{
  if(!input||typeof input.on!=='function'||typeof input.removeListener!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1) return reject(new Error('LIVE_INACTIVE_WINDOW_REQUEST_INVALID'));
  let chunks=[],size=0,ended=false,settled=false;
  const cleanup=()=>{
   input.removeListener('data',onData);input.removeListener('end',onEnd);input.removeListener('error',onError);input.removeListener('close',onClose);
  };
  const fail=()=>{
   if(settled)return;settled=true;cleanup();
   try{input.pause?.();}catch{}
   try{input.destroy?.();}catch{}
   reject(new Error('LIVE_INACTIVE_WINDOW_REQUEST_INVALID'));
  };
  const onData=chunk=>{
   if(settled)return;
   const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),'utf8');
   // Do not retain a chunk that would cross the limit. Destroying the pipe
   // here means the CLI can fail while its parent deliberately keeps stdin open.
   if(bytes.length>maxBytes-size){fail();return;}
   chunks.push(bytes);size+=bytes.length;
  };
  const onEnd=()=>{
   if(settled)return;ended=true;settled=true;cleanup();
   try{resolve(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));}
   catch{reject(new Error('LIVE_INACTIVE_WINDOW_REQUEST_INVALID'));}
  };
  const onError=()=>fail();
  const onClose=()=>{if(!ended)fail();};
  input.on('data',onData);input.once('end',onEnd);input.once('error',onError);input.once('close',onClose);
 });
}

async function main(){
 try{
  if(process.argv.length!==2)invalidRequest();
  const result=launchLiveInactiveWindowRequest(await readBoundedStdin(process.stdin));
  process.stdout.write(JSON.stringify({version:3,ok:true,receipt:result.receipt,report:result.report})+'\n');
 }catch{
  // The manual probe records only this generic helper failure so target paths,
  // session data, and the structured request never enter captured output.
  process.stderr.write('LIVE_INACTIVE_WINDOW_ADAPTER_FAILED\n');
  process.exitCode=1;
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void main();
