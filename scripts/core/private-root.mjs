import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {trustedWindowsRoot} from './windows-system.mjs';

const LOCAL_SYSTEM_SID='S-1-5-18';
const BUILTIN_ADMINISTRATORS_SID='S-1-5-32-544';
const CREATOR_OWNER_SID='S-1-3-0';
const OWNER_RIGHTS_SID='S-1-3-4';
const SID=/^S-\d+(?:-\d+)+$/i;
const DANGEROUS_FILE_RIGHTS=
  0x00000002n| // WriteData / CreateFiles
  0x00000004n| // AppendData / CreateDirectories
  0x00000010n| // WriteExtendedAttributes
  0x00000040n| // DeleteSubdirectoriesAndFiles
  0x00000100n| // WriteAttributes
  0x00010000n| // Delete
  0x00040000n| // ChangePermissions
  0x00080000n| // TakeOwnership
  0x02000000n| // MaximumAllowed
  0x10000000n| // GenericAll
  0x40000000n;  // GenericWrite
const REPLACEMENT_RIGHTS=
  0x00000040n| // DeleteSubdirectoriesAndFiles
  0x00010000n| // Delete
  0x00040000n| // ChangePermissions
  0x00080000n| // TakeOwnership
  0x10000000n| // GenericAll
  0x40000000n;  // GenericWrite

// The command is intentionally constant. The inspected path is read from
// standard input so an attacker-controlled path never becomes PowerShell code.
const ACL_PROBE_SCRIPT=[
  "$ErrorActionPreference='Stop'",
  // Load the JSON serializer's module explicitly: on hosted Windows images the
  // implicit auto-loading inside a scrubbed environment can stall for minutes,
  // while an explicit import resolves immediately.
  "Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop",
  '$target=[Console]::In.ReadToEnd().Trim()',
  "if([string]::IsNullOrWhiteSpace($target)){throw 'missing root'}",
  '$acl=[IO.Directory]::GetAccessControl($target)',
  '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value',
  '$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { [PSCustomObject]@{ sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); rights=[string](([int64][int]$_.FileSystemRights) -band [int64]4294967295); propagation=$_.PropagationFlags.ToString() } })',
  '[PSCustomObject]@{currentUserSid=$current;ownerSid=$owner;rules=$rules}|ConvertTo-Json -Compress -Depth 4',
].join(';');

function privateRootError(code,detail){
  const error=new Error(`${code}: ${detail}`);
  error.code=code;
  return error;
}

function sid(value,label){
  const normalized=String(value??'').trim().toUpperCase();
  if(!SID.test(normalized))throw privateRootError('PRIVATE_ROOT_ACL_INVALID',`${label} is not a Windows SID`);
  return normalized;
}

function isUncPath(value){
  const text=String(value??'').trim().replaceAll('/','\\');
  return /^\\\\\?\\UNC\\/i.test(text)||/^\\\\(?!\?\\)/.test(text);
}

function localAbsolutePath(value){
  const raw=String(value??'').trim();
  if(!raw)throw privateRootError('PRIVATE_ROOT_PATH_INVALID','root is empty');
  if(isUncPath(raw))throw privateRootError('PRIVATE_ROOT_UNC','network and UNC roots are not trusted controller storage');
  const resolved=path.resolve(raw);
  if(isUncPath(resolved)||!path.win32.isAbsolute(resolved))
    throw privateRootError('PRIVATE_ROOT_PATH_INVALID','root must be an absolute local Windows path');
  return assertNoReparsePoints(resolved,'private controller root');
}

function nearestExistingDirectory(root){
  let current=root;
  while(true){
    try{
      const stat=fs.statSync(current);
      if(!stat.isDirectory())throw privateRootError('PRIVATE_ROOT_PATH_INVALID',`existing anchor is not a directory: ${current}`);
      return current;
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
      const parent=path.dirname(current);
      if(parent===current)throw privateRootError('PRIVATE_ROOT_PATH_INVALID',`no existing local ancestor for ${root}`);
      current=parent;
    }
  }
}

// This module deliberately has no fallback to PATH, a shell, or a bare
// executable name. Integrators must pass the absolute value returned by their
// Windows-system-root trust boundary (for example trustedWindowsHelper).
function trustedAbsolutePowerShell(value){
  const raw=String(value??'').trim();
  if(!raw||isUncPath(raw)||!path.win32.isAbsolute(raw))
    throw privateRootError('PRIVATE_ROOT_HELPER_INVALID','a trusted absolute PowerShell path is required');
  const helper=assertNoReparsePoints(path.resolve(raw),'private-root PowerShell helper');
  if(path.basename(helper).toLowerCase()!=='powershell.exe')
    throw privateRootError('PRIVATE_ROOT_HELPER_INVALID','trusted helper must be powershell.exe');
  try{
    if(!fs.statSync(helper).isFile())throw new Error('not a regular file');
  }catch(error){
    throw privateRootError('PRIVATE_ROOT_HELPER_INVALID',`trusted helper is unavailable (${error?.message||error})`);
  }
  return helper;
}

// PowerShell helpers execute fixed scripts from verified system locations. Do
// not carry the controller's ambient module search path or credentials into
// that boundary: even with -NoProfile, PSModulePath can affect autoloading.
export function trustedPowerShellEnvironment(){
  const root=trustedWindowsRoot();
  const env={
    SystemRoot:root,
    WINDIR:root,
    ComSpec:path.win32.join(root,'System32','cmd.exe'),
    Path:[path.win32.join(root,'System32'),root].join(';'),
  };
  for(const name of ['PATHEXT','TEMP','TMP']){
    const value=process.env[name];
    if(typeof value==='string'&&value.length<=4096)env[name]=value;
  }
  return env;
}

function uintRights(value){
  const text=String(value??'').trim();
  if(!/^\d+$/.test(text))throw privateRootError('PRIVATE_ROOT_ACL_INVALID','access rule rights are invalid');
  try{return BigInt(text);}catch{throw privateRootError('PRIVATE_ROOT_ACL_INVALID','access rule rights are invalid');}
}

function allowedSids(currentUserSid){
  return new Set([currentUserSid,LOCAL_SYSTEM_SID,BUILTIN_ADMINISTRATORS_SID]);
}
function allowedRuleSid(identity,currentUserSid,ownerSid=''){
  if(allowedSids(currentUserSid).has(identity))return true;
  return (identity===CREATOR_OWNER_SID||identity===OWNER_RIGHTS_SID)&&ownerSid===currentUserSid;
}

// Kept separate from the PowerShell transport so its fail-closed SID policy is
// directly testable. `rules` are ACL entries returned as SecurityIdentifier
// values, never localized account names.
export function assertPrivateWindowsAcl(snapshot,{root='private controller root'}={}){
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))
    throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL probe did not return an object');
  const currentUserSid=sid(snapshot.currentUserSid,'current user');
  const ownerSid=sid(snapshot.ownerSid,'owner');
  if(!Array.isArray(snapshot.rules))throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL rules are missing');
  const allowed=allowedSids(currentUserSid);
  if(!allowed.has(ownerSid))
    throw privateRootError('PRIVATE_ROOT_UNSAFE_OWNER',`${root} is owned by untrusted SID ${ownerSid}`);
  for(const rule of snapshot.rules){
    if(!rule||typeof rule!=='object'||Array.isArray(rule))
      throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL rule is invalid');
    const identity=sid(rule.sid,'ACL rule identity');
    const type=String(rule.type??'').trim().toUpperCase();
    if(type!=='ALLOW'&&type!=='DENY')throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL rule type is invalid');
    const rights=uintRights(rule.rights);
    if(type==='ALLOW'&&!allowedRuleSid(identity,currentUserSid,ownerSid)&&(rights&DANGEROUS_FILE_RIGHTS)!==0n)
      throw privateRootError('PRIVATE_ROOT_UNSAFE_DACL',`${root} grants write-like access to untrusted SID ${identity}`);
  }
  return Object.freeze({currentUserSid,ownerSid,rules:snapshot.rules.length});
}

// An ancestor can replace an otherwise private root without granting general
// write access to it. Its own owner is not relevant (for example C:\ may be
// OS-owned), so this intentionally checks only replacement-capable access.
export function assertPrivateWindowsAncestorAcl(snapshot,{root='private controller ancestor'}={}){
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))
    throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL probe did not return an object');
  const currentUserSid=sid(snapshot.currentUserSid,'current user');
  const ownerSid=snapshot.ownerSid===undefined||snapshot.ownerSid===null||String(snapshot.ownerSid).trim()==='' ? '' : sid(snapshot.ownerSid,'owner');
  if(!Array.isArray(snapshot.rules))throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL rules are missing');
  for(const rule of snapshot.rules){
    if(!rule||typeof rule!=='object'||Array.isArray(rule))
      throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL rule is invalid');
    const identity=sid(rule.sid,'ACL rule identity');
    const type=String(rule.type??'').trim().toUpperCase();
    if(type!=='ALLOW'&&type!=='DENY')throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL rule type is invalid');
    const rights=uintRights(rule.rights);
    const inheritOnly=String(rule.propagation??'').split(',').some(flag=>flag.trim().toUpperCase()==='INHERITONLY');
    if(type==='ALLOW'&&!inheritOnly&&!allowedRuleSid(identity,currentUserSid,ownerSid)&&(rights&REPLACEMENT_RIGHTS)!==0n)
      throw privateRootError('PRIVATE_ROOT_UNSAFE_ANCESTOR',`${root} grants replacement-capable access to untrusted SID ${identity}`);
  }
  return Object.freeze({currentUserSid,rules:snapshot.rules.length});
}

function probeAcl(inspectedPath,{powershell,spawn=spawnSync,timeoutMs=5_000}={}){
  const helper=trustedAbsolutePowerShell(powershell);
  const bounded=Math.max(1_000,Math.min(15_000,Math.ceil(Number(timeoutMs)||0)));
  let result;
  try{
    result=spawn(helper,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',ACL_PROBE_SCRIPT],{
      input:inspectedPath,encoding:'utf8',windowsHide:true,shell:false,timeout:bounded,maxBuffer:64*1024,
      cwd:path.dirname(helper),env:trustedPowerShellEnvironment(),
    });
  }catch(error){
    throw privateRootError('PRIVATE_ROOT_ACL_UNAVAILABLE',`ACL probe could not start (${error?.code||'ERROR'})`);
  }
  if(result?.error||result?.status!==0)
    throw privateRootError('PRIVATE_ROOT_ACL_UNAVAILABLE','ACL probe failed');
  const text=String(result.stdout??'').trim();
  if(!text||text.length>64*1024)throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL probe returned invalid output');
  try{return JSON.parse(text);}catch{throw privateRootError('PRIVATE_ROOT_ACL_INVALID','ACL probe returned invalid JSON');}
}

// Validate a local private root before it becomes executable controller state.
// For a path which has not been created yet, the closest existing parent is
// inspected because it controls the permissions inherited by the new root.
export function assertPrivateWindowsRoot(root,{powershell,spawn,timeoutMs}={}){
  if(process.platform!=='win32')throw privateRootError('PRIVATE_ROOT_WINDOWS_ONLY','private Windows root validation requires Windows');
  const resolved=localAbsolutePath(root);
  const inspectedPath=nearestExistingDirectory(resolved);
  const acl=probeAcl(inspectedPath,{powershell,spawn,timeoutMs});
  const validated=assertPrivateWindowsAcl(acl,{root:inspectedPath});
  let ancestor=path.dirname(inspectedPath);
  while(ancestor!==inspectedPath){
    const ancestorAcl=probeAcl(ancestor,{powershell,spawn,timeoutMs});
    assertPrivateWindowsAncestorAcl(ancestorAcl,{root:ancestor});
    const parent=path.dirname(ancestor);
    if(parent===ancestor)break;
    ancestor=parent;
  }
  return Object.freeze({root:resolved,inspectedPath,currentUserSid:validated.currentUserSid,ownerSid:validated.ownerSid});
}
