import path from 'node:path';
import fs from 'node:fs';
import {assertNoReparsePoints, physicallySameOrChild} from './core/runtime-context.mjs';

const MAX_PLAN_FILE_BYTES = 1024 * 1024;

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
export function configureEntryArgs(argv,env=process.env,cwd=process.cwd()){
  const fields={'--agent':'ORCH_AGENT','--cli':'ORCH_CLI','--workspace':'WORKSPACE_DIR',
    '--run-id':'ORCH_RUN_ID','--acceptance-file':'ORCH_ACCEPTANCE_FILE','--acceptance':'ORCH_ACCEPTANCE_FILE'};
  const remaining=[],values={};let idCommand=false;
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(['--verify-run','--resume-run','--status','--tasks'].includes(flag))idCommand=true;
    if((!flag.startsWith('--')&&!idCommand)||flag==='--'){remaining.push(...argv.slice(i));break;}
    if(!Object.hasOwn(fields,flag)){remaining.push(flag);continue;}
    if(Object.hasOwn(values,fields[flag]))throw new Error('Duplicate option: '+flag);
    const value=argv[++i];
    if(!value?.trim()||value.startsWith('--'))throw new Error(flag+' needs a value');
    if(flag==='--run-id'&&!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw new Error('Invalid run ID');
    values[fields[flag]]=flag==='--agent'?value.trim().toLowerCase():flag==='--run-id'?value:path.resolve(cwd,value);
  }
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
    const file=authorizedInputFile(remaining[1], {cwd, root, label: 'plan file', maxBytes: MAX_PLAN_FILE_BYTES});
    let request;
    try{request=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').trim();}
    catch{throw new Error('PLAN_FILE_UNREADABLE: '+file);}
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
