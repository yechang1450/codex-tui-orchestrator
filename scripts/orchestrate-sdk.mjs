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
 staleTransientFiles,pidFileOfTransient,tryReserveWindow,commitReservation,cancelReservation,computeMaxWindows,isPluginOwnedTerminalCommand,closeOrphanTerminals,
 blockKeys,keysOverlap,findOwnedTurn,waitForSessionFile,scanTaskComplete,waitTaskComplete,isCapacityError,capacityRetryPolicy,isProviderQuotaError,rolloutQuotaError,withRegistryLock,__setOrchHooks,isOrchestratorSelfMod,resolveCodexHome,trustConfigPath,workspaceTrustState}=await import('./core/orchestrate-sdk.mjs');
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reportFatal} from './core/fatal.mjs';
// 公开入口必须与内核入口回同一行 FATAL；此前这里打 e.stack，导致 `--nope` 之类的拒绝
// 把 Node 栈帧和载入器前言直接甩给用户（回归：test/public-fatal-contract.test.mjs）。
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())main().catch(reportFatal);
