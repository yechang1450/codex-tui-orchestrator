import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
export function resolvePiHost(env=process.env) {
  const explicit=env.ORCH_CLI||env.PI_EXE;
  const candidates=explicit?[path.resolve(explicit)]:String(env.PATH||env.Path||'').split(path.delimiter).flatMap(dir=>['pi.exe','pi.cmd','pi'].map(n=>path.join(dir,n)));
  for(const file of [...new Set(candidates)]) {
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
    let bin=file,prefixArgs=[];
    if(!/\.exe$/i.test(file)) {
      let entry=/\.[cm]?js$/i.test(file)?file:null;
      if(!entry){const shim=fs.readFileSync(file,'utf8');const match=shim.match(/node_modules[\\/](@(?:earendil-works|mariozechner))[\\/]pi-coding-agent[\\/](dist[\\/](?:bundle[\\/])?cli\.js)/);if(match)entry=path.join(path.dirname(file),'node_modules',match[1],'pi-coding-agent',...match[2].split(/[\\/]/));}
      if(!entry||!fs.existsSync(entry))continue;
      const sibling=path.join(path.dirname(file),'node.exe');bin=fs.existsSync(sibling)?sibling:process.execPath;prefixArgs=[entry];
    }
    const help=spawnSync(bin,[...prefixArgs,'--help'],{env,encoding:'utf8',windowsHide:true,shell:false,timeout:10000});
    if(help.status!==0||!/pi - AI coding assistant/.test(help.stdout)||!['--session','--extension','--approve'].every(flag=>help.stdout.includes(flag)))continue;
    const versionResult=spawnSync(bin,[...prefixArgs,'--version'],{env,encoding:'utf8',windowsHide:true,shell:false,timeout:10000});
    const version=versionResult.stdout?.trim();if(versionResult.status!==0||!/^\d+\.\d+\.\d+$/.test(version))continue;
    const [major,minor,patch]=version.split('.').map(Number);if(major===0&&(minor<84||(minor===84&&patch<4)))continue;
    return {agent:'pi',config:{id:'pi',label:'pi agent',version,bin,prefixArgs,available:true,native:prefixArgs.length===0,modelEnv:'ORCH_MODEL',effortEnv:'ORCH_EFFORT'}};
  }
  throw new Error('CLI_MISSING: pi; no supported installed pi CLI found. No fallback or automatic install.');
}
export function piArgs(config,{model,effort}={}) {
  return [...(config.prefixArgs||[]),'--approve','--offline',...(model?['--model',model]:[]),...(effort?['--thinking',effort]:[])];
}
