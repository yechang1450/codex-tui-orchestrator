#!/usr/bin/env node
// 失败契约的兜底必须**最先**被求值：ESM 的静态 import 按书写顺序执行，所以 fatal.mjs 的
// 模块体（installFatalGuard）会在任何可能抛错的模块（依赖自检、入口参数校验、宿主 CLI 解析）
// 之前跑完。
import {reportFatal} from './core/fatal.mjs';
import {runBootstrapCommand,ensureRuntimeDependencies} from './entry-bootstrap.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const IS_CLI = Boolean(process.argv[1]) && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
// 只读/自举命令（--help / --version / --install-deps）不需要引擎，也不该被引擎的依赖自检挡住：
// 写完 stdout 就退出，这样"依赖坏了"时仍然问得到版本号与修法（穷举审计 P5/P8）。
if (IS_CLI && await runBootstrapCommand(process.argv.slice(2))) process.exit(0);

await import('./codex-entry.mjs');
await ensureRuntimeDependencies();
await import('./sdk-dependency-check.mjs');
// Load the engine only after dependency validation completes. Static re-exports
// could start engine evaluation concurrently with the asynchronous SDK check.
export const {main,buildPsArrayLit,capPlanBlocks,buildWindowWaves,memoryPreflight,applyAuthPromptPolicy,readTail,
 classifyBlockComplexity,classifyExecutionMode,appendModelEffortArgs,genericProjectSplit,trySingleBlock,
 conflictByKeys,loadCachedDecompose,buildBlocksFromTasks,resolveHints,extractTasks,classifyPrompt,
 buildBlockPrompt,levelWaves,decomposeHash,checkDiskSpace,readPidFile,pidAliveCheck,closeWindowByPid,
 windowGenuinelyPopped,extractResult,extractUsage,readReportFromResult,sessionDir,writeInteractiveLauncher,
 staleTransientFiles,pidFileOfTransient,tryReserveWindow,commitReservation,cancelReservation,computeMaxWindows,isPluginOwnedTerminalCommand,closeOrphanTerminals,
 blockKeys,keysOverlap,findOwnedTurn,waitForSessionFile,scanTaskComplete,waitTaskComplete,isCapacityError,capacityRetryPolicy,isProviderQuotaError,rolloutQuotaError,withRegistryLock,__setOrchHooks,isOrchestratorSelfMod,resolveCodexHome,trustConfigPath,workspaceTrustState}=await import('./core/orchestrate-sdk.mjs');
export const {prepareExecutionPlan,terminateOwnedLauncher}=await import('./core/orchestrate-sdk.mjs');
// 公开入口必须与内核入口回同一行 FATAL；此前这里打 e.stack，导致 `--nope` 之类的拒绝
// 把 Node 栈帧和载入器前言直接甩给用户（回归：test/public-fatal-contract.test.mjs）。
if (IS_CLI) main().catch(reportFatal);
