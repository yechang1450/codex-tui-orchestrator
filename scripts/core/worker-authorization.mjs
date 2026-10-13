import path from 'node:path';
import {physicalPathIdentity} from './runtime-context.mjs';

const SANDBOX_MODES = new Set(['read-only','workspace-write','danger-full-access']);
const APPROVAL_MODES = new Set(['never','on-request']);
const SAFE_PROVIDER_CONFIG = new Set([
  'model_provider="orchestrator-openai-https"',
  'model_providers.orchestrator-openai-https.name="OpenAI"',
  'model_providers.orchestrator-openai-https.wire_api="responses"',
  'model_providers.orchestrator-openai-https.requires_openai_auth=true',
  'model_providers.orchestrator-openai-https.supports_websockets=false',
  'model_providers.orchestrator-openai-https.supports_standalone_web_search=true',
]);
const FORBIDDEN_EXEC_OPTIONS = Object.freeze([
  '--add-dir','--worktree','--remote','--remote-auth-token-env','--oss',
  '--local-provider','--enable','--ignore-user-config',
  '--output-schema','--output-last-message','--image','--search','--ephemeral',
  '--cyber-access-program','--thread-source',
]);

function unavailable(message) {
  throw new Error('CHILD_AUTHORIZATION_UNAVAILABLE: ' + message);
}

// The initiating process can report its own policy, but environment variables,
// session files and a local config file are not a host-issued capability.  Until
// Codex exposes a verifiable capability, a worker may only be read-only or ask
// before writing in its workspace.
export function constrainWorkerPolicy(sandbox, approval) {
  if (!SANDBOX_MODES.has(sandbox) || !APPROVAL_MODES.has(approval))
    unavailable('unsupported child authorization');
  if (sandbox === 'read-only') return {sandbox:'read-only',approval};
  return {sandbox:'workspace-write',approval:'on-request'};
}

function optionValue(args, index, longName, shortName) {
  const arg=String(args[index] ?? '');
  if (arg === longName || arg === shortName) return {value:args[index + 1],skip:1};
  if (arg.startsWith(longName + '=')) return {value:arg.slice(longName.length + 1),skip:0};
  if (arg.startsWith(shortName + '=')) return {value:arg.slice(shortName.length + 1),skip:0};
  // Codex accepts attached short values such as `-sread-only`.  Treat them
  // exactly like the separated spelling so a re-digested control record
  // cannot hide a sandbox, approval, or config override from this guard.
  if (shortName.startsWith('-') && !shortName.startsWith('--') && arg.startsWith(shortName) && arg.length>shortName.length)
    return {value:arg.slice(shortName.length),skip:0};
  return null;
}

function unsafeConfig(value) {
  const text=String(value ?? '');
  return /(?:^|[.\s])trust_level\s*=|(?:^|[.\s])sandbox_permissions\s*=|(?:^|[.\s])sandbox_mode\s*=|(?:^|[.\s])approval_policy\s*=|(?:^|[.\s])writable_roots\s*=/i.test(text);
}

// `codex exec` has no interactive approval flag.  The normal builder emits
// precisely this config for the one safe noninteractive shape: read-only
// execution.  Keep the exception syntactically exact so a compound config or
// a different policy cannot piggyback on it.
function exactReadOnlyExecApproval(value) {
  return /^\s*approval_policy\s*=\s*"never"\s*$/.test(String(value ?? ''));
}

function safeProviderBaseUrl(value) {
  const prefix='model_providers.orchestrator-openai-https.base_url=';
  const text=String(value ?? '');
  if(!text.startsWith(prefix))return false;
  let raw;
  try { raw=JSON.parse(text.slice(prefix.length)); } catch { return false; }
  if(typeof raw!=='string'||raw.length>4096)return false;
  try {
    const url=new URL(raw);
    return (url.protocol==='https:' || (url.protocol==='http:'&&['localhost','127.0.0.1','::1'].includes(url.hostname.toLowerCase()))) &&
      !url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/v1';
  } catch { return false; }
}

function safeExecConfig(value) {
  const text=String(value ?? '');
  if(exactReadOnlyExecApproval(text))return 'read-only-approval';
  // launchArgs always clears inherited workspace-write extension roots. In a
  // read-only exec child this exact empty setting cannot expand authority.
  if(text==='sandbox_workspace_write.writable_roots=[]')return 'ordinary';
  if(/^model_reasoning_effort=[A-Za-z0-9._-]+$/.test(text))return 'ordinary';
  if(/^service_tier="[A-Za-z0-9._-]+"$/.test(text))return 'ordinary';
  if(SAFE_PROVIDER_CONFIG.has(text)||safeProviderBaseUrl(text))return 'ordinary';
  return null;
}

function longOption(arg,name) {
  return arg===name||arg.startsWith(name+'=');
}

function samePhysicalWorkspace(left,right) {
  try {
    if(!path.isAbsolute(left)||!path.isAbsolute(right))return false;
    return physicalPathIdentity(left)===physicalPathIdentity(right);
  } catch { return false; }
}

// Validate again at the final spawn boundary. A valid command digest proves
// only that a config was not changed after it was written; it does not prove
// that an untrusted caller was entitled to authorize a privileged child.
export function assertSafeWorkerArgs(args,{workspace}={}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string'))
    unavailable('invalid child argument list');
  const strictExec=args[0]==='exec';
  if(!strictExec)unavailable('headless worker requires codex exec arguments');
  let sandbox='read-only',approval='on-request',readOnlyExecApproval=false,ignoreRules=false,workspaceArgs=[];
  for (let index=1;index<args.length;index++) {
    const arg=args[index];
    if (arg === '--dangerously-bypass-approvals-and-sandbox' || arg === '--dangerously-bypass-hook-trust')
      unavailable('privilege-bypass argument is forbidden');
    if (arg === '--approve-for-me') unavailable('automatic approval argument is forbidden');
    // The builder alone inserts this exact bare option. `codex exec` supports
    // it to remove user/project rule layers; any attached or repeated form is
    // rejected so a re-digested controller record cannot widen the argv shape.
    if(arg==='--ignore-rules'){
      if(ignoreRules)unavailable('headless rules override may appear only once');
      ignoreRules=true;
      continue;
    }
    if(longOption(arg,'--ignore-rules')) unavailable('headless rules override is malformed');
    if(FORBIDDEN_EXEC_OPTIONS.some(name=>longOption(arg,name)))
      unavailable('headless argument can escape the worker boundary');
    if(optionValue(args,index,'--profile','-p'))
      unavailable('profile override is forbidden for headless execution');
    const cdOption=optionValue(args,index,'--cd','-C');
    if(cdOption) {
      if(typeof cdOption.value!=='string'||!cdOption.value||!path.isAbsolute(cdOption.value))unavailable('child workspace argument is invalid');
      workspaceArgs.push(cdOption.value);index+=cdOption.skip;continue;
    }
    const sandboxOption=optionValue(args,index,'--sandbox','-s');
    if (sandboxOption) {
      sandbox=String(sandboxOption.value ?? '');
      index+=sandboxOption.skip;
      continue;
    }
    const approvalOption=optionValue(args,index,'--ask-for-approval','-a') || optionValue(args,index,'--approval-policy','--approval-policy');
    if (approvalOption) {
      approval=String(approvalOption.value ?? '');
      index+=approvalOption.skip;
      continue;
    }
    const configOption=optionValue(args,index,'--config','-c');
    if (configOption) {
      const permitted=safeExecConfig(configOption.value);
      if (permitted==='read-only-approval') {
        readOnlyExecApproval=true;
        index+=configOption.skip;
        continue;
      }
      if(!permitted)unavailable('headless config is not allowed');
      if (unsafeConfig(configOption.value)&&permitted!=='ordinary') unavailable('config override can change child authorization');
      index+=configOption.skip;
      continue;
    }
    const modelOption=optionValue(args,index,'--model','-m');
    if(modelOption){
      if(typeof modelOption.value!=='string'||!modelOption.value||/\s/.test(modelOption.value))unavailable('headless model argument is invalid');
      index+=modelOption.skip;continue;
    }
    const disabled=optionValue(args,index,'--disable','--disable');
    if(disabled){
      if(disabled.value!=='hooks')unavailable('headless feature override is not allowed');
      index+=disabled.skip;continue;
    }
    const color=optionValue(args,index,'--color','--color');
    if(color){
      if(color.value!=='never')unavailable('headless color argument is invalid');
      index+=color.skip;continue;
    }
    if(arg==='--json'||arg==='--skip-git-repo-check')continue;
    unavailable('unsupported headless argument');
  }
  if(readOnlyExecApproval) {
    if(sandbox!=='read-only')unavailable('noninteractive approval requires read-only sandbox');
    approval='never';
  }
  const constrained=constrainWorkerPolicy(sandbox,approval);
  if(constrained.sandbox!==sandbox||constrained.approval!==approval)
    unavailable('privileged child policy requires a host-authenticated capability');
  if(sandbox!=='read-only'||approval!=='never')unavailable('headless execution requires read-only noninteractive policy');
  if(!ignoreRules)unavailable('headless execution requires the fixed rules override');
  if(workspaceArgs.length!==1)unavailable('headless execution requires one workspace binding');
  if(workspace!==undefined&&!samePhysicalWorkspace(workspaceArgs[0],workspace))
    unavailable('headless workspace differs from the controller workspace');
  return true;
}
