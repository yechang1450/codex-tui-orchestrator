import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyRelease} from '../scripts/release-integrity.mjs';

function git(args,{cwd,quiet=false,encoding='utf8'}={}){
 const command=process.platform==='win32'?(process.env.ComSpec||'cmd.exe'):'git';
 const commandArgs=process.platform==='win32'?['/d','/s','/c','git',...args]:args;
  const result=spawnSync(command,commandArgs,{cwd,windowsHide:true,encoding});
 assert.equal(result.error,undefined,result.error?.message);
 if(!quiet)assert.equal(result.status,0,result.stderr);
 return result;
}

test('Git index ships the current sealed runtime manifest with exact paths and bytes',t=>{
 const repo=fileURLToPath(new URL('../',import.meta.url));
 if(!fs.existsSync(path.join(repo,'.git'))){t.skip('Git index check applies to source checkouts; archives use release verification');return;}
 const release=JSON.parse(fs.readFileSync(path.join(repo,'release.json'),'utf8'));
 const indexedRelease=JSON.parse(git(['show',':release.json'],{cwd:repo}).stdout);
 assert.deepEqual(indexedRelease,release,'release.json must be staged after its final seal');
 const entries=new Map();
 for(const record of git(['ls-files','--stage','-z'],{cwd:repo}).stdout.split('\0').filter(Boolean)){
   const tab=record.indexOf('\t');assert.notEqual(tab,-1,`invalid Git index record: ${record}`);
   const [mode,sha256,stage]=record.slice(0,tab).split(' '),name=record.slice(tab+1);
   assert.equal(stage,'0',`runtime file must have one resolved index entry: ${name}`);
   entries.set(name,{mode,sha256});
 }
 const mismatches=[];
 for(const [name,expected] of Object.entries(release.runtimeFiles)){
   const entry=entries.get(name);
   if(!entry){mismatches.push(`${name}: missing`);continue;}
   const indexed=git(['cat-file','-p',`:${name}`],{cwd:repo,encoding:'buffer'}).stdout;
   const actual=crypto.createHash('sha256').update(indexed).digest('hex');
   if(actual!==expected)mismatches.push(`${name}: sealed ${expected}, index ${actual}`);
 }
 assert.deepEqual(mismatches,[],'Git must preserve every sealed runtime path with the sealed bytes and exact casing');
});

test('Git ignores generated test evidence',t=>{
 const repo=fileURLToPath(new URL('../',import.meta.url));
 if(!fs.existsSync(path.join(repo,'.git'))){t.skip('Git ignore policy applies to source checkouts');return;}
 const generated=git(['check-ignore','-q','--no-index','test/generated-run.json'],{cwd:repo,quiet:true});
 assert.equal(generated.status,0,'generated execution evidence must stay out of the repository');
});

test('Git ignores local npm configuration files',t=>{
 const repo=fileURLToPath(new URL('../',import.meta.url));
 if(!fs.existsSync(path.join(repo,'.git'))){t.skip('Git ignore policy applies to source checkouts');return;}
 const npmrc=git(['check-ignore','-q','--no-index','.npmrc'],{cwd:repo,quiet:true});
 assert.equal(npmrc.status,0,'local npm configuration can contain registry credentials and must not enter a public commit');
});

test('Git ignores local credential stores and private-key containers',t=>{
 const repo=fileURLToPath(new URL('../',import.meta.url));
 if(!fs.existsSync(path.join(repo,'.git'))){t.skip('Git ignore policy applies to source checkouts');return;}
 const privatePaths=[
  '.envrc','.direnv/config.toml','.netrc','_netrc','.pypirc',
  'secrets/token.txt','.secrets/token.txt','credentials/config.json','.credentials/config.json',
  'private-keys/key.txt','.private-keys/key.txt','client.pem','client.key','cert.p12','cert.pfx',
  'id_rsa','id_dsa','id_ecdsa','id_ed25519',
 ];
 for(const name of privatePaths){
  const result=git(['check-ignore','-q','--no-index',name],{cwd:repo,quiet:true});
  assert.equal(result.status,0,`${name} must stay out of a public commit`);
 }
 const publicPaths=['.env.example','.env.sample','.env.template','docs/public-certificate.crt','assets/public-certificate.cer','id_ed25519.pub','docs/secrets.md','docs/credentials.md'];
 for(const name of publicPaths){
  const result=git(['check-ignore','-q','--no-index',name],{cwd:repo,quiet:true});
  assert.notEqual(result.status,0,`${name} is valid public source material and must remain trackable`);
 }
});

test('Git index contains no private credential material',t=>{
 const repo=fileURLToPath(new URL('../',import.meta.url));
 if(!fs.existsSync(path.join(repo,'.git'))){t.skip('Git index check applies to source checkouts');return;}
 const sensitivePath=/(?:^|\/)(?:\.?secrets?|\.?credentials?|\.?private[-_]?keys?)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.envrc|\.netrc|_netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i;
 const privateKey=/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
 const providerTokens=[
  /(?:^|[^A-Za-z0-9_])gh[pousr]_[A-Za-z0-9_]{20,}/,
  /(?:^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/,
  /(?:^|[^A-Za-z0-9_])sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
 ];
 const failures=[];
 for(const name of git(['ls-files','-z'],{cwd:repo}).stdout.split('\0').filter(Boolean)){
  if(sensitivePath.test(name)){failures.push(`${name}: sensitive path`);continue;}
  const bytes=git(['cat-file','-p',`:${name}`],{cwd:repo,encoding:'buffer'}).stdout;
  const text=bytes.toString('utf8');
  if(privateKey.test(text))failures.push(`${name}: private key block`);
  else if(providerTokens.some(pattern=>pattern.test(text)))failures.push(`${name}: provider credential pattern`);
 }
 assert.deepEqual(failures,[],'the staged public source must not carry private credentials');
});

test('the Codex plugin cannot acquire an npm publication surface',()=>{
 const repo=fileURLToPath(new URL('../',import.meta.url));
 const packageFile=path.join(repo,'scripts','package.json');
 const pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
 assert.equal(pkg.private,true,'the internal dependency manifest must stay private');
 assert.equal(Object.hasOwn(pkg,'publishConfig'),false,'a Codex plugin must not declare npm publication settings');
 const lifecycle=Object.entries(pkg.scripts||{}).filter(([name,command])=>
   /(?:^|:|-)(?:pre|post)?(?:publish|pack)(?:$|:|-)/i.test(name)||
   /\b(?:npm|pnpm|yarn)\s+(?:publish|pack|login|adduser)\b/i.test(String(command)));
 assert.deepEqual(lifecycle,[],'the internal dependency manifest must not expose npm publication lifecycle scripts');
 const workflow=fs.readFileSync(path.join(repo,'.github','workflows','validate.yml'),'utf8');
 assert.doesNotMatch(workflow,/\b(?:npm|pnpm|yarn)\s+(?:publish|pack|login|adduser)\b/i,
   'the public CI workflow must not publish or authenticate to npm');
});

test('Git ignores PowerShell module-analysis caches',t=>{
 const repo=fileURLToPath(new URL('../',import.meta.url));
 if(!fs.existsSync(path.join(repo,'.git'))){t.skip('Git ignore policy applies to source checkouts');return;}
 const cache=git(['check-ignore','-q','--no-index','Microsoft/Windows/PowerShell/ModuleAnalysisCache'],{cwd:repo,quiet:true});
 assert.equal(cache.status,0,'PowerShell module caches can contain local user paths and must not enter a public commit');
});

test('Git checkout with autocrlf enabled preserves sealed release bytes',()=>{
 const repo=fileURLToPath(new URL('../',import.meta.url)),family=testTempFamily('git-distribution');fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'git-release-'));
 try {
  const release=JSON.parse(fs.readFileSync(path.join(repo,'release.json')));
  const files=Object.keys(release.runtimeFiles);
  for(const name of files){const dest=path.join(root,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(repo,name),dest);}
  if(fs.existsSync(path.join(repo,'.gitattributes')))fs.copyFileSync(path.join(repo,'.gitattributes'),path.join(root,'.gitattributes'));
  fs.writeFileSync(path.join(root,'release.json'),JSON.stringify(release));
  const gitArgs=args=>git(['-c','core.autocrlf=true','-c','core.safecrlf=false',...args],{cwd:root});
  gitArgs(['init','--quiet']);gitArgs(['add','.']);
  for(const name of files)fs.unlinkSync(path.join(root,name));
  gitArgs(['checkout-index','-a','-f']);
  assert.equal(verifyRelease(root).runtimeFiles,files.length);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
