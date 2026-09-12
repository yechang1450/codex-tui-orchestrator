import path from 'node:path';

// Host and workspace options must be applied before the engine snapshots its
// environment. Return the remaining argv unchanged, including quoted prompts.
export function configureEntryArgs(argv,env=process.env,cwd=process.cwd()){
  const fields={'--agent':'ORCH_AGENT','--cli':'ORCH_CLI','--workspace':'WORKSPACE_DIR',
    '--run-id':'ORCH_RUN_ID','--acceptance-file':'ORCH_ACCEPTANCE_FILE','--acceptance':'ORCH_ACCEPTANCE_FILE'};
  const remaining=[],values={};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(!Object.hasOwn(fields,flag)){remaining.push(flag);continue;}
    if(Object.hasOwn(values,fields[flag]))throw new Error('Duplicate option: '+flag);
    const value=argv[++i];
    if(!value?.trim()||value.startsWith('--'))throw new Error(flag+' needs a value');
    if(flag==='--run-id'&&!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw new Error('Invalid run ID');
    values[fields[flag]]=flag==='--agent'?value.trim().toLowerCase():flag==='--run-id'?value:path.resolve(cwd,value);
  }
  Object.assign(env,values);
  return remaining;
}
