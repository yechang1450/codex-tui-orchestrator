import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const entry=path.join(repo,'scripts','core','orchestrate-sdk.mjs');
const windows=process.platform==='win32';
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');

function psLiteral(value){return `'${String(value).replaceAll("'","''")}'`;}

// The `--spawn` command resolves and probes a native CLI before dispatching.
// Use a local native fixture that records only its argv, so this test can prove
// that a rejected title never reaches the interactive launch step without
// opening a real Codex TUI or touching the user's installed CLI.
function nativeCliFixture(file){
  const source=`using System;\nusing System.IO;\npublic static class SpawnPrivacyFixture {\n  public static int Main(string[] args) {\n    var log=Environment.GetEnvironmentVariable(\"ORCH_TEST_CLI_LOG\");\n    if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, String.Join(\"\\u001f\", args ?? new string[0]) + Environment.NewLine);\n    if (args != null && args.Length == 1 && args[0] == \"--version\") { Console.WriteLine(\"codex-cli 0.162.1\"); return 0; }\n    return 70;\n  }\n}`;
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ${psLiteral(source)} -OutputAssembly ${psLiteral(file)} -OutputType ConsoleApplication`;
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);
}

function filesBelow(dir){
  if(!fs.existsSync(dir))return [];
  const files=[];
  const walk=current=>{
    for(const entry of fs.readdirSync(current,{withFileTypes:true})){
      const item=path.join(current,entry.name);
      if(entry.isDirectory())walk(item);
      else if(entry.isFile())files.push(item);
    }
  };
  walk(dir);
  return files;
}

test('CLI --spawn rejects a credential-shaped title before a visible child can launch', {skip:!windows}, t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-spawn-title-privacy-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace');
  const controller=path.join(root,'controller');
  const home=path.join(root,'home');
  const cli=path.join(root,'fixture-codex.exe');
  const callLog=path.join(root,'fixture-cli.log');
  fs.mkdirSync(workspace,{recursive:true});
  fs.mkdirSync(home,{recursive:true});
  nativeCliFixture(cli);

  const secret=providerFixtureToken('openai-project','abcdefghijklmnopqrstuvwxyz0123456789');
  const title=`ordinary-OPENAI_API_KEY=${secret}`;
  const env={...process.env,
    ORCH_AGENT:'codex',
    ORCH_CLI:cli,
    ORCH_ALLOW_UNVERIFIED_CLI:'1',
    ORCH_AUTO_INSTALL_CLI:'0',
    ORCH_AUTO_INSTALL_DEPS:'0',
    ORCH_SANDBOX:'danger-full-access',
    ORCH_APPROVAL:'never',
    ORCH_TUI:'inactive',
    ORCH_MIN_FREE_MB:'1',
    ORCH_MIN_FREE_HARD_MB:'1',
    WORKSPACE_DIR:workspace,
    ORCH_CONTROLLER_ROOT:controller,
    CODEX_HOME:home,
    ORCH_TEST_CLI_LOG:callLog,
  };
  for(const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CODEX_PERMISSION_PROFILE','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY','ORCH_STATE_DIR'])delete env[key];

  const result=spawnSync(process.execPath,[entry,'--spawn',title,'complete an ordinary non-secret task'],{
    cwd:workspace,env,encoding:'utf8',windowsHide:true,timeout:30000,
  });
  assert.notEqual(result.error?.code,'ETIMEDOUT','a rejected title must not wait for an interactive child');
  assert.equal(result.signal,null,result.stderr||result.stdout);
  assert.equal(result.status,1,result.stderr||result.stdout);
  const output=String(result.stdout||'')+String(result.stderr||'');
  assert.match(output,/credential-shaped launcher identity|SENSITIVE_RUN_IDENTITY/i);
  assert.equal(output.includes(secret),false,'fatal CLI diagnostics must not echo the rejected credential');

  const calls=fs.existsSync(callLog)
    ?fs.readFileSync(callLog,'utf8').split(/\r?\n/).filter(Boolean)
    :[];
  assert.deepEqual(calls,['--version'],'host resolution may probe the CLI, but no interactive child may start');

  const controllerFiles=filesBelow(controller);
  assert.equal(controllerFiles.some(file=>/^(?:agent-win|win-launch|window-|win-)/i.test(path.basename(file))),false,
    'a rejected title must not create visible-launcher artifacts');
  for(const file of controllerFiles){
    const bytes=fs.readFileSync(file);
    assert.equal(bytes.includes(Buffer.from(secret)),false,`controller artifact leaked the credential: ${path.basename(file)}`);
    assert.equal(bytes.includes(Buffer.from(title)),false,`controller artifact retained the rejected title: ${path.basename(file)}`);
  }
});
