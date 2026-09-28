import path from 'node:path';
import fs from 'node:fs';

const MAX_PLAN_FILE_BYTES = 1024 * 1024;

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
  Object.assign(env,values);
  if(remaining[0]==='--plan-file'){
    if(remaining.length!==2||!remaining[1]?.trim()||remaining[1].startsWith('--'))throw new Error('PLAN_FILE_ARGUMENTS: --plan-file requires exactly one path');
    const file=path.resolve(cwd,remaining[1]);
    let info;
    try{info=fs.lstatSync(file);}catch{throw new Error('PLAN_FILE_MISSING: '+file);}
    if(!info.isFile())throw new Error('PLAN_FILE_INVALID: expected a regular file: '+file);
    if(info.size>MAX_PLAN_FILE_BYTES)throw new Error('PLAN_FILE_TOO_LARGE: request exceeds 1 MiB');
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
