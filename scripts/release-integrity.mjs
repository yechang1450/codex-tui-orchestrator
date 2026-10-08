import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SHA256_HEX=/^[0-9a-f]{64}$/;
const DISTRIBUTION_PROVENANCE='distribution-provenance.json';
const DISTRIBUTION_SOURCE_RELEASE='distribution-source-release.json';
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
async function assertSealedDependencies(pluginRoot){
 const {verifyDependencyTree}=await import('./dependency-integrity.mjs');
 const result=verifyDependencyTree({dir:path.join(pluginRoot,'scripts')});
 if(!result.ok)throw new Error(result.message);
 return result;
}
export async function verifySourceRelease(pluginRoot=root){
 const release=verifyRelease(pluginRoot);
 await assertSealedDependencies(pluginRoot);
 return release;
}
function sha256File(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function isPlainObject(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function isSha256(value){return typeof value==='string'&&SHA256_HEX.test(value);}
function distributionFailure(message){throw new Error('RELEASE_DISTRIBUTION_PROVENANCE: '+message);}
function lstatExists(file){
 try{fs.lstatSync(file);return true;}catch(error){
  if(error?.code==='ENOENT')return false;
  throw error;
 }
}
function readDistributionProvenance(pluginRoot){
 const file=path.join(pluginRoot,'scripts',DISTRIBUTION_PROVENANCE);let provenance;
 try{provenance=JSON.parse(fs.readFileSync(file,'utf8'));}catch{distributionFailure('distribution-provenance.json is missing or invalid');}
 if(!isPlainObject(provenance)||provenance.schema!==1||!isSha256(provenance.sourceReleaseSha256)||!isSha256(provenance.sourceDependencyManifestSha256)||!isSha256(provenance.packageLockSha256)||!Number.isSafeInteger(provenance.dependencyFiles)||provenance.dependencyFiles<0){
  distributionFailure('distribution-provenance.json has an unsupported schema or invalid hashes');
 }
 return provenance;
}
async function assertDistributionProvenance(pluginRoot){
 const scripts=path.join(pluginRoot,'scripts');
 if(lstatExists(path.join(scripts,'node_modules')))distributionFailure('distribution sealing requires scripts/node_modules to be omitted; use ordinary --seal for a source checkout');
 const provenance=readDistributionProvenance(pluginRoot);
 const {readDependencyIntegrityManifest}=await import('./dependency-integrity.mjs');
 const dependency=readDependencyIntegrityManifest({dir:scripts});
 if(!dependency.ok)distributionFailure('dependency-integrity.json is invalid: '+dependency.message);
 const dependencyHash=sha256File(dependency.manifestPath);
 if(dependencyHash!==provenance.sourceDependencyManifestSha256)distributionFailure('dependency-integrity.json does not match the verified source provenance');
 const lockHash=sha256File(path.join(scripts,'package-lock.json'));
 if(lockHash!==dependency.manifest.packageLockSha256||lockHash!==provenance.packageLockSha256)distributionFailure('dependency-integrity.json package-lock hash does not match the verified source provenance');
 if(Object.keys(dependency.manifest.files).length!==provenance.dependencyFiles)distributionFailure('dependency-integrity.json file count does not match the verified source provenance');
 const sourceReleasePath=path.join(scripts,DISTRIBUTION_SOURCE_RELEASE);let sourceRelease;
 try{sourceRelease=JSON.parse(fs.readFileSync(sourceReleasePath,'utf8'));}catch{distributionFailure('distribution-source-release.json is missing or invalid');}
 if(sha256File(sourceReleasePath)!==provenance.sourceReleaseSha256)distributionFailure('distribution-source-release.json does not match the verified source provenance');
 if(!isPlainObject(sourceRelease)||sourceRelease.schema!==2||!isPlainObject(sourceRelease.files)||!isPlainObject(sourceRelease.runtimeFiles))distributionFailure('distribution-source-release.json has an unsupported release schema');
 if(sourceRelease.runtimeFiles['scripts/dependency-integrity.json']!==dependencyHash)distributionFailure('dependency-integrity.json is not sealed by the verified source release');
 if(sourceRelease.runtimeFiles['scripts/package-lock.json']!==lockHash)distributionFailure('package-lock.json is not sealed by the verified source release');
 return provenance;
}
function assertCanonicalTextLineEndings(pluginRoot){
 const textExt=/\.(?:cjs|json|mjs|md|ps1|py|txt|yaml|yml)$/i;
 for(const rel of Object.keys(runtimeInventory(pluginRoot))){
  if(!textExt.test(rel))continue;
  const bytes=fs.readFileSync(path.join(pluginRoot,rel));
  if(bytes.includes(13))throw new Error('RELEASE_NONCANONICAL_LINE_ENDINGS: '+rel+' contains CRLF; normalize to LF before sealing');
 }
}
function parseCliArgs(argv){
 const known=new Set(['--seal','--distribution','--verify-source']);
 for(const arg of argv)if(!known.has(arg))throw new Error('unknown option: '+arg);
 const seal=argv.includes('--seal'),distribution=argv.includes('--distribution'),verifySource=argv.includes('--verify-source');
 if(distribution&&!seal)throw new Error('--distribution requires --seal');
 if(seal&&verifySource)throw new Error('--seal cannot be combined with --verify-source');
 return {seal,distribution,verifySource};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options=parseCliArgs(process.argv.slice(2));
 if(options.seal){
  assertCanonicalTextLineEndings(root);
  if(options.distribution)await assertDistributionProvenance(root);else await assertSealedDependencies(root);
  const files=coreInventory(root),text=fs.readFileSync(path.join(root,'scripts','core','contracts.mjs'),'utf8');
  const coreVersion=/CORE_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1];if(!coreVersion)throw new Error('Missing core version');
  fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({schema:2,coreVersion,files,runtimeFiles:runtimeInventory(root)},null,2)+'\n','utf8');
 }else if(options.verifySource)await verifySourceRelease(root);
 console.log(JSON.stringify(verifyRelease()));
}
