import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyRelease} from '../scripts/release-integrity.mjs';

test('Git checkout with autocrlf enabled preserves sealed release bytes',()=>{
 const repo=fileURLToPath(new URL('../',import.meta.url)),family=path.join(repo,'temp');fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'git-release-'));
 try {
  const release=JSON.parse(fs.readFileSync(path.join(repo,'release.json')));
  const files=Object.keys(release.runtimeFiles);
  for(const name of files){const dest=path.join(root,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(repo,name),dest);}
  if(fs.existsSync(path.join(repo,'.gitattributes')))fs.copyFileSync(path.join(repo,'.gitattributes'),path.join(root,'.gitattributes'));
  fs.writeFileSync(path.join(root,'release.json'),JSON.stringify(release));
  const git=args=>{const result=spawnSync('git',['-c','core.autocrlf=true','-c','core.safecrlf=false',...args],{cwd:root,windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
  git(['init','--quiet']);git(['add','.']);
  for(const name of files)fs.unlinkSync(path.join(root,name));
  git(['checkout-index','-a','-f']);
  assert.equal(verifyRelease(root).runtimeFiles,files.length);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
