import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {configureEntryArgs} from '../scripts/entry-options.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const entry=path.join(repo,'scripts','orchestrate-sdk.mjs');
function invoke(args,extra={}){
  const env={...process.env,...extra};
  delete env.CODEX_THREAD_ID;delete env.CODEX_SESSION_ID;
  delete env.WORKSPACE_DIR;delete env.ORCH_STATE_DIR;
  if(!Object.hasOwn(extra,'ORCH_AGENT'))delete env.ORCH_AGENT;
  return spawnSync(process.execPath,[entry,...args],{cwd:repo,env,encoding:'utf8',windowsHide:true,timeout:20000});
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
  const family=path.join(repo,'temp');fs.mkdirSync(family,{recursive:true});
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
test('public workspace and explicit CLI flags configure the engine before it loads',()=>{
  const family=path.join(repo,'temp');fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'public workspace-'));
  try{
    const lookup=spawnSync('where.exe',['codex.exe'],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(lookup.status,0,lookup.stderr||'codex.exe must be available for the explicit CLI test');
    const cli=String(lookup.stdout).split(/\r?\n/).map(value=>value.trim()).find(Boolean);
    assert.ok(cli&&path.isAbsolute(cli)&&fs.statSync(cli).isFile(),'explicit CLI fixture must be a real absolute executable');
    const result=invoke(['--workspace',workspace,'--agent','codex','--cli',cli,'--doctor'],{ORCH_ALLOW_UNVERIFIED_NPM:'1',ORCH_DIAGNOSTIC_FULL_PATHS:'1'});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.workspace,workspace);assert.equal(report.cli,cli);
    assert.equal(report.stateDir,path.join(workspace,'temp','orchestrator'));
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
test('dedicated public entry rejects another agent even when its CLI is installed',()=>{
  const result=invoke(['--doctor'],{ORCH_AGENT:'pi'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Codex-specific adapter requires Codex/i);
});
test('public options reject absent values and duplicate definitions before execution',()=>{
  for(const args of [['--workspace','--doctor'],['--agent'],['--cli','--doctor'],['--workspace','a','--workspace','b','--doctor']]){
    const result=invoke(args,{ORCH_AGENT:'codex'});
    assert.notEqual(result.status,0,JSON.stringify(args));
    assert.match(result.stderr,/needs a value|Duplicate option/);
  }
});

test('run and acceptance options cannot consume a mode or silently override each other',()=>{
  for(const args of [['--run-id','--doctor'],['--acceptance-file','--exec'],['--run-id','one','--run-id','two'],['--acceptance','a.json','--acceptance-file','b.json']]){
    assert.throws(()=>configureEntryArgs(args,{},repo),/needs a value|Duplicate option/);
  }
  const env={};
  const workspace=fs.mkdtempSync(path.join(repo,'temp','acceptance-entry-'));
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
  const replacement=path.join(repo,'temp','replacement.json');
  fs.mkdirSync(path.dirname(replacement),{recursive:true});fs.writeFileSync(replacement,'{}','utf8');
  try {
    assert.deepEqual(configureEntryArgs(['--verify-run','saved','--acceptance-file',replacement],env,repo),['--verify-run','saved']);
    assert.equal(env.ORCH_ACCEPTANCE_FILE,replacement);
  } finally { fs.rmSync(replacement,{force:true}); }
});
