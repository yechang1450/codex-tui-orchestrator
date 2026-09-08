import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {coreInventory,verifyRelease} from '../scripts/release-integrity.mjs';

test('Git checkout with autocrlf enabled preserves sealed release bytes',()=>{
 const repo=fileURLToPath(new URL('../',import.meta.url)),family=path.join(repo,'temp');fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'git-release-'));
 try {
  fs.mkdirSync(path.join(root,'scripts/core'),{recursive:true});
  for(const name of ['contracts.mjs','orchestrate-sdk.mjs'])fs.copyFileSync(path.join(repo,'scripts/core',name),path.join(root,'scripts/core',name));
  if(fs.existsSync(path.join(repo,'.gitattributes')))fs.copyFileSync(path.join(repo,'.gitattributes'),path.join(root,'.gitattributes'));
  fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({schema:1,coreVersion:'fixture',files:coreInventory(root)}));
  const git=args=>{const result=spawnSync('git',['-c','core.autocrlf=true','-c','core.safecrlf=false',...args],{cwd:root,windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
  git(['init','--quiet']);git(['add','.']);
  for(const name of ['contracts.mjs','orchestrate-sdk.mjs'])fs.unlinkSync(path.join(root,'scripts/core',name));
  git(['checkout-index','-a','-f']);
  assert.equal(verifyRelease(root).files,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
