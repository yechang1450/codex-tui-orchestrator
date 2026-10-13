import {test} from 'node:test';
import assert from 'node:assert/strict';

let samplerModule;
let samplerImportError;
try{samplerModule=await import('../scripts/core/memory-sampler.mjs');}
catch(error){samplerImportError=error;}

test('one run-level sampler fans one process snapshot out to all active windows',async()=>{
 assert.equal(samplerImportError,undefined,'the run-level memory sampler module must load');
 assert.equal(typeof samplerModule?.createRunMemorySampler,'function','the runner needs one shared memory sampler');
 const timers=[],cleared=[];
 const availableReads=[10_000,10_000,9_500];
 let snapshotCalls=0;
 const sampler=samplerModule.createRunMemorySampler({
  sampleProcessSnapshot:async()=>{
   snapshotCalls++;
   return new Map([
    [101,{ProcessId:101,ParentProcessId:1,WorkingSet64:10*1024**2}],
    [102,{ProcessId:102,ParentProcessId:101,WorkingSet64:5*1024**2}],
    [201,{ProcessId:201,ParentProcessId:1,WorkingSet64:8*1024**2}],
   ]);
  },
  availableMemoryMB:()=>availableReads.shift(),
  setIntervalFn:(callback,delay)=>{const timer={callback,delay};timers.push(timer);return timer;},
  clearIntervalFn:timer=>cleared.push(timer),
  intervalMs:5_000,
 });
 const first=sampler.start('B1',{ProcessId:101});
 const second=sampler.start('B2',{ProcessId:201});
 assert.equal(timers.length,1,'active windows in one run must share one timer');
 assert.equal(timers[0].delay,5_000);
 await sampler.sample();
 assert.equal(snapshotCalls,1,'one sampling round must perform one snapshot');
 assert.equal(first.peakProcessMB,15,'a tree sample must include the owned child process');
 assert.equal(second.peakProcessMB,8);
 assert.equal(first.minAvailable,9_500);
 assert.equal(second.minAvailable,9_500,'one available-memory read must fan out to every active window');
 assert.strictEqual(sampler.stop('B1'),first);
 assert.equal(cleared.length,0,'stopping one of several windows keeps the shared timer alive');
 assert.strictEqual(sampler.stop('B2'),second);
 assert.deepEqual(cleared,[timers[0]],'the final active window must clear the shared timer');
});

test('a skipped background sample leaves active window statistics unchanged',async()=>{
 assert.equal(samplerImportError,undefined,'the run-level memory sampler module must load');
 const timers=[];
 const sampler=samplerModule.createRunMemorySampler({
  sampleProcessSnapshot:async()=>null,
  availableMemoryMB:()=>8_000,
  setIntervalFn:callback=>{const timer={callback};timers.push(timer);return timer;},
  clearIntervalFn:()=>{},
 });
 const stats=sampler.start('B1',{ProcessId:101});
 assert.equal(await sampler.sample(),false,'a busy low-priority snapshot is an intentionally skipped sample');
 assert.equal(stats.peakProcessMB,0);
 assert.equal(stats.minAvailable,Infinity,'a skipped sample must not manufacture a memory minimum');
 sampler.dispose();
 assert.equal(timers.length,1);
});

test('a late shared sample cannot update a block after that block has stopped',async()=>{
 assert.equal(samplerImportError,undefined,'the run-level memory sampler module must load');
 let resolveSnapshot,calls=0;
 const sampler=samplerModule.createRunMemorySampler({
  sampleProcessSnapshot:()=>{calls++;return new Promise(resolve=>{resolveSnapshot=resolve;});},
  availableMemoryMB:()=>9_000,
  setIntervalFn:()=>({}),
  clearIntervalFn:()=>{},
 });
 const stats=sampler.start('B1',{ProcessId:101});
 const first=sampler.sample();
 const second=sampler.sample();
 assert.strictEqual(second,first,'one run must never start overlapping background observations');
 assert.equal(calls,1);
 sampler.stop('B1');
 resolveSnapshot(new Map([[101,{ProcessId:101,ParentProcessId:1,WorkingSet64:10*1024**2}]]));
 assert.equal(await first,true);
 assert.equal(stats.peakProcessMB,0,'a completed block must freeze before a late sample is distributed');
 assert.equal(stats.minAvailable,Infinity);
});

test('a late sample from an earlier attempt cannot update a restarted block with the same key',async()=>{
  assert.equal(samplerImportError,undefined,'the run-level memory sampler module must load');
  let resolveSnapshot;
  const sampler=samplerModule.createRunMemorySampler({
   sampleProcessSnapshot:()=>new Promise(resolve=>{resolveSnapshot=resolve;}),
   availableMemoryMB:()=>9_000,
   setIntervalFn:()=>({}),
   clearIntervalFn:()=>{},
  });
  const firstAttempt=sampler.start('B1',{ProcessId:101});
  const pending=sampler.sample();
  sampler.stop('B1');
  const retryAttempt=sampler.start('B1',{ProcessId:202});
  resolveSnapshot(new Map([
   [101,{ProcessId:101,ParentProcessId:1,WorkingSet64:10*1024**2}],
   [202,{ProcessId:202,ParentProcessId:1,WorkingSet64:20*1024**2}],
  ]));
  assert.equal(await pending,true);
  assert.equal(firstAttempt.peakProcessMB,0,'the stopped attempt must remain frozen');
  assert.equal(retryAttempt.peakProcessMB,0,'an old observation must not cross an attempt boundary');
  assert.equal(retryAttempt.minAvailable,Infinity);
  sampler.dispose();
});

test('a synchronous snapshot-hook failure clears the shared in-flight slot for the next sample',async()=>{
  assert.equal(samplerImportError,undefined,'the run-level memory sampler module must load');
  let calls=0;
  const sampler=samplerModule.createRunMemorySampler({
   sampleProcessSnapshot:()=>{
    calls++;
    if(calls===1)throw new Error('synthetic synchronous snapshot failure');
    return new Map([[101,{ProcessId:101,ParentProcessId:1,WorkingSet64:10*1024**2}]]);
   },
   availableMemoryMB:()=>9_000,
   setIntervalFn:()=>({}),
   clearIntervalFn:()=>{},
  });
  const stats=sampler.start('B1',{ProcessId:101});
  assert.equal(await sampler.sample(),false);
  assert.equal(await sampler.sample(),true,'the next round must not reuse a completed failed promise');
  assert.equal(calls,2);
  assert.equal(stats.peakProcessMB,10);
  sampler.dispose();
});
