#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {latestRunId,readRunStatus,watchRunStatus,renderRunStatus} from './core/status-events.mjs';
import {reportFatal} from './core/fatal.mjs';

export async function main(argv=process.argv.slice(2)){
  const options={workspace:process.env.WORKSPACE_DIR||process.cwd(),runId:process.env.ORCH_RUN_ID,watch:false,json:false,after:0,timeoutMs:21600000};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(arg==='--readonly')continue;
    if(arg==='--watch'||arg==='--json'){options[arg.slice(2)]=true;continue;}
    const key={'--run-id':'runId','--workspace':'workspace','--after':'after','--timeout-ms':'timeoutMs'}[arg];
    if(!key||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Invalid status argument: '+arg);
    options[key]=['after','timeoutMs'].includes(key)?Number(argv[++i]):argv[++i];
  }
  const output=event=>{
    if(options.json)console.log(JSON.stringify(event));
    else{if(options.watch&&process.stdout.isTTY)process.stdout.write('\x1b[2J\x1b[H');console.log(renderRunStatus(event));}
  };
  if(!options.runId)options.runId=latestRunId(options.workspace);
  if(!options.runId){
    if(options.watch)throw new Error('No orchestrator runs to watch in '+options.workspace);
    output({schema:1,type:'empty',runId:null,workspace:path.resolve(options.workspace),todoList:[],executionStatus:[],finishedAt:null,success:null});
    return;
  }
  if(!options.watch){output(readRunStatus(options.workspace,options.runId));return;}
  const controller=new AbortController(),cancel=()=>controller.abort();process.once('SIGINT',cancel);
  try{await watchRunStatus({...options,onEvent:output,signal:controller.signal});}finally{process.removeListener('SIGINT',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(reportFatal);
