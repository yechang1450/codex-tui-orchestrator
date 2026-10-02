import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {quoteWindowsArgument,spawnInactiveWindow,spawnInactiveWindowDetached} from '../scripts/core/inactive-window.mjs';

async function removeTreeWithRetry(root) {
 for(let attempt=0;;attempt++) {
  try { fs.rmSync(root,{recursive:true,force:true}); return; }
  catch(error) {
   if(!['EBUSY','EPERM','EACCES'].includes(error?.code)||attempt>=30)throw error;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
 }
}

test('inactive launch preserves arguments and hides only its short-lived helper',()=>{
 assert.equal(quoteWindowsArgument(''),'""');
 assert.equal(quoteWindowsArgument('a"b'),'"a\\"b"');
 assert.equal(quoteWindowsArgument('C:\\space dir\\'),'"C:\\space dir\\\\"');
 assert.throws(()=>quoteWindowsArgument('\0'),/NUL/);
 let called=0;
 spawnInactiveWindow('C:\\Windows\\powershell.exe',['中文 空格','a"b'],'D:\\',{invoke:(file,args,options)=>{
  called++;assert.equal(file,'powershell.exe');assert.equal(options.windowsHide,true);assert.equal(options.shell,false);
  assert.deepEqual(args.slice(0,5),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File']);
  const payload=JSON.parse(Buffer.from(args.at(-1),'base64').toString('utf8'));
  assert.equal(payload.cwd,'D:\\');assert.equal(payload.parameters,'"中文 空格" "a\\"b"');
  return {status:0};
 }});assert.equal(called,1);
});
test('inactive launch fails explicitly instead of falling back to a focusing window',()=>{
 assert.throws(()=>spawnInactiveWindow('missing',[],'D:\\',{invoke:()=>({status:1,stderr:'failed'})}),/INACTIVE_WINDOW_LAUNCH_FAILED/);
});
test('focus guard keeps the initiating window while typing unless the user actually switched focus',()=>{
 const source=fs.readFileSync(new URL('../scripts/core/inactive-window.ps1',import.meta.url),'utf8');
 assert.match(source,/if\(now\.dwTime!=baselineInput&&GetForegroundWindow\(\)!=baseline\)break/,
  'typing alone must not cancel focus restoration while the initiating window remains foreground');
 assert.match(source,/\[Console\]::OutputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'PowerShell diagnostics must use UTF-8 output');
 assert.match(source,/\$OutputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'PowerShell pipeline output must use UTF-8');
});

test('controlled focus probe exposes opt-in input diagnostics',()=>{
 const source=fs.readFileSync(new URL('./live-inactive-window.ps1',import.meta.url),'utf8');
 assert.match(source,/\[switch\]\$ContinuousInput/,
  'the live probe must expose an explicit opt-in continuous-input mode');
 assert.match(source,/inputDelivered/,
  'the live probe must report whether input reached the initiating window');
 assert.match(source,/inputLostFocus/,
  'the live probe must report whether the initiating window lost focus');
 assert.match(source,/\[Console\]::OutputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'live probe output must use UTF-8');
 assert.match(source,/\$OutputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'live probe pipeline output must use UTF-8');
});

test('historical input receipt retains its original core version',()=>{
 const file=new URL('./inactive-window-validation-1.3.4-rc.1.json',import.meta.url);
 const evidence=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(evidence.coreVersion,'1.3.4-rc.1');
 assert.equal(evidence.passed,true);
 assert.equal(evidence.skipped,false);
 assert.equal(evidence.inputMode,true);
 assert.equal(evidence.inputLostFocus,false);
 assert.ok(evidence.inputDelivered>0);
 assert.equal(evidence.targetForegroundEvents,0);
 assert.equal(evidence.closed,true);
});

test('asynchronous inactive launch preserves a hidden console for PowerShell',async()=>{
 let called=0,unref=0;
 const child=Object.assign(new EventEmitter(),{unref(){unref++;}});
 const result=spawnInactiveWindowDetached('C:\\Windows\\wt.exe',['-w','win-x'],'D:\\',{invoke:(file,args,options)=>{
  called++;assert.equal(file,'powershell.exe');assert.notEqual(options.detached,true);assert.equal(options.windowsHide,true);assert.equal(options.stdio,'ignore');
  const payload=JSON.parse(Buffer.from(args.at(-1),'base64').toString('utf8'));
  assert.equal(payload.file,'C:\\Windows\\wt.exe');assert.equal(payload.cwd,'D:\\');assert.equal(payload.parameters,'"-w" "win-x"');
  return child;
 }});
 assert.equal(result,child);assert.equal(called,1);assert.equal(unref,0);
 child.emit('exit',0);
 assert.deepEqual(await result.launchResult,{ok:true});
});

test('a fresh controller stays alive until asynchronous helper startup settles',{skip:process.platform!=='win32'},()=>{
 const module=new URL('../scripts/core/inactive-window.mjs',import.meta.url).href;
 const source=`import {spawnInactiveWindowDetached} from ${JSON.stringify(module)};const helper=spawnInactiveWindowDetached(process.execPath,['-e',''],process.cwd());if(!(await helper.launchResult).ok)throw new Error('launch failed');console.log('launch settled');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:process.cwd(),windowsHide:true,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/launch settled/);
});

test('real asynchronous helper executes its payload before reporting success',{skip:process.platform!=='win32'},async()=>{
 const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'launch-helper-')),receipt=path.join(root,'receipt.json');
 let child;
 try {
  child=spawnInactiveWindowDetached(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({nonce:'owned-probe',cwd:process.cwd()}))`],root);
  child.ref();
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('helper exit '+code)));});
  const end=Date.now()+3000;while(!fs.existsSync(receipt)&&Date.now()<end)await new Promise(r=>setTimeout(r,25));
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt,'utf8')),{nonce:'owned-probe',cwd:root});
 }finally{if(child&&child.exitCode===null)child.kill();await removeTreeWithRetry(root);}
});

test('asynchronous helper reports spawn and native launch errors',async()=>{
 const missing=spawnInactiveWindowDetached('unused',[],process.cwd(),{invoke:(_f,_a,options)=>spawn('orchestrator-intentionally-missing-executable',[],options)});
 missing.ref();assert.match((await missing.launchResult).error,/ENOENT/);
 const failed=Object.assign(new EventEmitter(),{unref(){}});
 const result=spawnInactiveWindowDetached('unused',[],process.cwd(),{invoke:()=>failed});
 failed.emit('exit',1);assert.deepEqual(await result.launchResult,{ok:false,error:'helper exited with code 1'});
});
