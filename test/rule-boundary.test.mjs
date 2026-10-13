import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {testTempFamily} from './test-temp-root.mjs';
import {assertVisibleRuleBoundary, findVisibleRuleFiles, resolveCodexHomeFromWorkspace} from '../scripts/core/rule-boundary.mjs';

function fixture(prefix) {
  return fs.mkdtempSync(path.join(testTempFamily('rule-boundary'), prefix));
}

test('visible rule boundary accepts an empty user and project rule hierarchy', () => {
  const root=fixture('empty-');
  try {
    const workspace=path.join(root,'project','nested','workspace');
    const codexHome=path.join(root,'home');
    fs.mkdirSync(workspace,{recursive:true});
    fs.mkdirSync(codexHome,{recursive:true});
    assert.deepEqual(findVisibleRuleFiles({workspace,codexHome}),[]);
    assert.doesNotThrow(()=>assertVisibleRuleBoundary({workspace,codexHome}));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('CODEX_HOME resolves ordinary relative paths from the visible worker workspace and rejects ambiguous Windows forms', () => {
  const workspace=process.platform==='win32'?'C:\\workspace\\visible-worker':path.join(path.sep,'workspace','visible-worker');
  assert.equal(resolveCodexHomeFromWorkspace('relative-home',workspace),path.join(workspace,'relative-home'));
  if(process.platform==='win32'){
    for(const ambiguous of ['\\root-relative','/root-relative','C:drive-relative']){
      assert.throws(()=>resolveCodexHomeFromWorkspace(ambiguous,workspace),/CODEX_HOME_PATH_UNSAFE/,ambiguous);
    }
    assert.equal(resolveCodexHomeFromWorkspace('C:\\fully-qualified',workspace),'C:\\fully-qualified');
  }
});

test('visible rule boundary refuses user rules and every project ancestor rule layer', () => {
  const root=fixture('active-');
  try {
    const workspace=path.join(root,'project','nested','workspace');
    const codexHome=path.join(root,'home');
    const userRule=path.join(codexHome,'rules','default.rules');
    const ancestorRule=path.join(root,'project','.codex','rules','project.rules');
    fs.mkdirSync(path.dirname(userRule),{recursive:true});
    fs.mkdirSync(path.dirname(ancestorRule),{recursive:true});
    fs.writeFileSync(userRule,'prefix_rule(pattern=["echo"], decision="allow")','utf8');
    fs.writeFileSync(ancestorRule,'prefix_rule(pattern=["dir"], decision="allow")','utf8');
    fs.mkdirSync(workspace,{recursive:true});
    const found=findVisibleRuleFiles({workspace,codexHome});
    assert.deepEqual(new Set(found),new Set([userRule,ancestorRule]));
    assert.throws(()=>assertVisibleRuleBoundary({workspace,codexHome}),/VISIBLE_EXEC_POLICY_RULES_UNSAFE/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('visible rule boundary fails closed when a rule-layer path is a reparse point or non-directory', () => {
  const root=fixture('unsafe-');
  try {
    const workspace=path.join(root,'workspace');
    const codexHome=path.join(root,'home');
    const outside=path.join(root,'outside');
    fs.mkdirSync(workspace,{recursive:true});
    fs.mkdirSync(codexHome,{recursive:true});
    fs.mkdirSync(outside,{recursive:true});
    const configDir=path.join(workspace,'.codex');
    fs.mkdirSync(configDir,{recursive:true});
    const rules=path.join(configDir,'rules');
    try { fs.symlinkSync(outside,rules,process.platform==='win32'?'junction':'dir'); }
    catch { return; }
    assert.throws(()=>assertVisibleRuleBoundary({workspace,codexHome}),/VISIBLE_EXEC_POLICY_RULES_UNSAFE/);
    fs.rmSync(rules,{recursive:true,force:true});
    fs.writeFileSync(rules,'not a directory','utf8');
    assert.throws(()=>assertVisibleRuleBoundary({workspace,codexHome}),/VISIBLE_EXEC_POLICY_RULES_UNSAFE/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('visible launcher rejects an active rule before it creates controller artifacts', () => {
  const root=fixture('launcher-');
  try {
    const workspace=path.join(root,'workspace');
    const codexHome=path.join(root,'home');
    const rules=path.join(codexHome,'rules');
    fs.mkdirSync(workspace,{recursive:true});
    fs.mkdirSync(rules,{recursive:true});
    fs.writeFileSync(path.join(rules,'default.rules'),'prefix_rule(pattern=["echo"], decision="allow")','utf8');
    const script=path.join(root,'launch.mjs');
    const module=fileURLToPath(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url));
    fs.writeFileSync(script,`import {writeInteractiveLauncher} from ${JSON.stringify(pathToFileURL(module).href)};writeInteractiveLauncher('rule-boundary','ordinary task','fixture');`,'utf8');
    const result=spawnSync(process.execPath,[script],{
      cwd:workspace,encoding:'utf8',windowsHide:true,
      env:{...process.env,WORKSPACE_DIR:workspace,CODEX_HOME:codexHome,ORCH_AGENT:'codex',ORCH_SANDBOX:'workspace-write',ORCH_APPROVAL:'on-request',ORCH_TUI:'inactive'},
      timeout:30000,
    });
    assert.notEqual(result.status,0,result.stderr||result.stdout);
    assert.match(String(result.stderr||result.stdout),/VISIBLE_EXEC_POLICY_RULES_UNSAFE/);
    assert.equal(fs.existsSync(path.join(workspace,'temp','orchestrator','windows')),false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('visible launcher resolves a relative CODEX_HOME from the child workspace, not the controller cwd', () => {
  const root=fixture('relative-home-');
  try {
    const controller=path.join(root,'controller');
    const workspace=path.join(root,'workspace');
    const codexHome=path.join(workspace,'relative-home');
    const rules=path.join(codexHome,'rules');
    fs.mkdirSync(controller,{recursive:true});
    fs.mkdirSync(rules,{recursive:true});
    fs.writeFileSync(path.join(rules,'default.rules'),'prefix_rule(pattern=["echo"], decision="allow")','utf8');
    const script=path.join(root,'launch-relative.mjs');
    const module=fileURLToPath(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url));
    fs.writeFileSync(script,`import {writeInteractiveLauncher} from ${JSON.stringify(pathToFileURL(module).href)};writeInteractiveLauncher('relative-rule-boundary','ordinary task','fixture');`,'utf8');
    const result=spawnSync(process.execPath,[script],{
      cwd:controller,encoding:'utf8',windowsHide:true,
      env:{...process.env,WORKSPACE_DIR:workspace,CODEX_HOME:'relative-home',ORCH_AGENT:'codex',ORCH_SANDBOX:'workspace-write',ORCH_APPROVAL:'on-request',ORCH_TUI:'inactive'},
      timeout:30000,
    });
    assert.notEqual(result.status,0,result.stderr||result.stdout);
    assert.match(String(result.stderr||result.stdout),/VISIBLE_EXEC_POLICY_RULES_UNSAFE/);
    assert.equal(fs.existsSync(path.join(workspace,'temp','orchestrator','windows')),false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('launcher performs a final child-local rule check immediately before Codex', () => {
  const root=fixture('launcher-guard-');
  try {
    const controller=path.join(root,'controller');
    const workspace=path.join(root,'workspace');
    fs.mkdirSync(controller,{recursive:true});
    fs.mkdirSync(workspace,{recursive:true});
    const script=path.join(root,'write-launcher.mjs');
    const module=fileURLToPath(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url));
    fs.writeFileSync(script,`import {writeInteractiveLauncher} from ${JSON.stringify(pathToFileURL(module).href)};console.log(JSON.stringify(writeInteractiveLauncher('launcher-guard','ordinary task','fixture')));`,'utf8');
    const result=spawnSync(process.execPath,[script],{
      cwd:controller,encoding:'utf8',windowsHide:true,
      env:{...process.env,WORKSPACE_DIR:workspace,CODEX_HOME:'relative-home',ORCH_AGENT:'codex',ORCH_SANDBOX:'workspace-write',ORCH_APPROVAL:'on-request',ORCH_TUI:'inactive'},
      timeout:30000,
    });
    assert.equal(result.status,0,result.stderr||result.stdout);
    const launcher=JSON.parse(String(result.stdout).trim());
    const body=fs.readFileSync(launcher.lp,'utf8');
    const expectedHome=path.join(workspace,'relative-home').replace(/'/g,"''");
    assert.ok(body.includes("$env:CODEX_HOME = '"+expectedHome+"'"),'launcher exports the canonical child CODEX_HOME');
    const guardAt=body.indexOf('visible-rule-guard.mjs');
    const codexAt=body.indexOf('@agentArgs');
    assert.ok(guardAt>=0,'generated launcher contains the child-local rule guard');
    assert.ok(codexAt>=0&&guardAt<codexAt,'rule guard runs before the Codex invocation');
    assert.match(body,/Write-Result 3 'visible-rule-boundary'/,'rule guard writes an explicit non-acceptance result');
    assert.equal(body.includes('/* ignore */'),false,'launcher contains PowerShell comments, not JavaScript comment syntax');
    if(process.platform==='win32'){
      const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const syntax=spawnSync(powershell,['-NoProfile','-Command','$ErrorActionPreference="Stop"; [void][scriptblock]::Create([IO.File]::ReadAllText($env:ORCH_TEST_LAUNCHER))'],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,ORCH_TEST_LAUNCHER:launcher.lp}});
      assert.equal(syntax.status,0,syntax.stderr||syntax.stdout);
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('child-local rule guard refuses a rule introduced after launcher construction', () => {
  const root=fixture('child-guard-');
  try {
    const workspace=path.join(root,'workspace');
    const codexHome=path.join(root,'home');
    const guard=fileURLToPath(new URL('../scripts/core/visible-rule-guard.mjs',import.meta.url));
    fs.mkdirSync(workspace,{recursive:true});
    fs.mkdirSync(codexHome,{recursive:true});
    const clean=spawnSync(process.execPath,[guard,workspace,codexHome],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(clean.status,0,clean.stderr||clean.stdout);
    const rule=path.join(codexHome,'rules','late.rules');
    fs.mkdirSync(path.dirname(rule),{recursive:true});
    fs.writeFileSync(rule,'prefix_rule(pattern=["echo"], decision="allow")','utf8');
    const blocked=spawnSync(process.execPath,[guard,workspace,codexHome],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.notEqual(blocked.status,0,blocked.stderr||blocked.stdout);
    assert.match(String(blocked.stderr||blocked.stdout),/VISIBLE_EXEC_POLICY_RULES_UNSAFE/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
