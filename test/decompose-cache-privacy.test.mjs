import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CORE_VERSION} from '../scripts/core/contracts.mjs';
import {DECOMPOSE_CACHE_SCHEMA} from '../scripts/core/orchestrate-sdk.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const entry=path.join(repo,'scripts','core','orchestrate-sdk.mjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-decompose-cache-privacy-'));
const controllerRoot=path.join(root,'controller');
const defaultHints={moduleToProj:{},foldRules:{},tailKeywords:['清爽','清理','保持干净','收尾','整理']};

after(()=>fs.rmSync(root,{recursive:true,force:true}));

function cacheHash(request){
  return crypto.createHash('sha1').update(CORE_VERSION+'|'+String(request||'')+'|'+JSON.stringify(defaultHints)).digest('hex');
}

function cacheFile(workspace){
  const workspaceId=crypto.createHash('sha256').update(fs.realpathSync(workspace).toLowerCase()).digest('hex');
  return path.join(controllerRoot,'decompose',workspaceId,'orchestrator-decompose-cache.json');
}

function seed(workspace,request,payload){
  const file=cacheFile(workspace);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(payload,null,2)+'\n','utf8');
  return file;
}

function runPlan(workspace,request){
  const env={...process.env,ORCH_AGENT:'codex',WORKSPACE_DIR:workspace,ORCH_CONTROLLER_ROOT:controllerRoot,
    ORCH_DECOMPOSE_RETRIES:'1',ORCH_MIN_FREE_MB:'0',ORCH_MIN_FREE_HARD_MB:'0'};
  for(const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','ORCH_TASK_HINTS','ORCH_TASK_FOLD','ORCH_TASK_TAIL','ORCH_RUN_ID','ORCH_STATE_DIR'])delete env[key];
  const result=spawnSync(process.execPath,[entry,'--plan',request],{
    cwd:repo,env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024,
  });
  return {status:result.status,stdout:String(result.stdout||''),stderr:String(result.stderr||''),error:result.error};
}

function validBlocks(title,prompt){
  return [{type:'independent',title,dependsOn:[],conflictKeys:[],tasks:[{id:'t1',title,prompt}]}];
}

test('sensitive requests bypass a legacy cache without reading, deleting, or rewriting it',()=>{
  const workspace=fs.mkdtempSync(path.join(root,'sensitive-workspace-'));
  const secret=providerFixtureToken('openai-named','cache-privacy-fixture-should-not-persist');
  const request=`项目80：清理残留 OPENAI_API_KEY=${secret}；项目81：清理残留 OPENAI_API_KEY=${secret}`;
  const file=seed(workspace,request,{
    // No schema deliberately models the pre-privacy cache.  An ordinary request
    // must invalidate it, but a credential-shaped request must never touch it.
    version:CORE_VERSION,
    entries:{[cacheHash(request)]:{createdAt:1,blocks:[{title:'malformed-cache-entry'}]}},
  });
  const before=fs.readFileSync(file,'utf8');
  try{
    const result=runPlan(workspace,request);
    assert.equal(result.error,undefined,String(result.error||''));
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/proj-80/,'the deterministic plan should still run without cache access');
    assert.match(result.stdout,/proj-81/,'the deterministic plan should still run without cache access');
    assert.equal(fs.readFileSync(file,'utf8'),before,'a sensitive request must not delete, repair, or write the pre-existing cache');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('ordinary requests safely invalidate a pre-privacy cache before rebuilding it',()=>{
  const workspace=fs.mkdtempSync(path.join(root,'legacy-workspace-'));
  const request='修复 README 排版';
  const file=seed(workspace,request,{
    version:CORE_VERSION,
    entries:{[cacheHash(request)]:{createdAt:1,blocks:validBlocks('legacy-cache-hit','LEGACY_CACHE_MARKER')}},
  });
  try{
    const result=runPlan(workspace,request);
    assert.equal(result.error,undefined,String(result.error||''));
    assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(result.stdout,/LEGACY_CACHE_MARKER/,'a cache from before the privacy schema cannot be replayed');
    const rebuilt=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(rebuilt.schema,DECOMPOSE_CACHE_SCHEMA,'the rebuilt cache must carry the current privacy schema');
    assert.ok(rebuilt.entries[cacheHash(request)],'ordinary deterministic plans still populate the cache');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('ordinary requests still reuse a current-schema cache entry',()=>{
  const workspace=fs.mkdtempSync(path.join(root,'ordinary-workspace-'));
  const request='修复 README 排版';
  seed(workspace,request,{
    schema:DECOMPOSE_CACHE_SCHEMA,
    version:CORE_VERSION,
    entries:{[cacheHash(request)]:{createdAt:1,blocks:validBlocks('ordinary-cache-hit','ORDINARY_CACHE_MARKER')}},
  });
  try{
    const result=runPlan(workspace,request);
    assert.equal(result.error,undefined,String(result.error||''));
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/ORDINARY_CACHE_MARKER/,'ordinary requests retain cache reuse');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('--plan stdout projects cached task prompts through credential redaction',()=>{
  const workspace=fs.mkdtempSync(path.join(root,'public-plan-workspace-'));
  const request='修复 README 排版';
  const openai=providerFixtureToken('openai-project');
  const github=providerFixtureToken('github-classic');
  seed(workspace,request,{
    schema:DECOMPOSE_CACHE_SCHEMA,
    version:CORE_VERSION,
    entries:{[cacheHash(request)]:{createdAt:1,blocks:validBlocks('cached-public-plan',`keep ordinary instructions; leaked ${openai}; leaked ${github}`)}},
  });
  try{
    const result=runPlan(workspace,request);
    assert.equal(result.error,undefined,String(result.error||''));
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/keep ordinary instructions/);
    assert.equal(result.stdout.includes(openai),false);
    assert.equal(result.stdout.includes(github),false);
    assert.match(result.stdout,/\[REDACTED\]/);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('a downgraded plugin invalidates but does not delete a newer cache schema',()=>{
  const workspace=fs.mkdtempSync(path.join(root,'future-workspace-'));
  const request='修复 README 排版';
  const file=seed(workspace,request,{
    schema:DECOMPOSE_CACHE_SCHEMA+1,
    version:CORE_VERSION,
    entries:{[cacheHash(request)]:{createdAt:1,blocks:validBlocks('future-cache-hit','FUTURE_CACHE_MARKER')}},
  });
  const before=fs.readFileSync(file,'utf8');
  try{
    const result=runPlan(workspace,request);
    assert.equal(result.error,undefined,String(result.error||''));
    assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(result.stdout,/FUTURE_CACHE_MARKER/,'an unknown newer cache format must not be replayed');
    assert.equal(fs.readFileSync(file,'utf8'),before,'a downgrade must preserve a newer plugin-owned cache for its owner');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
