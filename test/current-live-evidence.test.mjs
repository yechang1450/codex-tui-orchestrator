import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('historical 1.3.4 live evidence retains focus, adoption and blocked capacity results',()=>{
 const focus=JSON.parse(fs.readFileSync(new URL('./inactive-window-validation-1.3.4-rc.1.json',import.meta.url),'utf8'));
 const adoption=JSON.parse(fs.readFileSync(new URL('./controller-adoption-validation-1.3.4-rc.1.json',import.meta.url),'utf8'));
 const cacheAdoption=JSON.parse(fs.readFileSync(new URL('./controller-adoption-validation-1.3.4-rc.1-cache.json',import.meta.url),'utf8'));
 const concurrency=JSON.parse(fs.readFileSync(new URL('./concurrency-validation-1.3.4-rc.1.json',import.meta.url),'utf8'));
 for(const evidence of [focus,adoption]){
  assert.equal(evidence.schema,1);
  assert.equal(evidence.coreVersion,'1.3.4-rc.1');
  assert.match(evidence.releaseJsonSha256,/^[a-f0-9]{64}$/);
  assert.equal(evidence.passed,true);
 }
 assert.equal(focus.inputLostFocus,false);
 assert.equal(focus.targetForegroundEvents,0);
 assert.equal(focus.closed,true);
 assert.equal(adoption.controllerCrashInjected,true);
 assert.equal(adoption.adoptedSameLauncher,true);
 assert.equal(adoption.windowLaunches,1);
 assert.equal(adoption.attempts,1);
 assert.equal(adoption.firstTaskExecutions,1);
 assert.equal(adoption.generation,2);
 assert.equal(cacheAdoption.coreVersion,'1.3.4-rc.1');
 assert.equal(cacheAdoption.status,'blocked');
 assert.equal(cacheAdoption.passed,false);
 assert.equal(concurrency.coreVersion,'1.3.4-rc.1');
 assert.match(concurrency.releaseJsonSha256,/^[a-f0-9]{64}$/);
 assert.equal(concurrency.status,'blocked');
 assert.equal(concurrency.capacity,12);
 assert.equal(concurrency.tasks,13);
 assert.equal(concurrency.result.passed,false);
 assert.equal(concurrency.result.peak,6);
 assert.equal(concurrency.result.receiptsValid,false);
 assert.equal(concurrency.plannerBlocks,12);
 assert.equal(concurrency.block.status,'needs-reconciliation');
});
