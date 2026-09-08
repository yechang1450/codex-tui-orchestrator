#!/usr/bin/env node
import './codex-entry.mjs';
import './sdk-dependency-check.mjs';
// Load the engine only after dependency validation completes. Static re-exports
// could start engine evaluation concurrently with the asynchronous SDK check.
export const {main,buildPsArrayLit,capPlanBlocks,buildWindowWaves,applyAuthPromptPolicy,readTail,
 classifyBlockComplexity,classifyExecutionMode,appendModelEffortArgs,genericProjectSplit,trySingleBlock,
 conflictByKeys,loadCachedDecompose,buildBlocksFromTasks,resolveHints,extractTasks,classifyPrompt,
 buildBlockPrompt,levelWaves,decomposeHash,checkDiskSpace,readPidFile,pidAliveCheck,closeWindowByPid,
 windowGenuinelyPopped,extractResult,extractUsage,readReportFromResult,sessionDir,writeInteractiveLauncher,
 staleTransientFiles,pidFileOfTransient,tryReserveWindow,commitReservation,cancelReservation,computeMaxWindows,
 blockKeys,keysOverlap,scanTaskComplete,waitTaskComplete,isCapacityError,capacityRetryPolicy,__setOrchHooks,isOrchestratorSelfMod,resolveCodexHome}=await import('./core/orchestrate-sdk.mjs');
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
