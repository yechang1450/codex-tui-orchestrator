import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertControllerPath,controllerStateDir} from './controller-state.mjs';
import {trustedWindowsHelper,trustedWindowsRoot,controllerEnvironment} from './leases.mjs';
import {physicalPathIdentity} from './runtime-context.mjs';
import {canonicalDigest} from './contracts.mjs';
import {isCredentialShapedText,redactedProjection} from './redaction.mjs';

const MAX_SEALED_BYTES=12*1024*1024;
const MAX_PLAINTEXT_BYTES=8*1024*1024;
const RUN_ID=/^[A-Za-z0-9_-]{1,128}$/;
const PRIVATE_RUN_STATE_VERSION=2;
const PRIVATE_PROJECTION_VERSION=2;

function workspaceHash(workspace){return crypto.createHash('sha256').update(physicalPathIdentity(workspace)).digest('hex');}
function validDigest(value){return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
function validRunId(value){return RUN_ID.test(String(value??''));}
function assertPrivateRunId(runId){
  if(!validRunId(runId))throw new Error('Invalid private recovery run identity');
  if(isCredentialShapedText(runId))throw new Error('SENSITIVE_RUN_IDENTITY: credential-shaped private recovery run identity cannot be used in durable controller state');
  return String(runId);
}
function privateRoot(workspace,env){
  return assertControllerPath(workspace,path.join(controllerStateDir(workspace,env),'private-runs',workspaceHash(workspace)),'private recovery directory',env);
}

export function privateRunStateFile(workspace,runId,env=process.env){
  const safeRunId=assertPrivateRunId(runId);
  return assertControllerPath(workspace,path.join(privateRoot(workspace,env),safeRunId+'.dpapi'),'private recovery state',env);
}

function cryptography(mode,input){
  if(process.platform!=='win32')throw new Error('Private recovery state requires Windows DPAPI');
  const script=mode==='protect'
    ? "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($raw); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd().Trim(); $bytes=[Convert]::FromBase64String($raw); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
    input:String(input??''),encoding:'utf8',windowsHide:true,timeout:30000,cwd:trustedWindowsRoot(),env:controllerEnvironment(),maxBuffer:MAX_SEALED_BYTES,
  });
  if(result.error||result.status!==0)throw new Error('private recovery cryptography failed');
  return String(result.stdout||'').trim();
}

function writeAtomic(file,text){
  const parent=path.dirname(file);fs.mkdirSync(parent,{recursive:true});
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';let descriptor;
  try{
    descriptor=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(descriptor,text,'utf8');fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;
    fs.renameSync(temporary,file);
  }finally{if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{};try{fs.rmSync(temporary,{force:true});}catch{}}
}

function protectedControllerFile(workspace,file,env){
  if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('Protected controller text requires an absolute controller path');
  return assertControllerPath(workspace,path.resolve(file),'protected controller text',env);
}

export function writeProtectedText({workspace,file,text,env=process.env}={}){
  const target=protectedControllerFile(workspace,file,env),plain=String(text??'');
  if(Buffer.byteLength(plain,'utf8')>MAX_PLAINTEXT_BYTES)throw new Error('Protected controller text exceeds the '+MAX_PLAINTEXT_BYTES+' byte safety limit');
  const sealed=cryptography('protect',plain);
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(sealed)||Buffer.byteLength(sealed,'utf8')>MAX_SEALED_BYTES)throw new Error('protected controller text encryption failed');
  writeAtomic(target,sealed);
  return target;
}

export function readProtectedText({workspace,file,env=process.env}={}){
  const target=protectedControllerFile(workspace,file,env);let sealed;
  try{
    const stat=fs.statSync(target);
    if(!stat.isFile()||stat.size<=0||stat.size>MAX_SEALED_BYTES)throw new Error('invalid sealed text size');
    sealed=fs.readFileSync(target,'utf8').trim();
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(sealed))throw new Error('invalid sealed text');
    const plain=cryptography('unprotect',sealed);
    if(Buffer.byteLength(plain,'utf8')>MAX_PLAINTEXT_BYTES)throw new Error('invalid plaintext size');
    return plain;
  }catch(error){throw new Error('protected controller text is unreadable');}
}

function privateJsonError(){throw new Error('Private recovery payload must contain only stable JSON values');}
function normalizeJsonValue(value,stack=new WeakSet()){
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){
    if(!Number.isFinite(value)||Object.is(value,-0))privateJsonError();
    return value;
  }
  if(typeof value!=='object')privateJsonError();
  if(stack.has(value))privateJsonError();
  stack.add(value);
  try{
    if(Array.isArray(value)){
      const keys=Object.keys(value);
      if(keys.length!==value.length||keys.some(key=>!/^\d+$/.test(key)||Number(key)>=value.length))privateJsonError();
      const out=[];
      for(let index=0;index<value.length;index++){
        if(!Object.hasOwn(value,index))privateJsonError();
        out.push(normalizeJsonValue(value[index],stack));
      }
      return out;
    }
    const prototype=Object.getPrototypeOf(value);
    if((prototype!==Object.prototype&&prototype!==null)||Object.hasOwn(value,'toJSON')||Object.getOwnPropertySymbols(value).length)privateJsonError();
    const out={};
    for(const key of Object.keys(value)){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!Object.hasOwn(descriptor,'value'))privateJsonError();
      Object.defineProperty(out,key,{value:normalizeJsonValue(descriptor.value,stack),enumerable:true,configurable:true,writable:true});
    }
    return out;
  }finally{stack.delete(value);}
}

function normalizedPayload(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Private recovery payload must be an object');
  // JSON.stringify is the actual persistence encoding. Validate and clone it
  // before deriving the public digest so disk and digest can never disagree
  // through undefined, non-finite, custom, or cyclic JavaScript values.
  return JSON.parse(JSON.stringify(normalizeJsonValue(payload)));
}

function envelopeFor({workspace,runId,payload}){
  const normalized=normalizedPayload(payload),projection=redactedProjection(normalized),publicSha256=canonicalDigest(projection.value);
  return {version:PRIVATE_RUN_STATE_VERSION,kind:'private-run-state',projectionVersion:PRIVATE_PROJECTION_VERSION,runId,workspaceIdentity:physicalPathIdentity(workspace),publicSha256,payload:normalized};
}

export function writePrivateRunState({workspace,runId,payload,env=process.env}={}){
  const safeRunId=assertPrivateRunId(runId);
  const envelope=envelopeFor({workspace,runId:safeRunId,payload}),plain=JSON.stringify(envelope);
  if(Buffer.byteLength(plain,'utf8')>MAX_PLAINTEXT_BYTES)throw new Error('Private recovery state exceeds the '+MAX_PLAINTEXT_BYTES+' byte safety limit');
  const sealed=cryptography('protect',plain);
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(sealed)||Buffer.byteLength(sealed,'utf8')>MAX_SEALED_BYTES)throw new Error('private recovery cryptography returned an invalid sealed record');
  writeAtomic(privateRunStateFile(workspace,safeRunId,env),sealed);
  return Object.freeze({version:PRIVATE_RUN_STATE_VERSION,projectionVersion:PRIVATE_PROJECTION_VERSION,publicSha256:envelope.publicSha256});
}

export function readPrivateRunState({workspace,runId,expectedPublicSha256,env=process.env}={}){
  if(!validDigest(expectedPublicSha256))throw new Error('Invalid private recovery binding');
  const safeRunId=assertPrivateRunId(runId);
  const file=privateRunStateFile(workspace,safeRunId,env);let sealed;
  try{
    const stat=fs.statSync(file);
    if(!stat.isFile()||stat.size<=0||stat.size>MAX_SEALED_BYTES)throw new Error('invalid sealed record size');
    sealed=fs.readFileSync(file,'utf8').trim();
  }catch(error){throw new Error('private recovery state is unreadable');}
  let envelope;
  try{
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(sealed))throw new Error('invalid base64');
    const plain=cryptography('unprotect',sealed);
    if(Buffer.byteLength(plain,'utf8')>MAX_PLAINTEXT_BYTES)throw new Error('invalid plaintext size');
    envelope=JSON.parse(plain);
  }catch(error){throw new Error('private recovery state is unreadable');}
  if(envelope?.version===1)throw new Error('Private recovery state uses an older privacy format; restart the run with the current plugin version');
  const keys=['version','kind','projectionVersion','runId','workspaceIdentity','publicSha256','payload'];
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||JSON.stringify(Object.keys(envelope).sort())!==JSON.stringify(keys.slice().sort())||
    envelope.version!==PRIVATE_RUN_STATE_VERSION||envelope.kind!=='private-run-state'||envelope.projectionVersion!==PRIVATE_PROJECTION_VERSION||envelope.runId!==safeRunId||envelope.workspaceIdentity!==physicalPathIdentity(workspace)||
    !validDigest(envelope.publicSha256)||!envelope.payload||typeof envelope.payload!=='object'||Array.isArray(envelope.payload))
    throw new Error('private recovery state is invalid');
  const observed=canonicalDigest(redactedProjection(envelope.payload).value);
  if(observed!==envelope.publicSha256||observed!==expectedPublicSha256)throw new Error('private recovery projection mismatch');
  return envelope.payload;
}
