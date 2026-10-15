import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertPrivateWindowsAcl,assertPrivateWindowsAncestorAcl,assertPrivateWindowsRoot} from '../scripts/core/private-root.mjs';
import {controllerStateDir} from '../scripts/core/controller-state.mjs';

const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');

function runPowerShell(script,input=''){
  return spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
    input,encoding:'utf8',windowsHide:true,shell:false,timeout:10_000,
  });
}

function makePrivateFixture(t){
  // The Windows temp tree is intentionally shared with AppContainer SIDs on
  // this host. Exercise the intended owner-private policy below the user
  // profile instead, then remove the exact disposable directory.
  const root=fs.mkdtempSync(path.join(os.homedir(),'orch-private-root-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
  return root;
}

function withPoisonedPowerShellEnvironment(run){
  const names=['PSModulePath','ORCH_PRIVATE_ROOT_AMBIENT'];
  const previous=new Map(names.map(name=>[name,process.env[name]]));
  process.env.PSModulePath='C:\\untrusted\\PowerShell\\Modules';
  process.env.ORCH_PRIVATE_ROOT_AMBIENT='must-not-reach-helper';
  try{return run();}
  finally{
    for(const name of names){
      const value=previous.get(name);
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
  }
}

function assertNarrowPowerShellEnvironment(options){
  const env=options.env;
  assert.ok(env,'the helper must receive an explicit environment');
  const keys=Object.keys(env).map(name=>name.toUpperCase());
  const allowed=new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','PATH']);
  // The narrow helper environment carries the caller's module analysis cache
  // location when one exists so PowerShell module auto-loading stays fast on
  // hosted images; machines without it keep the exact previous key set.
  if(process.env.PSModuleAnalysisCachePath)allowed.add('PSMODULEANALYSISCACHEPATH');
  assert.equal(keys.some(name=>!allowed.has(name)),false,`unexpected helper environment variables: ${keys.filter(name=>!allowed.has(name)).join(', ')}`);
  assert.equal(keys.includes('PSMODULEPATH'),false,'ambient PSModulePath must not reach the helper');
  assert.equal(keys.includes('ORCH_PRIVATE_ROOT_AMBIENT'),false,'unrelated parent variables must not reach the helper');
  assert.equal(String(env.WINDIR).toLowerCase(),String(env.SystemRoot).toLowerCase());
  assert.equal(String(env.ComSpec).toLowerCase(),path.join(env.SystemRoot,'System32','cmd.exe').toLowerCase());
  assert.equal(String(env.Path).toLowerCase(),[path.join(env.SystemRoot,'System32'),env.SystemRoot].join(';').toLowerCase(),'the helper PATH must be derived from the trusted system root');
}

test('private Windows root validator rejects UNC paths before invoking a helper',t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  let called=false;
  assert.throws(()=>assertPrivateWindowsRoot('\\\\server\\share\\controller',{
    powershell,
    spawn:()=>{called=true;throw new Error('must not run');},
  }),/PRIVATE_ROOT_UNC/);
  assert.equal(called,false);
});

test('private Windows root ACL probe excludes ambient PowerShell module paths from its helper',t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  const root=makePrivateFixture(t),calls=[];
  const snapshot=JSON.stringify({
    currentUserSid:'S-1-5-21-101-102-103-104',
    ownerSid:'S-1-5-21-101-102-103-104',
    rules:[],
  });
  withPoisonedPowerShellEnvironment(()=>assert.doesNotThrow(()=>assertPrivateWindowsRoot(root,{
    powershell,
    spawn:(_file,_args,options)=>{calls.push(options);return {status:0,stdout:snapshot};},
  })));
  assert.ok(calls.length>0,'the ACL probe must invoke its trusted helper');
  for(const options of calls)assertNarrowPowerShellEnvironment(options);
});

test('private Windows root validator accepts a current-user root and anchors a missing child at its nearest existing parent',t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  const root=makePrivateFixture(t);
  const result=assertPrivateWindowsRoot(path.join(root,'future','controller'),{powershell});
  assert.equal(result.root.toLowerCase(),path.resolve(root,'future','controller').toLowerCase());
  assert.equal(result.inspectedPath.toLowerCase(),path.resolve(root).toLowerCase());
  assert.match(result.currentUserSid,/^S-1-5-21-/i);
});

test('private Windows ACL validator permits only current user, LocalSystem, and Builtin Administrators to own or write the root',t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  const root=makePrivateFixture(t);
  const current=assertPrivateWindowsRoot(root,{powershell}).currentUserSid;
  const safe={
    ownerSid:current,
    currentUserSid:current,
    rules:[
      {sid:current,type:'Allow',rights:'2032127'},
      {sid:'S-1-5-18',type:'Allow',rights:'2032127'},
      {sid:'S-1-5-32-544',type:'Allow',rights:'2032127'},
    ],
  };
  assert.doesNotThrow(()=>assertPrivateWindowsAcl(safe,{root}));
  assert.doesNotThrow(()=>assertPrivateWindowsAcl({...safe,rules:[...safe.rules,{sid:'S-1-3-4',type:'Allow',rights:'2032127'}]},{root}),'OWNER RIGHTS resolves to the current owner');
  assert.throws(()=>assertPrivateWindowsAcl({...safe,ownerSid:'S-1-5-21-999-998-997-996',rules:[...safe.rules,{sid:'S-1-3-4',type:'Allow',rights:'2032127'}]},{root}),/PRIVATE_ROOT_UNSAFE_OWNER/);
  assert.throws(()=>assertPrivateWindowsAcl({...safe,ownerSid:'S-1-5-21-999-998-997-996'},{root}),/PRIVATE_ROOT_UNSAFE_OWNER.*S-1-5-21-999-998-997-996/);
  assert.throws(()=>assertPrivateWindowsAcl({...safe,rules:[...safe.rules,{sid:'S-1-5-11',type:'Allow',rights:'197055'}]},{root}),/PRIVATE_ROOT_UNSAFE_DACL.*S-1-5-11/);
});

test('private Windows root validator rejects an ancestor that can replace an existing root',t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  const root=makePrivateFixture(t);
  const current=assertPrivateWindowsRoot(root,{powershell}).currentUserSid;
  const safe={currentUserSid:current,rules:[{sid:'S-1-5-11',type:'Allow',rights:'65536',propagation:'InheritOnly'}]};
  assert.doesNotThrow(()=>assertPrivateWindowsAncestorAcl(safe,{root}));
  assert.throws(()=>assertPrivateWindowsAncestorAcl({...safe,rules:[{sid:'S-1-5-11',type:'Allow',rights:'65536',propagation:'None'}]},{root}),/PRIVATE_ROOT_UNSAFE_ANCESTOR.*S-1-5-11/);
});

test('private Windows root validator rejects a real DACL that grants Modify to Authenticated Users',t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  const root=makePrivateFixture(t);
  const script=[
    "$ErrorActionPreference='Stop'",
    "$target=[Console]::In.ReadToEnd().Trim()",
    "$acl=[IO.Directory]::GetAccessControl($target)",
    '$acl.SetAccessRuleProtection($true,$false)',
    '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$full=New-Object Security.AccessControl.FileSystemAccessRule($current,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    '$acl.SetAccessRule($full)',
    "$sharedSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-11')",
    "$shared=New-Object Security.AccessControl.FileSystemAccessRule($sharedSid,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    '$acl.AddAccessRule($shared)',
    '[IO.Directory]::SetAccessControl($target,$acl)',
  ].join(';');
  const changed=runPowerShell(script,root);
  assert.equal(changed.status,0,changed.stderr||changed.stdout);
  assert.throws(()=>assertPrivateWindowsRoot(root,{powershell}),/PRIVATE_ROOT_UNSAFE_DACL.*S-1-5-11/);
});

test('controller state refuses a caller-selected root writable by another Windows principal',t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  const fixture=makePrivateFixture(t),workspace=path.join(fixture,'workspace'),controller=path.join(fixture,'controller');
  fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(controller,{recursive:true});
  const script=[
    "$ErrorActionPreference='Stop'",
    '$target=[Console]::In.ReadToEnd().Trim()',
    '$acl=[IO.Directory]::GetAccessControl($target)',
    '$acl.SetAccessRuleProtection($true,$false)',
    '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$full=New-Object Security.AccessControl.FileSystemAccessRule($current,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    '$acl.SetAccessRule($full)',
    "$sharedSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-11')",
    "$shared=New-Object Security.AccessControl.FileSystemAccessRule($sharedSid,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    '$acl.AddAccessRule($shared)',
    '[IO.Directory]::SetAccessControl($target,$acl)',
  ].join(';');
  const changed=runPowerShell(script,controller);
  assert.equal(changed.status,0,changed.stderr||changed.stdout);
  assert.throws(()=>controllerStateDir(workspace,{ORCH_CONTROLLER_ROOT:controller}),/CONTROLLER_ROOT_UNSAFE_ACL/);
  assert.equal(fs.readdirSync(controller).length,0);
});
