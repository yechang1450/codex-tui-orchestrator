import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const entry=path.join(repo,'scripts','core','orchestrate-sdk.mjs');
const windows=process.platform==='win32';
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');

function psLiteral(value){return `'${String(value).replaceAll("'","''")}'`;}

// Host resolution probes a native CLI before the --spawn prompt boundary. This
// fixture lets the regression exercise that boundary without opening a real TUI.
function nativeCliFixture(file){
  const source=`using System;\nusing System.IO;\npublic static class SpawnPromptReaderFixture {\n  public static int Main(string[] args) {\n    var log=Environment.GetEnvironmentVariable("ORCH_TEST_CLI_LOG");\n    if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, String.Join("\\u001f", args ?? new string[0]) + Environment.NewLine);\n    if (args != null && args.Length == 1 && args[0] == "--version") { Console.WriteLine("codex-cli 0.162.1"); return 0; }\n    return 70;\n  }\n}`;
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ${psLiteral(source)} -OutputAssembly ${psLiteral(file)} -OutputType ConsoleApplication`;
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);
}

test('CLI --spawn rejects a hard-linked prompt before it can reach a visible launcher', {skip:!windows}, t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-spawn-prompt-reader-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace');
  const outside=path.join(root,'outside');
  // The Windows controller boundary deliberately rejects the system temp
  // directory because its ACL is shared. Give the process an isolated child
  // of the private Codex home so local .rules files cannot affect this test.
  const codexHome=path.join(os.homedir(),'.codex');
  if(!fs.existsSync(codexHome))return t.skip('requires the local private Codex home');
  const trustedHome=fs.mkdtempSync(path.join(codexHome,'spawn-prompt-reader-'));
  t.after(()=>fs.rmSync(trustedHome,{recursive:true,force:true}));
  const cli=path.join(root,'fixture-codex.exe');
  const callLog=path.join(root,'fixture-cli.log');
  fs.mkdirSync(workspace,{recursive:true});
  fs.mkdirSync(outside,{recursive:true});
  fs.writeFileSync(path.join(outside,'prompt.md'),'complete an ordinary non-secret task','utf8');
  try { fs.linkSync(path.join(outside,'prompt.md'),path.join(workspace,'prompt.md')); }
  catch { return t.skip('NTFS hard links are unavailable to this account'); }
  nativeCliFixture(cli);

  const env={...process.env,
    ORCH_AGENT:'codex',
    ORCH_CLI:cli,
    ORCH_ALLOW_UNVERIFIED_CLI:'1',
    ORCH_AUTO_INSTALL_CLI:'0',
    ORCH_AUTO_INSTALL_DEPS:'0',
    ORCH_SANDBOX:'danger-full-access',
    ORCH_APPROVAL:'never',
    ORCH_TUI:'inactive',
    // The legacy direct reader would get past the prompt boundary. Stop that
    // path before a launcher can start, so this regression stays hermetic.
    ORCH_MIN_AVAILABLE_MB:'2147483647',
    WORKSPACE_DIR:workspace,
    ORCH_CONTROLLER_ROOT:trustedHome,
    CODEX_HOME:trustedHome,
    ORCH_TEST_CLI_LOG:callLog,
  };
  for(const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CODEX_PERMISSION_PROFILE','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY','ORCH_STATE_DIR'])delete env[key];

  const result=spawnSync(process.execPath,[entry,'--spawn','ordinary-title','prompt.md'],{
    cwd:workspace,env,encoding:'utf8',windowsHide:true,timeout:30000,
  });
  assert.notEqual(result.error?.code,'ETIMEDOUT','the rejected prompt must not wait for an interactive child');
  assert.equal(result.signal,null,result.stderr||result.stdout);
  assert.equal(result.status,1,result.stderr||result.stdout);
  const output=String(result.stdout||'')+String(result.stderr||'');
  assert.match(output,/SAFE_WORKSPACE_READ_MULTIPLE_LINKS/i);
  assert.equal(output.includes('spawn REFUSED'),false,'the hardened read must fail before memory admission');

  const calls=fs.existsSync(callLog)
    ?fs.readFileSync(callLog,'utf8').split(/\r?\n/).filter(Boolean)
    :[];
  assert.deepEqual(calls,['--version'],'the rejected prompt must not be passed to a visible child');
});
