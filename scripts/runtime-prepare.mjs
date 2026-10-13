#!/usr/bin/env node
// A model-free setup entry: reuse the locked SDK and native CLI installers.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureRuntimeDependencies} from './entry-bootstrap.mjs';
import {resolveHost,cliCandidates} from './core/host-cli.mjs';
import {runtimeCliCandidateRoots} from './core/runtime-cli-roots.mjs';
import {runtimeCliPrefix} from './core/runtime-cli-prefix.mjs';
import {assertPrivateWindowsRoot} from './core/private-root.mjs';
import {trustedWindowsHelper} from './core/windows-system.mjs';

function assertPrivateRuntimeHome(env){
  const runtimeHome=path.dirname(runtimeCliPrefix(env));
  try{return assertPrivateWindowsRoot(runtimeHome,{powershell:trustedWindowsHelper('powershell')}).root;}
  catch{throw new Error('RUNTIME_ROOT_UNSAFE_ACL: runtime storage must be a local directory writable only by the current Windows user, SYSTEM, and Administrators');}
}

function environmentValue(env,name){
  if(!env||typeof env!=='object')return '';
  for(const [key,value] of Object.entries(env)){
    if(key.toLowerCase()===name.toLowerCase()&&typeof value==='string')return value.trim();
  }
  return '';
}

function hasExplicitCli(env){
  return Boolean(environmentValue(env,'ORCH_CLI')||environmentValue(env,'CODEX_EXE'));
}

export async function prepareRuntime({
  env = process.env,
  platform = process.platform,
  ensureRuntimeDependenciesImpl = ensureRuntimeDependencies,
  resolveHostImpl = resolveHost,
  cliCandidatesImpl = cliCandidates,
  runtimeCliCandidateRootsImpl = runtimeCliCandidateRoots,
} = {}) {
  if (platform !== 'win32') throw new Error('WINDOWS_REQUIRED: bootstrap requires a native Windows runtime.');
  // A private prefix is executable authority and must be validated before we
  // enumerate or install from it. An explicit CLI is resolved without touching
  // that prefix, so do not reject a direct, operator-selected CLI merely
  // because an otherwise unused fallback runtime root has an unsafe ACL.
  if(!hasExplicitCli(env))assertPrivateRuntimeHome(env);
  const sdk = await ensureRuntimeDependenciesImpl({env});
  // The bootstrap owns the private CLI prefix and pins its exact release.
  // Do not let a desktop or PATH CLI suppress that installation; explicit
  // ORCH_CLI/CODEX_EXE selections remain authoritative in cliCandidates.
  const host = await resolveHostImpl({
    env,
    agent: 'codex',
    candidates: candidateEnv => cliCandidatesImpl(candidateEnv, platform, {
      localRoots: runtimeCliCandidateRootsImpl(candidateEnv),
      includeAmbient: false,
    }),
    autoInstall: env.ORCH_AUTO_INSTALL_CLI !== '0',
  });
  return {ok:true,stage:'ready',nodeVersion:process.versions.node,sdkVersion:sdk.version,cliPath:host.config.bin,agent:host.agent};
}

async function main() {
  try {
    fs.writeSync(1, JSON.stringify(await prepareRuntime()) + '\n');
  } catch (error) {
    // Shared installers already suppress npm output/credentials. Keep a bounded diagnostic.
    fs.writeSync(2, `BOOTSTRAP_PREPARE_FAILED: ${String(error?.message || error).slice(0, 800)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main();
