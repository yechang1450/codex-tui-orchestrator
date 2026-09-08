import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {piAssistantText,writePiLauncher} from '../scripts/core/pi-runtime.mjs';
import completion from '../scripts/core/pi-shutdown.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
test('pi planner consumes assistant output only and rejects failed responses',()=>{
 assert.equal(piAssistantText(JSON.stringify({message:{role:'user',content:[{type:'text',text:'wrong'}]}})+'\n'+JSON.stringify({message:{role:'assistant',content:[{type:'text',text:'answer'}]}})),'answer');
 assert.throws(()=>piAssistantText(JSON.stringify({message:{role:'assistant',stopReason:'error'}})),/PI_RESPONSE_FAILED/);
});
test('pi shutdown waits for settled idle state and never accepts a user completion marker',async()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-events-')),file=path.join(dir,'result.json');
 const prev={file:process.env.ORCH_PI_RESULT,token:process.env.ORCH_PI_TOKEN};let callback,shutdowns=0,idle=false;
 const branch=[{type:'message',message:{role:'user',content:[{type:'text',text:'__ORCH_DONE__ token'}]}}];
 try{
  process.env.ORCH_PI_RESULT=file;process.env.ORCH_PI_TOKEN='token';
  completion({on:(event,fn)=>{assert.equal(event,'agent_settled');callback=fn;}});
  const ctx={isIdle:()=>idle,sessionManager:{getBranch:()=>branch},shutdown:()=>shutdowns++};
  await callback({},ctx);assert.ok(!fs.existsSync(file));idle=true;
  await callback({},ctx);assert.equal(JSON.parse(fs.readFileSync(file)).__EXIT__,1);
  branch.push({type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'__ORCH_DONE__ token'}]}});
  await callback({},ctx);assert.equal(JSON.parse(fs.readFileSync(file)).__EXIT__,0);assert.equal(shutdowns,2);
 }finally{if(prev.file===undefined)delete process.env.ORCH_PI_RESULT;else process.env.ORCH_PI_RESULT=prev.file;if(prev.token===undefined)delete process.env.ORCH_PI_TOKEN;else process.env.ORCH_PI_TOKEN=prev.token;fs.rmSync(dir,{recursive:true,force:true});}
});
test('pi PowerShell launcher preserves native argv and initiating directory',()=>{
 const dir=fs.mkdtempSync(path.join(family,'pi-launch-')),worker=path.join(dir,'fake cli.mjs');
 try{
  fs.writeFileSync(worker,'import fs from "node:fs";fs.writeFileSync(process.env.ORCH_PI_RESULT,JSON.stringify({__EXIT__:0,cwd:process.cwd(),args:process.argv.slice(2)}));');
  const la=writePiLauncher({bin:process.execPath,prefixArgs:[worker]},{key:'B1',suffix:'test',prompt:'执行测试\n【本块唯一标识】token',workspace:dir,temp:path.join(dir,'temp')});
  const result=spawnSync('powershell.exe',['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);const r=JSON.parse(fs.readFileSync(la.rf));assert.equal(r.cwd,dir);assert.ok(r.args.includes('--approve'));assert.equal(r.args.at(-1),'@'+la.pf);assert.ok(r.args.includes(la.piSession));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
