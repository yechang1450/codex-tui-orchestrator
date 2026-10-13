import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertNoReparsePoints} from './runtime-context.mjs';

// Codex loads exec-policy `*.rules` files from its user and project config
// layers. An explicit Allow rule can bypass the sandbox, so visible workers
// cannot safely inherit active user/project rules until the interactive CLI
// offers a supported equivalent of `exec --ignore-rules`.
function unsafe() {
  const error=new Error('VISIBLE_EXEC_POLICY_RULES_UNSAFE: visible execution refuses active or unsafe Codex .rules files because an allow rule can bypass the sandbox. Remove or disable those rules for this run, or use read-only headless execution.');
  error.code='VISIBLE_EXEC_POLICY_RULES_UNSAFE';
  throw error;
}

function samePath(left,right) {
  const a=path.resolve(left),b=path.resolve(right);
  return process.platform==='win32' ? a.toLowerCase()===b.toLowerCase() : a===b;
}

function invalidCodexHomePath() {
  const error=new Error('CODEX_HOME_PATH_UNSAFE: CODEX_HOME must be a fully-qualified path or an ordinary relative path resolved from the worker workspace. Rooted and drive-relative Windows forms are refused because their drive depends on the launching process.');
  error.code='CODEX_HOME_PATH_UNSAFE';
  throw error;
}

function isFullyQualifiedWindowsPath(value) {
  // `path.isAbsolute('\\rules')` is true in Node on Windows, but Windows
  // resolves it from the current drive. `C:rules` likewise carries the current
  // directory of C:. Neither spelling identifies one stable directory across
  // a controller and a visible child launched on another drive.
  const text=String(value??'');
  return /^[A-Za-z]:[\\/]/.test(text)||/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(text);
}

export function resolveCodexHomeFromWorkspace(value,workspace,{fallback=path.join(os.homedir(),'.codex')}={}) {
  const configured=String(value??'').trim();
  if(!configured)return path.resolve(fallback);
  // The visible child is launched with `workspace` as its current directory.
  // Codex therefore resolves a relative CODEX_HOME from that directory, not
  // from the controller's own cwd.  The policy scan must use exactly the same
  // base or an active rule could be missed.
  const base=path.resolve(String(workspace??''));
  if(!path.isAbsolute(base))invalidCodexHomePath();
  if(process.platform==='win32'){
    if(/^[\\/]/.test(configured)||/^[A-Za-z]:/.test(configured)){
      if(!isFullyQualifiedWindowsPath(configured))invalidCodexHomePath();
      return path.resolve(configured);
    }
    return path.resolve(base,configured);
  }
  return path.isAbsolute(configured)?path.resolve(configured):path.resolve(base,configured);
}

function projectRuleDirectories(workspace) {
  const result=[];
  let current=path.resolve(String(workspace??''));
  if(!path.isAbsolute(current))unsafe();
  while(true){
    result.push(path.join(current,'.codex','rules'));
    const parent=path.dirname(current);
    if(samePath(parent,current))break;
    current=parent;
  }
  return result;
}

function visibleRuleDirectories({workspace,codexHome}={}) {
  if(typeof workspace!=='string'||!workspace.trim())unsafe();
  const dirs=[path.join(resolveCodexHomeFromWorkspace(codexHome,workspace),'rules'),...projectRuleDirectories(workspace)];
  const seen=new Set();
  return dirs.filter(dir=>{
    const key=process.platform==='win32'?path.resolve(dir).toLowerCase():path.resolve(dir);
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}

function ruleFilesInDirectory(directory) {
  try { assertNoReparsePoints(directory,'visible Codex rule layer'); }
  catch { unsafe(); }
  let info;
  try { info=fs.lstatSync(directory); }
  catch(error) {
    if(error?.code==='ENOENT')return [];
    unsafe();
  }
  if(!info.isDirectory()||info.isSymbolicLink())unsafe();
  let entries;
  try { entries=fs.readdirSync(directory,{withFileTypes:true}); }
  catch { unsafe(); }
  const files=[];
  for(const entry of entries){
    const candidate=path.join(directory,entry.name);
    let stat;
    try { stat=fs.lstatSync(candidate); }
    catch { unsafe(); }
    // Refuse any indirection in a policy directory. A later replacement of a
    // non-rule entry with a rule is a same-user race outside this plugin's OS
    // isolation scope, but a present reparse point is an immediate ambiguity.
    if(stat.isSymbolicLink())unsafe();
    if(!entry.name.toLowerCase().endsWith('.rules'))continue;
    if(!stat.isFile())unsafe();
    files.push(candidate);
  }
  return files;
}

export function findVisibleRuleFiles(options={}) {
  const result=[];
  for(const directory of visibleRuleDirectories(options))result.push(...ruleFilesInDirectory(directory));
  return result;
}

export function assertVisibleRuleBoundary(options={}) {
  if(findVisibleRuleFiles(options).length>0)unsafe();
  return true;
}
