#!/usr/bin/env node
// A model-free setup entry: reuse the locked SDK and native CLI installers.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureRuntimeDependencies} from './entry-bootstrap.mjs';
import {resolveHost,cliCandidates} from './core/host-cli.mjs';

try {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED: bootstrap requires a native Windows runtime.');
  const sdk = await ensureRuntimeDependencies();
  const localRoots=[path.join(path.dirname(fileURLToPath(import.meta.url)),'node_modules')];
  if(process.env.npm_config_prefix)localRoots.unshift(path.join(process.env.npm_config_prefix,'node_modules'));
  const host = resolveHost({agent:'codex',candidates:env=>cliCandidates(env,process.platform,{localRoots}),autoInstall:process.env.ORCH_AUTO_INSTALL_CLI!=='0'});
  fs.writeSync(1,JSON.stringify({ok:true,stage:'ready',nodeVersion:process.versions.node,sdkVersion:sdk.version,cliPath:host.config.bin,agent:host.agent})+'\n');
} catch (error) {
  // Shared installers already suppress npm output/credentials. Keep a bounded diagnostic.
  fs.writeSync(2,`BOOTSTRAP_PREPARE_FAILED: ${String(error?.message||error).slice(0,800)}\n`);
  process.exitCode=1;
}
