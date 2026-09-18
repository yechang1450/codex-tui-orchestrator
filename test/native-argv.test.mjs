import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nativeArgumentLines} from '../scripts/core/native-argv.mjs';
test('real PowerShell preserves JSON, Chinese, embedded quotes and trailing path separators',()=>{
 const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');fs.mkdirSync(family,{recursive:true});
 const dir=fs.mkdtempSync(path.join(family,'argv-'));
 try{
  const js=path.join(dir,'argv.mjs'),ps=path.join(dir,'argv.ps1');
  fs.writeFileSync(js,'console.log(JSON.stringify(process.argv.slice(2)))');
  const values=['{"x":"中文", "path":"D:\\a b\\x"}','a"b','slash\\\\"quote','last slash\\','D:\\','next','line\nnewline'];
  const lit=s=>"'"+s.replaceAll("'","''")+"'";
  fs.writeFileSync(ps,'\ufeff'+`[Console]::OutputEncoding=[Text.Encoding]::UTF8\n$agentArgs=@(${[js,...values].map(lit).join(',')})\n`+nativeArgumentLines().join('\n')+`\n& ${lit(process.execPath)} @agentArgs`);
  // 通过 cmd.exe 包裹调用：从 WSL 启动时，PowerShell 对 `& <控制台子进程>` 会立即返回且不接管
  // 子进程 stdout，导致这里读不到 JSON；cmd /c 在两种父进程下都等待并保留输出。
  const result=spawnSync('cmd.exe',['/c','powershell.exe','-NoProfile','-File',ps],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),values);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
