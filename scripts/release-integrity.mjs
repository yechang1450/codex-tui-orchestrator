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
 if(manifest.schema!==2)throw new Error('RELEASE_SCHEMA_UNSUPPORTED: current releases require schema 2');
 const current=coreInventory(pluginRoot);
 if(JSON.stringify(current)!==JSON.stringify(manifest.files))throw new Error('RELEASE_INTEGRITY_FAILED: core differs from the verified release; reinstall the release');
 if(JSON.stringify(runtimeInventory(pluginRoot))!==JSON.stringify(manifest.runtimeFiles))throw new Error('RELEASE_INTEGRITY_FAILED: runtime differs from the verified release');
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
 // The manifest itself is intentionally excluded to avoid a self-referential
 // hash. Every other shipped instruction and metadata file is covered.
  for(const rel of ['.agents','.codex-plugin','repair.mjs','scripts','skills','hooks','docs','agents','assets','.gitattributes','.gitignore']){
  if(fs.existsSync(path.join(pluginRoot,rel)))walk(rel);
 }
 for(const name of ['SKILL.md','README.md','README-zh.md','CHANGELOG.md','LICENSE','LICENSE-zh.md','SECURITY.md','CONTRIBUTING.md','CODE_OF_CONDUCT.md']){
  const file=path.join(pluginRoot,name);
  if(fs.existsSync(file))walk(name);
 }
 return files;
}
function assertCanonicalTextLineEndings(pluginRoot){
 const textExt=/\.(?:cjs|json|mjs|md|ps1|py|txt|yaml|yml)$/i;
 for(const rel of Object.keys(runtimeInventory(pluginRoot))){
  if(!textExt.test(rel))continue;
  const bytes=fs.readFileSync(path.join(pluginRoot,rel));
  if(bytes.includes(13))throw new Error('RELEASE_NONCANONICAL_LINE_ENDINGS: '+rel+' contains CRLF; normalize to LF before sealing');
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--seal')){
  assertCanonicalTextLineEndings(root);
  const files=coreInventory(root),text=fs.readFileSync(path.join(root,'scripts','core','contracts.mjs'),'utf8');
  const coreVersion=/CORE_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1];if(!coreVersion)throw new Error('Missing core version');
  fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({schema:2,coreVersion,files,runtimeFiles:runtimeInventory(root)},null,2)+'\n','utf8');
 }
 console.log(JSON.stringify(verifyRelease()));
}
