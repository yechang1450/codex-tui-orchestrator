import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {trustedWindowsHelper,trustedWindowsRoot,controllerEnvironment} from './windows-system.mjs';

const helper=fileURLToPath(new URL('./safe-workspace-read.ps1',import.meta.url));
const MAX_SAFE_WORKSPACE_READ_BYTES=64*1024*1024;
const SHA256=/^[a-f0-9]{64}$/;

function failure(code,label) {
  throw new Error(`${code}: ${label}`);
}

function absolute(value,label) {
  if(typeof value!=='string'||!path.isAbsolute(value))failure('SAFE_WORKSPACE_READ_REQUEST',label);
  return path.resolve(value);
}

function parseResponse(result,label,{includeText,maxBytes}={}) {
  let response;
  try { response=JSON.parse(String(result.stdout||'')); } catch { failure('SAFE_WORKSPACE_READ_PROTOCOL',label); }
  if(!response||typeof response!=='object'||response.version!==1||typeof response.ok!=='boolean')failure('SAFE_WORKSPACE_READ_PROTOCOL',label);
  if(!response.ok)failure(typeof response.code==='string'&&/^SAFE_WORKSPACE_READ_[A-Z_]+$/.test(response.code)?response.code:'SAFE_WORKSPACE_READ_FAILED',label);
  const file=response.file;
  if(!file||!Number.isSafeInteger(file.size)||file.size<0||file.size>maxBytes||!SHA256.test(String(file.sha256||'')))failure('SAFE_WORKSPACE_READ_PROTOCOL',label);
  let bytes;
  if(includeText) {
    if(typeof file.textBase64!=='string')failure('SAFE_WORKSPACE_READ_PROTOCOL',label);
    bytes=Buffer.from(file.textBase64,'base64');
    if(bytes.length!==file.size||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)failure('SAFE_WORKSPACE_READ_PROTOCOL',label);
  }
  return {size:file.size,sha256:file.sha256,bytes,text:bytes?.toString('utf8')};
}

function invoke(request,label,{spawn=spawnSync,platform=process.platform}={}) {
  if(platform!=='win32')failure('SAFE_WORKSPACE_READ_UNSUPPORTED',label);
  const maxBytes=Number(request.maxBytes||0);
  const spawnOnce=()=>spawn(trustedWindowsHelper('powershell'),[
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,
  ],{
    cwd:trustedWindowsRoot(),env:controllerEnvironment(),windowsHide:true,shell:false,
    input:JSON.stringify(request),encoding:'utf8',timeout:15000,maxBuffer:Math.max(128*1024,Math.min(128*1024*1024,maxBytes*2+128*1024)),
  });
  // The hosted image can stall the first PowerShell start (module warm-up and
  // antivirus scanning); every request here is a bounded, idempotent read, so
  // retry once on an execution-layer failure before failing closed.
  let result=spawnOnce();
  if(result?.error)result=spawnOnce();
  if(result.error||result.status!==0)failure('SAFE_WORKSPACE_READ_HELPER',label);
  return result;
}

export function bindWorkspaceRoot(root,options={}) {
  root=absolute(root,'workspace root');
  const result=invoke({version:1,operation:'bind-root',root},'workspace root',options);
  let response;
  try { response=JSON.parse(String(result.stdout||'')); } catch { failure('SAFE_WORKSPACE_READ_PROTOCOL','workspace root'); }
  const binding=response?.binding;
  if(response?.ok!==true||response.version!==1||!binding||!/^\d+$/.test(String(binding.volumeSerial||''))||!/^\d+$/.test(String(binding.fileIndex||''))||typeof binding.finalPath!=='string'||!binding.finalPath)failure('SAFE_WORKSPACE_READ_PROTOCOL','workspace root');
  return Object.freeze({volumeSerial:String(binding.volumeSerial),fileIndex:String(binding.fileIndex),finalPath:String(binding.finalPath)});
}

export function readWorkspaceFile({root,binding,target,maxBytes,mode='text'},options={}) {
  root=absolute(root,'workspace root');target=absolute(target,'workspace file');
  if(!binding||typeof binding!=='object')failure('SAFE_WORKSPACE_READ_REQUEST','workspace root binding');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_SAFE_WORKSPACE_READ_BYTES)failure('SAFE_WORKSPACE_READ_LIMIT','workspace file');
  const includeText=mode==='text';
  if(!includeText&&mode!=='hash')failure('SAFE_WORKSPACE_READ_REQUEST','workspace file');
  const result=invoke({version:1,operation:includeText?'read-utf8':'sha256',root,binding,target,maxBytes},'workspace file',options);
  return parseResponse(result,'workspace file',{includeText,maxBytes});
}

export function readWorkspaceText({root,target,maxBytes,binding},options={}) {
  return readWorkspaceFile({root,target,maxBytes,mode:'text',binding:binding||bindWorkspaceRoot(root,options)},options);
}

// The absence probe is a point-in-time assertion. Its Windows helper holds
// no-follow handles on every existing component from the bound root to the
// first missing component, so a junction cannot redirect the observation.
export function assertWorkspaceAbsent({root,binding,target},options={}) {
  root=absolute(root,'workspace root');target=absolute(target,'workspace file');
  if(!binding||typeof binding!=='object')failure('SAFE_WORKSPACE_READ_REQUEST','workspace root binding');
  const result=invoke({version:1,operation:'assert-absent',root,binding,target},'workspace file',options);
  let response;
  try { response=JSON.parse(String(result.stdout||'')); } catch { failure('SAFE_WORKSPACE_READ_PROTOCOL','workspace file'); }
  if(response&&response.ok===false)
    failure(typeof response.code==='string'&&/^SAFE_WORKSPACE_READ_[A-Z_]+$/.test(response.code)?response.code:'SAFE_WORKSPACE_READ_FAILED','workspace file');
  if(!response||typeof response!=='object'||response.version!==1||response.ok!==true||Object.hasOwn(response,'file'))
    failure('SAFE_WORKSPACE_READ_PROTOCOL','workspace file');
  return true;
}

export const WORKSPACE_READ_LIMITS=Object.freeze({plan:1024*1024,acceptanceJson:1024*1024,acceptanceFile:8*1024*1024});
