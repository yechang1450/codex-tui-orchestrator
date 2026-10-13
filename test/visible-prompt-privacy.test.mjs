import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-visible-privacy-'));
const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
process.env.ORCH_AGENT='codex';
process.env.WORKSPACE_DIR=workspace;
process.env.ORCH_CONTROLLER_ROOT=path.join(root,'controller');
process.env.ORCH_SANDBOX='danger-full-access';
process.env.ORCH_APPROVAL='never';
const {writeInteractiveLauncher,extractTasks}=await import('../scripts/core/orchestrate-sdk.mjs');
const {controllerWindowsDir}=await import('../scripts/core/controller-state.mjs');
after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('visible TUI refuses credential-shaped task text because the official interactive CLI accepts its initial prompt as a process argument',()=>{
  const prompts=[
    'complete task OPENAI_API_KEY=PRIVATE⟪visible-prompt-secret⟫',
    'complete task AWS_SECRET_ACCESS_KEY=aws-secret-access-key-fixture',
    'complete task DATABASE_URL=postgresql://demo:fixture-password@db.example.invalid:5432/app',
  ];
  for(const prompt of prompts)assert.throws(()=>writeInteractiveLauncher('private-visible',prompt,'privacy'),/Visible TUI refuses credential-shaped task text/);
  const dir=controllerWindowsDir(workspace);
  if(fs.existsSync(dir))assert.equal(fs.readdirSync(dir).some(name=>name.includes('private-visible-privacy')),false);
});

test('visible TUI refuses credential-shaped title or suffix before creating controller artifacts',()=>{
  const dir=controllerWindowsDir(workspace);
  const before=fs.existsSync(dir)?fs.readdirSync(dir).sort():[];
  const secret=providerFixtureToken('openai-project');
  for(const [title,suffix] of [[`OPENAI_API_KEY=${secret}`,'ordinary'],['ordinary',`access_token=${secret}`]]){
    assert.throws(
      ()=>writeInteractiveLauncher(title,'complete ordinary task',suffix),
      /Visible TUI refuses credential-shaped launcher identity/,
    );
  }
  const after=fs.existsSync(dir)?fs.readdirSync(dir).sort():[];
  assert.deepEqual(after,before,'the rejection must happen before a launcher artifact is created');
  assert.equal(after.some(name=>name.includes(secret)),false,'credential text must never enter a durable filename');
});

test('visible launcher confines an untrusted suffix to its controller window directory',()=>{
  const dir=controllerWindowsDir(workspace);
  let files;
  try{
    files=writeInteractiveLauncher('ordinary-visible','complete ordinary task','\\..\\..\\outside-controller');
    for(const file of [files.lp,files.pf,files.pidf,files.rf]){
      const relative=path.relative(dir,file);
      assert.equal(relative.startsWith('..')||path.isAbsolute(relative),false,`launcher artifact escaped its controller directory: ${file}`);
    }
  }finally{
    if(files)for(const file of [files.lp,files.pf,files.pidf,files.rf,files.pidf+'.self-closed',files.rf+'.self-closed'])fs.rmSync(file,{force:true});
  }
});

test('visible launcher stores an omitted report marker instead of persisting arbitrary rollout text',()=>{
  const files=writeInteractiveLauncher('ordinary-visible','complete ordinary task','privacy-normal');
  try{
    const script=fs.readFileSync(files.lp,'utf8');
    assert.match(script,/Visible launcher report omitted from retained controller artifact/);
  }finally{for(const file of [files.lp,files.pf,files.pidf,files.rf,files.pidf+'.self-closed',files.rf+'.self-closed'])fs.rmSync(file,{force:true});}
});

test('planner parse diagnostics redact credential-shaped model output',()=>{
  const token=providerFixtureToken('github-classic','abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN');
  assert.throws(
    ()=>extractTasks(`model reply was not JSON and included ${token}`),
    error=>{
      assert.match(error.message,/no JSON in classify output/);
      assert.equal(error.message.includes(token),false);
      assert.match(error.message,/\[REDACTED\]/);
      return true;
    },
  );
});
