import path from 'node:path';
import fs from 'node:fs';
import {assertNoReparsePoints, physicallySameOrChild, physicalPathIdentity} from './core/runtime-context.mjs';
import {PROCESS_INITIATOR_CONTEXT} from './core/initiator-context.mjs';
import {readWorkspaceText,WORKSPACE_READ_LIMITS} from './core/safe-workspace-read.mjs';

const MAX_PLAN_FILE_BYTES = WORKSPACE_READ_LIMITS.plan;

function authorizedInputFile(value, {cwd, root, label, maxBytes = Infinity} = {}) {
  const base = path.resolve(root || cwd || process.cwd());
  const file = path.resolve(cwd || process.cwd(), String(value));
  assertNoReparsePoints(base, `${label} root`);
  assertNoReparsePoints(file, label);
  if (!physicallySameOrChild(base, file)) throw new Error(`${label.toUpperCase().replaceAll(' ', '_')}_OUTSIDE_WORKSPACE: ${file}`);
  let info;
  try { info = fs.lstatSync(file); } catch { throw new Error(`${label.toUpperCase().replaceAll(' ', '_')}_MISSING: ${file}`); }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label.toUpperCase().replaceAll(' ', '_')}_INVALID: expected a regular file: ${file}`);
  if (info.size > maxBytes) throw new Error(`${label.toUpperCase().replaceAll(' ', '_')}_TOO_LARGE: request exceeds ${maxBytes} bytes`);
  return file;
}

// Host and workspace options must be applied before the engine snapshots its
// environment. Return the remaining argv unchanged, including quoted prompts.
function assertHostBoundWorkspace(workspace, env, cwd, initiatorContext) {
  const threadId = String(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || '').trim();
  if (!threadId) return;
  const boundWorkspace = String(initiatorContext?.workspace || '').trim();
  if (initiatorContext?.threadId !== threadId || !boundWorkspace) {
    throw new Error('INITIATOR_POLICY_UNAVAILABLE: host workspace binding missing');
  }
  const requested = path.resolve(cwd, String(workspace || '.'));
  if (physicalPathIdentity(requested) !== physicalPathIdentity(boundWorkspace)) {
    throw new Error('INITIATOR_POLICY_UNAVAILABLE: workspace differs from host-bound initiating workspace');
  }
}

export function configureEntryArgs(argv,env=process.env,cwd=process.cwd(),{initiatorContext=PROCESS_INITIATOR_CONTEXT}={}){
  const fields={'--cli':'ORCH_CLI','--workspace':'WORKSPACE_DIR',
    '--run-id':'ORCH_RUN_ID','--acceptance-file':'ORCH_ACCEPTANCE_FILE','--acceptance':'ORCH_ACCEPTANCE_FILE'};
  const remaining=[],values={};let idCommand=false;
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(['--verify-run','--resume-run','--status','--tasks'].includes(flag))idCommand=true;
    if((!flag.startsWith('--')&&!idCommand)||flag==='--'){remaining.push(...argv.slice(i));break;}
    if(flag==='--agent')throw new Error('AGENT_OPTION_UNSUPPORTED: this plugin always uses Codex');
    if(!Object.hasOwn(fields,flag)){remaining.push(flag);continue;}
    if(Object.hasOwn(values,fields[flag]))throw new Error('Duplicate option: '+flag);
    const value=argv[++i];
    if(!value?.trim()||value.startsWith('--'))throw new Error(flag+' needs a value');
    if(flag==='--run-id'&&!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw new Error('Invalid run ID');
    values[fields[flag]]=flag==='--run-id'?value:path.resolve(cwd,value);
  }
  // A desktop host workspace is captured before this parser can mutate env.
  // Check it before accepting any workspace-relative controller input.
  assertHostBoundWorkspace(values.WORKSPACE_DIR || env.WORKSPACE_DIR || '.', env, cwd, initiatorContext);
  // Acceptance input is a controller boundary. Resolve it only beneath the
  // initiating workspace and reject reparse aliases before the value is copied
  // into writable run state.
  const acceptanceInput = values.ORCH_ACCEPTANCE_FILE || env.ORCH_ACCEPTANCE_FILE;
  if (acceptanceInput) {
    const root = path.resolve(cwd, String(values.WORKSPACE_DIR || env.WORKSPACE_DIR || '.'));
    values.ORCH_ACCEPTANCE_FILE = authorizedInputFile(acceptanceInput, {cwd, root, label: 'acceptance file'});
  }
  Object.assign(env,values);
  if(remaining[0]==='--plan-file'){
    if(remaining.length!==2||!remaining[1]?.trim()||remaining[1].startsWith('--'))throw new Error('PLAN_FILE_ARGUMENTS: --plan-file requires exactly one path');
    const root = path.resolve(cwd, String(env.WORKSPACE_DIR || '.'));
    const file=path.resolve(cwd,String(remaining[1]));
    let request;
    try{request=readWorkspaceText({root,target:file,maxBytes:MAX_PLAN_FILE_BYTES}).text.replace(/^\uFEFF/,'').trim();}
    catch(error){
      const code=String(error?.message||'');
      if(code.startsWith('SAFE_WORKSPACE_READ_LIMIT:'))throw new Error('PLAN_FILE_TOO_LARGE: request exceeds '+MAX_PLAN_FILE_BYTES+' bytes');
      if(code.startsWith('SAFE_WORKSPACE_READ_OPEN:'))throw new Error('PLAN_FILE_MISSING: '+file);
      throw new Error('PLAN_FILE_UNREADABLE: '+file);
    }
    if(!request)throw new Error('PLAN_FILE_EMPTY: '+file);
    return ['--plan',request];
  }
  return remaining;
}

export function leadingModeFlags(argv,modeFlags) {
  const modes=[];
  for(const arg of argv){if(!arg.startsWith('--')||arg==='--')break;if(modeFlags.has(arg))modes.push(arg);}
  return modes;
}
