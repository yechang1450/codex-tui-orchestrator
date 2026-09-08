#!/usr/bin/env node
import './codex-entry.mjs';
export * from './core/poll-windows.mjs';
import {main} from './core/poll-windows.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
