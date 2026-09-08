import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const scripts=fileURLToPath(new URL('.',import.meta.url));
const instruction='npm ci --prefix '+JSON.stringify(scripts);
let entry;
try{entry=fileURLToPath(import.meta.resolve('@openai/codex-sdk'));}
catch(error){
 if(['ERR_INVALID_PACKAGE_CONFIG','ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code))throw new Error('RELEASE_DEPENDENCY_DAMAGED: SDK package metadata is invalid; restore with '+instruction);
 if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;
 throw new Error('RELEASE_DEPENDENCY_MISSING: install the locked SDK dependency with '+instruction);
}
try{
 if(!fs.statSync(entry).isFile())throw new Error('not a file');
 fs.accessSync(entry,fs.constants.R_OK);
}catch{throw new Error('RELEASE_DEPENDENCY_DAMAGED: SDK entry is missing or unreadable; restore with '+instruction);}
const expected=JSON.parse(fs.readFileSync(path.join(scripts,'package.json'),'utf8')).dependencies['@openai/codex-sdk'];
let dir=path.dirname(entry),actual;
while(true){
 const manifest=path.join(dir,'package.json');
 if(fs.existsSync(manifest)){
  const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
  if(pkg.name==='@openai/codex-sdk'){actual=pkg.version;break;}
 }
 const parent=path.dirname(dir);if(parent===dir)break;dir=parent;
}
if(actual!==expected)throw new Error(`RELEASE_DEPENDENCY_VERSION: expected ${expected}, found ${actual||'unknown'}; restore with ${instruction}`);
try{
 const sdk=await import('@openai/codex-sdk');
 if(typeof sdk.Codex!=='function'||typeof sdk.Codex.prototype?.startThread!=='function'||typeof sdk.Codex.prototype?.resumeThread!=='function')throw new Error('missing interfaces');
}catch{throw new Error('RELEASE_DEPENDENCY_DAMAGED: SDK cannot load or lacks required interfaces; restore with '+instruction);}
