import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {piArgs} from './pi-host.mjs';
import {nativeArgumentLines} from './native-argv.mjs';
export function piAssistantText(raw) {
  let final='';
  for(const line of raw.split(/\r?\n/))try{
    const event=JSON.parse(line),message=event.message||event;
    if(message.role==='assistant') {
      if(message.stopReason==='error'||message.stopReason==='aborted')throw new Error('PI_RESPONSE_FAILED');
      const text=(message.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');if(text)final=text;
    }
  }catch(error){if(error.message==='PI_RESPONSE_FAILED')throw error;}
  return final;
}
export async function runPiPlanner(config,prompt,cwd) {
  const args=[...piArgs(config,{model:process.env.ORCH_MODEL,effort:process.env.ORCH_EFFORT}),'--print','--mode','json','--no-session','--no-tools','--no-extensions','--no-skills','--no-context-files','--',prompt];
  return new Promise((resolve,reject)=>{
    const child=spawn(config.bin,args,{cwd,env:process.env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let raw='',errorText='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},Number(process.env.ORCH_DECOMPOSE_TIMEOUT_MS||60000));
    child.stdout.on('data',b=>{raw+=b;if(raw.length>8000000)child.kill();});child.stderr.on('data',b=>{errorText+=b;});
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('exit',code=>{clearTimeout(timer);try{if(timedOut||code!==0)throw new Error(timedOut?'PI_PLANNER_TIMEOUT':'PI_PLANNER_FAILED: exit '+code);const final=piAssistantText(raw);if(!final)throw new Error('PI_PLANNER_EMPTY_RESPONSE');resolve({final});}catch(e){reject(e);}});
  });
}
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
export function writePiLauncher(config,{key,prompt,suffix,workspace,temp}) {
  const stem=String(key+'-'+suffix).replace(/[^a-zA-Z0-9_-]/g,'-');
  const token=/【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(prompt)?.[1];
  if(!token)throw new Error('Pi window requires a completion token');
  fs.mkdirSync(temp,{recursive:true});
  const lp=path.join(temp,'win-launch-'+stem+'.ps1'),pidf=path.join(temp,'window-'+stem+'.pid'),pf=path.join(temp,'agent-win-'+stem+'.md'),rf=path.join(temp,'win-'+stem+'.result.json');
  const piSession=path.join(temp,'orchestrator','pi','sessions',stem+'.jsonl');fs.mkdirSync(path.dirname(piSession),{recursive:true});
  fs.writeFileSync(pf,prompt,'utf8');
  const args=[...piArgs(config,{model:process.env.ORCH_MODEL,effort:process.env.ORCH_EFFORT}),'--session',piSession,'--extension',fileURLToPath(new URL('./pi-shutdown.mjs',import.meta.url)),'--','@'+pf];
  const body=["$ErrorActionPreference = 'Stop'",`$PID | Set-Content -LiteralPath ${quote(pidf)} -Encoding UTF8`,
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8','$OutputEncoding = [System.Text.Encoding]::UTF8','chcp 65001 | Out-Null',
    `Set-Location -LiteralPath ${quote(workspace)}`,`$env:ORCH_WINDOW = '1'`,`$env:ORCH_PI_TOKEN = ${quote(token)}`,`$env:ORCH_PI_RESULT = ${quote(rf)}`,
    '$code = 1','try {','$agentArgs = @('+args.map(quote).join(',')+')',...nativeArgumentLines(),`& ${quote(config.bin)} @agentArgs`,'$code = $LASTEXITCODE','} catch { $code = 1 }',
    `if (-not (Test-Path -LiteralPath ${quote(rf)})) { @{__EXIT__=$code;__DONE__=$true;token=${quote(token)}} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(rf)} -Encoding UTF8 }`,'exit 0'].join('\r\n');
  fs.writeFileSync(lp,'\ufeff'+body,'utf8');return {lp,pidf,pf,rf,piSession};
}
export async function waitPiResult(rf,timeoutMs,pidf) {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end) {
    if(fs.existsSync(rf)){try{const r=JSON.parse(fs.readFileSync(rf,'utf8').replace(/^\uFEFF/,''));return {done:true,exitCode:r.__EXIT__,text:r.__REPORT__||''};}catch{}}
    if(fs.existsSync(pidf)){const pid=Number(fs.readFileSync(pidf,'utf8').replace(/^\uFEFF/,''));try{process.kill(pid,0);}catch{return {done:true,exitCode:1,text:'Pi launcher exited without result'};}}
    await new Promise(r=>setTimeout(r,300));
  }
  return {done:false,exitCode:null,text:'Pi completion timeout'};
}
