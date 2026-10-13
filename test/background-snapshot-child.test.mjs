import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

let helper,importError;
try{helper=await import('../scripts/core/background-snapshot-child.mjs');}catch(error){importError=error;}

function neverClosingChild(){
 const child=new EventEmitter();
 child.stdout=new PassThrough();
 child.killCalls=0;child.unrefCalls=0;
 child.kill=()=>{child.killCalls++;return true;};
 child.unref=()=>{child.unrefCalls++;};
 return child;
}

test('an aborted background helper settles after a bounded grace even when its child never closes',async()=>{
 assert.equal(importError,undefined,'the private background child helper module must load');
 assert.equal(typeof helper?.runBackgroundSnapshotHelper,'function');
 const controller=new AbortController(),child=neverClosingChild();
 const result=helper.runBackgroundSnapshotHelper({
  command:'fake-powershell',args:[],spawnOptions:{},signal:controller.signal,maxOutputBytes:1024,timeoutMs:100,
  runtime:{spawnImpl:()=>child,terminationGraceMs:10},
 });
 controller.abort();
 assert.equal(await result,null,'caller cancellation must settle even when close never arrives');
 assert.equal(child.killCalls,1,'the helper may terminate only its owned child handle');
 assert.equal(child.unrefCalls,1,'a non-closing owned child must not retain the caller event loop');
});

test('a timed-out background helper rejects after the same bounded grace when its child never closes',async()=>{
 assert.equal(importError,undefined,'the private background child helper module must load');
 const child=neverClosingChild();
 await assert.rejects(
  helper.runBackgroundSnapshotHelper({
   command:'fake-powershell',args:[],spawnOptions:{},maxOutputBytes:1024,timeoutMs:1,
   runtime:{spawnImpl:()=>child,terminationGraceMs:10},
  }),
  /Background process snapshot timed out/,
 );
 assert.equal(child.killCalls,1);
 assert.equal(child.unrefCalls,1);
});
