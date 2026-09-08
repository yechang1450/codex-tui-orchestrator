import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function coreInventory(pluginRoot){
 const core=path.join(pluginRoot,'scripts','core'),files={};
 function walk(dir){
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error('RELEASE_LINK_FORBIDDEN: '+dir);
  for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('RELEASE_LINK_FORBIDDEN: '+file);
   if(entry.isDirectory())walk(file);else if(entry.isFile())files[path.relative(core,file).replaceAll('\\','/')]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
 }
 walk(core);if(!files['orchestrate-sdk.mjs']||!files['contracts.mjs'])throw new Error('RELEASE_CORE_MISSING');return files;
}
export function verifyRelease(pluginRoot=root){
 const manifest=JSON.parse(fs.readFileSync(path.join(pluginRoot,'release.json'),'utf8'));
 if(![1,2].includes(manifest.schema))throw new Error('RELEASE_SCHEMA_UNSUPPORTED');
 const current=coreInventory(pluginRoot);
 if(JSON.stringify(current)!==JSON.stringify(manifest.files))throw new Error('RELEASE_INTEGRITY_FAILED: core differs from the verified release; reinstall the release');
 if(manifest.schema===2&&JSON.stringify(runtimeInventory(pluginRoot))!==JSON.stringify(manifest.runtimeFiles))throw new Error('RELEASE_INTEGRITY_FAILED: runtime differs from the verified release');
 return {schema:manifest.schema,coreVersion:manifest.coreVersion,files:Object.keys(current).length,runtimeFiles:Object.keys(manifest.runtimeFiles||{}).length};
}
export function runtimeInventory(pluginRoot){
 const files={};
 function walk(rel){
  const file=path.join(pluginRoot,rel),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink())throw new Error('RELEASE_LINK_FORBIDDEN: '+file);
  if(stat.isDirectory())for(const name of fs.readdirSync(file).sort()){
   if(['node_modules','temp','.git','.plugin-eval','.agent-cache.json'].includes(name))continue;
   walk(path.join(rel,name));
  }
  else if(stat.isFile())files[rel.replaceAll('\\','/')]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 }
 for(const rel of ['.codex-plugin','repair.mjs','scripts','skills'])walk(rel);
 return files;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--seal')){
  const files=coreInventory(root),text=fs.readFileSync(path.join(root,'scripts','core','contracts.mjs'),'utf8');
  const coreVersion=/CORE_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1];if(!coreVersion)throw new Error('Missing core version');
  fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({schema:2,coreVersion,files,runtimeFiles:runtimeInventory(root)},null,2)+'\n','utf8');
 }
 console.log(JSON.stringify(verifyRelease()));
}
