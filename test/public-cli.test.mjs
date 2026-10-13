import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {configureEntryArgs} from '../scripts/entry-options.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const entry=path.join(repo,'scripts','orchestrate-sdk.mjs');
// A public doctor verifies the selected Windows executable more than once
// before reporting it.  Authenticode evaluation can legitimately exceed the
// former 20-second harness cap on a busy host, while the product process is
// still healthy and bounded by its own verification timeouts.
const PUBLIC_ENTRY_TIMEOUT_MS=90_000;
function invoke(args,extra={}){
  const env={...process.env,...extra};
  delete env.CODEX_THREAD_ID;delete env.CODEX_SESSION_ID;
  delete env.WORKSPACE_DIR;delete env.ORCH_STATE_DIR;
  if(!Object.hasOwn(extra,'ORCH_AGENT'))delete env.ORCH_AGENT;
  return spawnSync(process.execPath,[entry,...args],{cwd:repo,env,encoding:'utf8',windowsHide:true,timeout:PUBLIC_ENTRY_TIMEOUT_MS});
}
test('dedicated public doctor works outside a Codex conversation',()=>{
  const result=invoke(['--doctor']);
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.agent,'codex');
  for(const key of ['cli','workspace','stateDir'])assert.match(report[key],/^<redacted:[a-f0-9]{12}>$/,`${key} must be redacted by default`);
  const full=invoke(['--doctor'],{ORCH_DIAGNOSTIC_FULL_PATHS:'1'});
  assert.equal(full.status,0,full.stderr);
  const fullReport=JSON.parse(full.stdout);
  assert.equal(fullReport.agent,'codex');assert.equal(fullReport.workspace,path.resolve(repo));
  assert.ok(path.isAbsolute(fullReport.cli));assert.ok(path.isAbsolute(fullReport.stateDir));
});
test('--plan-file reads the request and enters the same read-only planner as --plan',()=>{
  const family=testTempFamily('public-cli');fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'public-plan-file-'));
  try{
    const request=path.join(workspace,'request.txt');
    fs.writeFileSync(request,'只读检查 node --version 的结果\n','utf8');
    const result=invoke(['--workspace',workspace,'--plan-file',request],{ORCH_AGENT:'codex'});
    assert.equal(result.status,0,result.stderr);
    const plan=JSON.parse(result.stdout);
    assert.ok(Array.isArray(plan.blocks)&&plan.blocks.length>0);
    const missing=invoke(['--workspace',workspace,'--plan-file',path.join(workspace,'missing.txt')],{ORCH_AGENT:'codex'});
    assert.notEqual(missing.status,0);
    assert.match(missing.stderr,/PLAN_FILE_/);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
test('--plan-file rejects a workspace junction that resolves outside its bound root',t=>{
  const family=testTempFamily('public-cli');fs.mkdirSync(family,{recursive:true});
  const parent=fs.mkdtempSync(path.join(family,'public-plan-junction-'));
  const workspace=path.join(parent,'workspace'),outside=path.join(parent,'outside');
  try{
    fs.mkdirSync(workspace);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'request.txt'),'outside request','utf8');
    try {fs.symlinkSync(outside,path.join(workspace,'linked'),'junction');}
    catch {return t.skip('Windows junctions are unavailable to this account');}
    assert.throws(()=>configureEntryArgs(['--workspace',workspace,'--plan-file',path.join(workspace,'linked','request.txt')],{},workspace),/PLAN_FILE_UNREADABLE/);
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
});
test('public workspace and explicit CLI flags configure the engine before it loads',()=>{
  const family=testTempFamily('public-cli');fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'public workspace-'));
  try{
    const lookup=spawnSync('where.exe',['codex.exe'],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(lookup.status,0,lookup.stderr||'codex.exe must be available for the explicit CLI test');
    const cli=String(lookup.stdout).split(/\r?\n/).map(value=>value.trim()).find(Boolean);
    assert.ok(cli&&path.isAbsolute(cli)&&fs.statSync(cli).isFile(),'explicit CLI fixture must be a real absolute executable');
    const result=invoke(['--workspace',workspace,'--cli',cli,'--doctor'],{ORCH_ALLOW_UNVERIFIED_NPM:'1',ORCH_DIAGNOSTIC_FULL_PATHS:'1'});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.workspace,workspace);assert.equal(report.cli,cli);
    assert.equal(report.stateDir,path.join(workspace,'temp','orchestrator'));
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
test('dedicated public entry rejects another agent even when its CLI is installed',()=>{
  const result=invoke(['--doctor'],{ORCH_AGENT:'foreign-agent'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Codex-specific adapter requires Codex/i);
});
test('public options do not expose agent selection for a Codex-only plugin',()=>{
  const env={};
  assert.throws(
    ()=>configureEntryArgs(['--agent','codex','--doctor'],env,repo),
    /AGENT_OPTION_UNSUPPORTED: this plugin always uses Codex/,
  );
});
test('public options reject absent values and duplicate definitions before execution',()=>{
  for(const args of [['--workspace','--doctor'],['--cli','--doctor'],['--workspace','a','--workspace','b','--doctor']]){
    const result=invoke(args,{ORCH_AGENT:'codex'});
    assert.notEqual(result.status,0,JSON.stringify(args));
    assert.match(result.stderr,/needs a value|Duplicate option/);
  }
});

test('a host-bound desktop turn rejects a different workspace before entry parsing mutates its environment',()=>{
  const family=testTempFamily('public-cli');fs.mkdirSync(family,{recursive:true});
  const host=fs.mkdtempSync(path.join(family,'host-workspace-'));
  const requested=fs.mkdtempSync(path.join(family,'requested-workspace-'));
  try{
    const env={
      CODEX_THREAD_ID:'11111111-1111-4111-8111-111111111111',
      CODEX_PERMISSION_PROFILE:':danger-full-access',
      CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY:'host-binding-opaque',
      WORKSPACE_DIR:host,
    };
    const binding=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:host});
    assert.throws(
      ()=>configureEntryArgs(['--workspace',requested,'--doctor'],env,host,{initiatorContext:binding}),
      /workspace differs from host-bound initiating workspace/,
    );
    assert.equal(env.WORKSPACE_DIR,host,'a rejected override must not rewrite the host workspace');
  }finally{
    fs.rmSync(host,{recursive:true,force:true});
    fs.rmSync(requested,{recursive:true,force:true});
  }
});

test('a host-bound desktop turn accepts a supported extended alias of the same workspace',()=>{
  const family=testTempFamily('public-cli');fs.mkdirSync(family,{recursive:true});
  const host=fs.mkdtempSync(path.join(family,'host-workspace-alias-'));
  try{
    const env={
      CODEX_THREAD_ID:'22222222-2222-4222-8222-222222222222',
      WORKSPACE_DIR:host,
    };
    const binding=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:`\\\\?\\${host}`});
    assert.doesNotThrow(()=>configureEntryArgs(['--workspace',host,'--doctor'],env,host,{initiatorContext:binding}));
    assert.equal(env.WORKSPACE_DIR,host);
  }finally{fs.rmSync(host,{recursive:true,force:true});}
});

test('a host-bound desktop turn refuses a missing immutable workspace snapshot',()=>{
  const family=testTempFamily('public-cli');fs.mkdirSync(family,{recursive:true});
  const host=fs.mkdtempSync(path.join(family,'host-workspace-missing-binding-'));
  try{
    const env={
      CODEX_THREAD_ID:'33333333-3333-4333-8333-333333333333',
      WORKSPACE_DIR:host,
    };
    const binding=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:''});
    assert.throws(
      ()=>configureEntryArgs(['--workspace',host,'--doctor'],env,host,{initiatorContext:binding}),
      /host workspace binding missing/,
    );
    assert.equal(env.WORKSPACE_DIR,host);
  }finally{fs.rmSync(host,{recursive:true,force:true});}
});

test('run and acceptance options cannot consume a mode or silently override each other',()=>{
  for(const args of [['--run-id','--doctor'],['--acceptance-file','--exec'],['--run-id','one','--run-id','two'],['--acceptance','a.json','--acceptance-file','b.json']]){
    assert.throws(()=>configureEntryArgs(args,{},repo),/needs a value|Duplicate option/);
  }
  const env={};
  const workspace=fs.mkdtempSync(path.join(testTempFamily('public-cli'),'acceptance-entry-'));
  try{
    const acceptance=path.join(workspace,'checks.json');fs.writeFileSync(acceptance,'{}','utf8');
    assert.deepEqual(configureEntryArgs(['--workspace',workspace,'--run-id','demo','--acceptance-file',acceptance,'--exec','Create the report'],env,repo),['--exec','Create the report']);
    assert.equal(env.ORCH_RUN_ID,'demo');
    assert.equal(env.ORCH_ACCEPTANCE_FILE,acceptance);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('option-like words inside a request remain task data',()=>{
  const env={};
  const args=['--exec','修复','--workspace','参数与','--acceptance-file','文档'];
  assert.deepEqual(configureEntryArgs(args,env,repo),args);
  assert.deepEqual(env,{});
});

test('verification options after the positional run ID remain supported',()=>{
  const env={};
  const workspace=fs.mkdtempSync(path.join(testTempFamily('public-cli'),'verification-workspace-'));
  const replacement=path.join(workspace,'replacement.json');
  fs.writeFileSync(replacement,'{}','utf8');
  try {
    assert.deepEqual(configureEntryArgs(['--verify-run','saved','--acceptance-file',replacement],env,workspace),['--verify-run','saved']);
    assert.equal(env.ORCH_ACCEPTANCE_FILE,replacement);
  } finally { fs.rmSync(workspace,{recursive:true,force:true}); }
});
