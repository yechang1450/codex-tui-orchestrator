// Collect compact evidence after the opt-in live tests and both regression suites finish.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [capacityRoot,adoptionRoot,fallbackRoot,peer,cache]=process.argv.slice(2);
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const reports=[capacityRoot,adoptionRoot,fallbackRoot].map(root=>json(path.join(root,'report.json')));
const [capacity,adoption,fallback]=reports;
assert.equal(capacity.passed,true);assert.equal(adoption.passed,true);assert.equal(fallback.passed,false);
const files=fs.readdirSync(path.join(repo,'scripts','core')).filter(n=>/\.(mjs|ps1|txt)$/.test(n)).sort();
const hashes=Object.fromEntries(files.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'scripts','core',n))).digest('hex')]));
const coreHash=crypto.createHash('sha256').update(files.map(n=>n+':'+hashes[n]).join('\n')).digest('hex');
const regressions=[repo,peer].map(root=>{
 const log=fs.readFileSync(path.join(root,'temp','recovery-full.log'),'utf8');
 const counts=Object.fromEntries(['tests','pass','fail'].map(k=>[k,Number(new RegExp('^# '+k+' (\\d+)$','m').exec(log)?.[1])]));
 assert.equal(counts.fail,0);assert.equal(counts.tests,115);assert.equal(counts.pass,115);return {root,...counts};
});
const current=json(path.join(adoption.workspace,'temp','orchestrator','runs',adoption.runId,'summary.json'));
assert.equal(current.success,true);assert.equal(current.generation,3);assert.equal(current.results.B1.attempts.length,1);
const tokens=reports.flatMap(r=>Object.values(r.summary.results).map(b=>b.token));
const date=new Date(Math.min(...reports.map(r=>r.summary.startedAt)));
const day=[String(date.getFullYear()),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')];
const sessionDir=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions',...day);
const policies=[];
for(const name of fs.readdirSync(sessionDir)) {
 const file=path.join(sessionDir,name);if(!name.endsWith('.jsonl')||fs.statSync(file).mtimeMs<date.getTime()-10000)continue;
 const raw=fs.readFileSync(file,'utf8'),token=tokens.find(t=>raw.includes(t));if(!token)continue;
 const rows=raw.split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {};}});
 const meta=rows.find(r=>r.type==='session_meta')?.payload,turns=rows.filter(r=>r.type==='turn_context').map(r=>r.payload);
 if(!meta||!turns.length)continue;
 assert.equal(meta.cwd,capacity.workspace);assert.equal(meta.model_provider,'orchestrator-openai-https');
 for(const turn of turns){assert.equal(turn.approval_policy,'never');assert.equal(turn.sandbox_policy.type,'danger-full-access');}
 policies.push({token,sessionFile:file,cwd:meta.cwd,provider:meta.model_provider,approval:'never',sandbox:'danger-full-access'});
}
assert.equal(new Set(policies.map(p=>p.token)).size,tokens.length,'every visible session must have runtime policy evidence');
const snapshot=processSnapshot();
for(const r of reports)for(const b of Object.values(r.summary.results))assert.ok(!sameProcess(b.launcher,snapshot.get(b.launcher?.ProcessId)));
const sharedCore=fs.realpathSync(path.join(repo,'scripts','core'));
for(const root of [peer,cache])assert.equal(fs.realpathSync(path.join(root,'scripts','core')),sharedCore);
const report={testedAt:new Date().toISOString(),coreVersion:current.version,finalCoreHash:coreHash,hashes,sharedCore,regressions,
 capacity:{runId:capacity.runId,root:capacityRoot,passed:capacity.passed,coreHash:capacity.coreHashAtLaunch,coreUnchanged:capacity.coreUnchanged,peak:capacity.peak,windowLaunches:capacity.windowLaunches,tasks:capacity.results.length,ordered:capacity.ordered,overlap:capacity.overlap,overlapMs:Math.min(...capacity.results.slice(0,8).map(r=>r.finished))-Math.max(...capacity.results.slice(0,8).map(r=>r.started)),engineExit:capacity.engineResult.code,pollExit:capacity.pollResult.code,results:capacity.results},
 adoption:{runId:adoption.runId,root:adoptionRoot,passed:adoption.passed,coreHash:adoption.coreHash,coreUnchanged:adoption.coreUnchanged,windowLaunches:adoption.windowLaunches,firstTaskExecutions:adoption.firstTaskExecutions,adoptedSameLauncher:adoption.adoptedSameLauncher,closed:adoption.closed},
 rejectedScenario:{runId:fallback.runId,root:fallbackRoot,passed:false,engineSuccess:fallback.summary.success,reason:'Punctuation split the test request into unassignable fragments; complete-inventory fallback preserved all tasks but opened only one window. Not counted as capacity success.'},
 postLiveFix:{files:['runner.mjs','recovery.mjs'],description:'Preserve execution checkpoints after failed rechecks and status changes, including when the separate checkpoint file is missing.',regression:'failed rechecks preserve execution evidence so a later resume cannot repeat an uncertain task',redObserved:true,finalRegressionsPassed:true,liveFinishedRunRecheck:{runId:current.runId,generation:current.generation,success:current.success,newWindows:0,attempts:current.results.B1.attempts.length},note:'Capacity and crash-adoption live runs precede this small evidence-retention fix; final core has full regression and an actual completed-run resume check, not a repeated 8-window run.'},
 policies,allLaunchersClosed:true,cleanup:{status:'pending',retainedRunRecords:true}};
for(const root of [repo,peer,cache]){fs.mkdirSync(path.join(root,'test'),{recursive:true});fs.writeFileSync(path.join(root,'test','recovery-live-result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({report:path.join(repo,'test','recovery-live-result.json'),regressions,policies:policies.length,peak:report.capacity.peak,overlapMs:report.capacity.overlapMs,closed:true}));
