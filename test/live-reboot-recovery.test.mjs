import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRebootBaseline,assessRebootRecovery} from './live-reboot-recovery.mjs';

const before={schema:1,id:'sample',runId:'reboot-sample',workspace:'C:/work',commit:'a'.repeat(40),releaseSha256:'b'.repeat(64),bootBefore:'2026-09-14T00:00:00Z',nonce:'nonce',ready:true};
const current={id:before.id,runId:before.runId,workspace:'C:/work',commit:before.commit,releaseSha256:before.releaseSha256,bootAfter:'2026-09-15T00:00:00Z'};
test('reboot recovery refuses unchanged boot, source drift and foreign baseline before resuming',()=>{
  assert.doesNotThrow(()=>validateRebootBaseline(before,current));
  for(const change of [{id:'other'},{runId:'reboot-other'},{bootAfter:before.bootBefore},{commit:'c'.repeat(40)},{releaseSha256:'d'.repeat(64)},{workspace:'C:/other'}])
    assert.throws(()=>validateRebootBaseline(before,{...current,...change}));
  assert.throws(()=>validateRebootBaseline({...before,ready:false},current));
});
test('reboot recovery requires every original task verified and exactly one effect per task',()=>{
  const summary={runId:before.runId,executionMode:'headless',generation:2,success:true,tasks:[{id:'T001'},{id:'T002'}],taskResults:{T001:{status:'verified'},T002:{status:'verified'}}};
  const receipts=['one','two'].map(id=>({nonce:'nonce',cwd:'C:/work',id,count:1,answer:42}));
  const result={exitCode:0,closed:true,summary,receipts,firstReceiptUnchanged:true};
  assert.equal(assessRebootRecovery(before,result),true);
  for(const change of [{exitCode:1},{closed:false},{firstReceiptUnchanged:false},{receipts:[receipts[0],{...receipts[1],count:2}]},{summary:{...summary,generation:1}},{summary:{...summary,taskResults:{...summary.taskResults,T002:{status:'needs-reconciliation'}}}}])
    assert.equal(assessRebootRecovery(before,{...result,...change}),false);
});
