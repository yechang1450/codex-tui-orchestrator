#!/usr/bin/env node
/**
 * codex-tui-orchestrator: conflict/dependency-based Codex execution.
 * --exec / --headless: hidden Codex exec, the default for --run and bare requests.
 * --run-windows / --visible: visible interactive TUI, with the same runner ledger.
 * --plan: read-only classification. --status --run-id ID --watch: live dual status.
 * WORKSPACE_DIR selects the initiating workspace; ORCH_EXEC_MODE selects the default
 * execution mode, ORCH_TUI selects the terminal only for visible execution.
 * All tasks retain their original identities. Dependent tasks await verification;
 * overflow stays serial inside capacity-limited blocks. Checkpoints and acceptance
 * determine completion; child blocks must not recursively start orchestration.
 */
import {nativeArgumentLines} from "./native-argv.mjs";
import {spawnInactiveWindow} from './inactive-window.mjs';
import {CORE_VERSION, levelWaves, keysOverlap, summaryComplete,requestTasks,bindClassifiedTasks,computeMaxWindows} from "./contracts.mjs";
import {runWindows,verifyRun} from "./runner.mjs";
import {resolveExecutionMode,resolveTuiMode,buildExecArgs} from './execution-mode.mjs';
import {createHeadlessHooks} from './headless-executor.mjs';
import {renderRunStatus} from './status-events.mjs';
import {launcherIdentity,processSnapshot,sameProcess,coordinatorDir,reserve,bind,release} from "./leases.mjs";
import {runPiPlanner,writePiLauncher,waitPiResult} from './pi-runtime.mjs';
import {isCapacityError, capacityRetryPolicy,rolloutCapacityError,isProviderQuotaError,rolloutQuotaError} from './retry-policy.mjs';
import {configureEntryArgs,leadingModeFlags} from '../entry-options.mjs';
import { networkConfig, resolveOpenAIBaseUrl, resolveProviderMode } from "./network-policy.mjs";
import {budgetSettings, budgetStateFile, loadBudgetState, firstRunHeadroom} from "./memory-budget.mjs";
import { spawn, spawnSync } from "node:child_process";
import { resolveAgent, launchArgs } from "./agent.mjs";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync, statfsSync, openSync, readSync, writeSync, closeSync, renameSync } from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
// ---------------------------------------------------------------------------
// Config (env-first, portable)
// ---------------------------------------------------------------------------
// 通用化：仅把 ~/.codex 当作【缺省回退】，真正权威是 CODEX_HOME 环境变量。
// 这样同一份 orchestrator 可以跑在【不同用户 / 不同设备 / 不同 agent】上——
// 只要外部（用户/调用方/宿主 agent）设置了 CODEX_HOME（或 ORCH_SESSION_DIR 等），
// 就不再依赖 hard-coded 的 "C:\Users\<user>\.codex"，避免跨用户/跨宿主失效。
function resolveCodexHome() {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) return process.env.CODEX_HOME.trim().replace(/[\\/]+$/, "");
  return path.join(os.homedir(), ".codex");
}
const CODEX_HOME = resolveCodexHome();
import { resolveRuntimeContext } from './runtime-context.mjs';
// 子代理/窗内公共授权模板加载：把超长 auth 从 SDK 源码下沉到独立模板文件（UTF-8 无 BOM），
// 运行时读回作为每个窗 prompt 的【公共前缀】，保持字节级一致以命中缓存；读失败回退一段防御文本。
// 用 import.meta.url 自动推导脚本同目录，绝不硬编码绝对路径；读出的内容必须以 UTF-8 无 BOM 落盘。
function readAuthPrompt() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pf = path.join(here, "agent-auth-prompt.txt");
    if (existsSync(pf)) {
      const b = readFileSync(pf);
      // 剥 BOM（若编辑器加了 BOM，则按 UTF-8 无 BOM 约定剥除，保证与历史 auth 字节一致）
      const txt = (b[0]===0xEF && b[1]===0xBB && b[2]===0xBF) ? b.subarray(3).toString("utf8") : b.toString("utf8");
      if (txt && txt.trim()) return txt;
    }
  } catch (e) { /* fall through */ }
  return "\n\n（已获授权推进并执行。本执行块由 codex-tui-orchestrator 启动：直接在本窗内用自己的工具干活，不要再发起 --run-windows、不要另开新窗、不要以「需要授权/要我修吗」等为由暂停或询问。执行结束再输出结束标记。）";
}

const { workspace: WORKSPACE, temp: TMP, state: STATE_DIR } = resolveRuntimeContext();
process.env.WORKSPACE_DIR = WORKSPACE;
process.env.ORCH_STATE_DIR = STATE_DIR;
const AGENT = resolveAgent();
const CODEX = AGENT.config.bin;
// PowerShell 单引号字符串内嵌路径：把 ' 转义成 ''，避免路径含引号时破坏脚本/注入。
const CODEX_Q = CODEX.replace(/'/g, "''");
const PY = process.env.PYTHON || "python";
// Absent explicit overrides, let the native CLI and SDK use the caller's
// Codex configuration. A hard-coded model can become unavailable independently
// of the installed plugin and must not replace the user's selected default.
const MODEL = process.env.ORCH_MODEL || undefined;
const EFFORT = process.env.ORCH_EFFORT || undefined;
// A caller may pass its effective permissions; never elevate implicitly.
const SANDBOX = process.env.ORCH_SANDBOX || "danger-full-access";
const APPROVAL = "never";
const AGENT_BIN = AGENT.config.bin;
const AGENT_BIN_Q = String(AGENT_BIN).replace(/'/g, "''");
// exec 一次性模式参数：config 已含 approval_policy=never/sandbox，仅剔除交互专用 -a 并在最前加 exec。
// 模型/推理力度透传给窗内 codex：MODEL/EFFORT 非空且值不含空格时才追加 -m / -c（-c 用 model_reasoning_effort=<EFFORT>）。
function appendModelEffortArgs(arr, agentConfig) {
  const out = [...arr];
  // 通用化：按 agent 各自的 modelEnv/effortEnv 取值（默认 codex 用 ORCH_MODEL/ORCH_EFFORT）；
  // 只有 codex 才注入 codex 专属 -m/-c model_reasoning_effort=；非 codex 走 CLI 自身环境变量。
  const cfg = agentConfig || { id: "codex", modelEnv: "ORCH_MODEL", effortEnv: "ORCH_EFFORT" };
  const id = String(cfg.id || "codex");
  const modelEnv = cfg.modelEnv || "ORCH_MODEL";
  const effortEnv = cfg.effortEnv || "ORCH_EFFORT";
  // Explicit environment overrides take precedence over native configuration.
  const model = process.env[modelEnv] || (id === "codex" ? MODEL : "");
  const effort = process.env[effortEnv] || (id === "codex" ? EFFORT : "");
  if (id !== "codex") {
    // 非 codex：模型/力度经 CLI 自身环境变量（ANTHROPIC_MODEL/GEMINI_MODEL 等）注入，绝不塞 codex 专属 argv。
    if (model && String(model).trim() && !/\s/.test(String(model))) { try { process.env[modelEnv] = String(model); } catch { /* ignore */ } }
    if (effort && String(effort).trim() && !/\s/.test(String(effort))) { try { process.env[effortEnv] = String(effort); } catch { /* ignore */ } }
    return out;
  }
  if (model && String(model).trim() && !/\s/.test(String(model))) out.push("-m", String(model));
  if (effort && String(effort).trim() && !/\s/.test(String(effort))) out.push("-c", "model_reasoning_effort=" + String(effort));
  return out;
}
// 生成 PowerShell 数组字面量 @('a','b',...)——每个参数独立元素, 含空格/单引号的值也保持为一个参数,
// 绝不拆裂。用于 & codex @agentArgs 安全传参（替代 AGENT_ARGS.split(" ") 会裂开含空格路径的旧式拼接）。
export function buildPsArrayLit(args) {
  const a = Array.isArray(args) ? args : [];
  if (!a.length) return "@()";
  return "@(" + a.map((x) => "'" + String(x).replace(/'/g, "''") + "'").join(",") + ")";
}
const AGENT_ARGS_LIST = appendModelEffortArgs(launchArgs(AGENT.config, { cwd: WORKSPACE, approval: APPROVAL, sandbox: SANDBOX }), AGENT.config);

// Runtime state belongs to the initiating workspace temp/orchestrator directory.

// 兼容保留：子代理相关目录（本插件当前不再使用子代理；该目录仅作兼容，不用于启用子代理）。
// 放在 orchestrator 稳定家目录下（ORCH_STATE_DIR），非 WORKSPACE 临时目录，避免被插件升级清掉/散落。
//
// 【窗内不使用子代理（用户明确）】orchestrator 发起的每个 TUI 窗【不再使用子代理】：所有工作由该窗自己直接完成。
//   可靠并行 = 多 TUI 窗（独立块并行）；任务完成判定 = 窗内最终落盘产物。历史：曾尝试
//   codex goal 机制与"共享任务文件 + spawn/wait"（均为线程级/消息正文投递在此环境不可靠），均已弃用。
//
// 轮询总上限：默认 6 小时（ORCH_MAX_POLL_MS 可调）。用于「检测是否有默认时间限制会提前结束轮询」——
// 在这里显式兜底为 6 小时，绝不让任何更短的默认值把还没跑完的 TUI 窗提前判成超时。
// ORCH_TIMEOUT_MS 仍可覆盖（比如测试时缩短）。
const POLL_TIMEOUT_MS = Number(process.env.ORCH_TIMEOUT_MS || process.env.ORCH_MAX_POLL_MS || 21600000);
// 窗内 watchdog 的观察上限随父进程轮询上限走（默认 = 轮询上限 + 10 分钟，可用 ORCH_WATCHDOG_MAX_MIN 覆盖）。
// 原因：watchdog 若固定 45 分钟，长任务在父进程意外退出后会失去“完成即自关”的后盾，遗留孤儿窗。
process.env.ORCH_WATCHDOG_MAX_MIN = process.env.ORCH_WATCHDOG_MAX_MIN || String(Math.max(45, Math.ceil(POLL_TIMEOUT_MS / 60000) + 10));
// Terminal hosting the visible agent TUI window.
//   wt      -> Windows Terminal (best IME/TSF support for CJK input; the fix for
//              "微软拼音输入偶发失效"). Requires wt.exe (WindowsApps).
//   conhost -> classic console (reliable window, but IME is limited for TUI apps).
// Default = Windows Terminal, per user preference. Explicit ORCH_TUI=inactive
// uses direct console startup, but is not a universal no-focus guarantee.
const WT_EXE =
  process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "wt.exe")
    : "";
// Node's fs.existsSync returns false for the WindowsApps App Execution Alias reparse point (statSync
// throws EACCES), but the alias IS usable — `where.exe wt.exe` resolves it. Without this check the TUI
// fell back to conhost, which is the worst host for CJK IME per the skill's ORCH_TUI guidance.
function wtAvailable() {
  if (!WT_EXE) return false;
  try {
    const r = spawnSync("where.exe", ["wt.exe"], { encoding: "utf8", windowsHide: true });
    return r.status === 0 && !/ERROR:/.test(String(r.stdout || ""));
  } catch { return false; }
}
// Explicitly confirm ORCH_TUI=wt (Windows Terminal) so it is a real env value that also
// propagates to the spawned window processes, instead of only an implicit code default.
process.env.ORCH_TUI = process.env.ORCH_TUI || "wt";
const TUI_MODE = resolveTuiMode(process.env.ORCH_TUI);
// 规划 SDK 默认继承调用方 Codex 配置（模型、provider 与凭据），只有显式选择
// OpenAI HTTPS provider（ORCH_PROVIDER=openai-https 或配置了中继地址）时才注入，
// 避免把使用第三方 provider 的运行强行拨回 OpenAI 登录。
const PROVIDER_MODE = resolveProviderMode();
const codex = AGENT.agent==='codex'?new (await import('@openai/codex-sdk')).Codex({
  codexPathOverride: CODEX,
  ...(PROVIDER_MODE === 'openai-https' ? { baseUrl: resolveOpenAIBaseUrl(), config: networkConfig } : {}),
}):null;
// 让出 CPU：orchestrator（含拆解线程）以 BelowNormal 优先级跑，不抢占系统/其它任务（限速=80% 性能，慢慢跑）。
try { process.setPriority(6); console.log("[orchestrator] priority=BelowNormal (让出CPU)"); } catch { /* ignore */ }
function threadBase() {
  return {
    model: MODEL,
    modelReasoningEffort: EFFORT,
    workingDirectory: WORKSPACE,
    skipGitRepoCheck: true,
    sandboxMode: SANDBOX,
    approvalPolicy: APPROVAL,
  };
}
// ============================================================================
// 两段式拆块：阶段 A = LLM 定性（扁平任务清单）；阶段 B = 确定性分块引擎（代码）。
// LLM 只做它擅长的「语义定性」（归属/依赖/可行性），代码负责确定性的分组/键规范化/wave，
// 既利用 LLM 的语义判断，又不依赖它稳定产出复杂嵌套 blocks JSON（此前 DeepSeek 常 agentic/空输出）。
// ============================================================================
// 模块→项目 归属提示（通用、非硬编码）：调用方经 ORCH_TASK_HINTS 传 JSON 映射，
// 例 {"会员管理":"82","商品与分类":"82","订单管理":"82"}。用于把「没写项目号但属于某项目」的任务归位。
function resolveHints() {
  const hints = { moduleToProj: {}, foldRules: {}, tailKeywords: ['清爽','清理','保持干净','收尾','整理'] };
  try {
    const raw = process.env.ORCH_TASK_HINTS;
    if (raw && raw.trim()) { const j = JSON.parse(raw); if (j && typeof j === "object" && !Array.isArray(j)) hints.moduleToProj = j; }
  } catch { /* ignore */ }
  try {
    const raw = process.env.ORCH_TASK_FOLD;
    if (raw && raw.trim()) { const j = JSON.parse(raw); if (j && typeof j === "object" && !Array.isArray(j)) hints.foldRules = j; }
  } catch { /* ignore */ }
  try {
    const raw = process.env.ORCH_TASK_TAIL;
    if (raw && raw.trim()) { const arr = JSON.parse(raw); if (Array.isArray(arr)) hints.tailKeywords = arr.map(String); }
  } catch { /* ignore */ }
  return hints;
}
// 阶段 A：LLM 定性提示词（扁平任务清单，不分块）。关键：字段少、只定性、禁工具、纯 JSON。
function classifyPrompt(request, hints = {}) {
  const modToProj = (hints && hints.moduleToProj) || {};
  const hintText = Object.keys(modToProj).length
    ? "\n已知模块→项目映射（校正归属用，JSON）：" + JSON.stringify(modToProj)
    : "";
  return (
    "你是任务定性分析器，只做一件事：把下面请求拆成「扁平任务清单」，不要分块、不要合并、不要执行。" +
    "每个自然任务一条，字段如下：id(字符串编号)、summary(保留原意的一句话)、kind(project|tool|system)、" +
    "project(请求中明确出现的任意项目编号或名称，只在请求里明确写了才填，否则填 null)、" +
    "hint(该任务涉及模块/资源关键词，如 会员管理、商品、订单)、" +
    "conflict_hints(会碰到的资源字符串数组，如 [\"db:订单\",\"dir:管理端\"]，无则 [])、" +
    "depends_on(依赖的其它任务 id 数组，无则 [])、" +
    "feasible(是否可行，布尔)、already_done(是否已达成无需做，布尔)。" +
    "规则：不遗漏任何任务；不合并；请求没写项目号时 project 必须为 null，交给模块映射校正，不许猜；" +
    "禁止调用任何工具/读文件/搜索/联网；只输出一个 JSON 对象 {\"tasks\":[...]}，能被 JSON.parse 直接解析，不要 Markdown 代码块、不要任何前后缀文字。" +
    hintText + "\n请求：" + request + '\n以下原始任务清单是权威清单。逐条返回相同的 T001 等 id，不添加、不遗漏、不合并任务。summary 可概述，执行正文由主控按 id 恢复；depends_on 也使用原始 id。\n'+JSON.stringify(requestTasks(request))
  );
}
// 阶段 B：确定性分块引擎。消费扁平任务清单 -> 产出 blocks（可行性过滤 + 模块归位 + 工具独立 + 未知串行 + 依赖映射）。
function buildBlocksFromTasks(tasks, hints = {}) {
  tasks = Array.isArray(tasks) ? tasks : [];
  const modToProj = (hints && hints.moduleToProj) || {};
  const foldRules = (hints && hints.foldRules) || {};
  const tailKeywords = Array.isArray(hints && hints.tailKeywords) ? hints.tailKeywords : [];
  const byProj = {};      // proj-N -> [item]
  const toolItems = [];   // kind=tool/system
  const unkItems = [];    // 无归属 -> linked 串行（绝不并行孤儿）
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    // Model flags are suggestions, never authority to discard a requested task.
    const summary = String(t.summary || t.prompt || "").trim();
    if (!summary) continue;
    let p = String(t.project || "").replace(/[^0-9]/g, "");
    if (!p) for (const [mod, pn] of Object.entries(modToProj)) { if (summary.includes(mod)) { p = String(pn).replace(/[^0-9]/g, ""); break; } }
    const item = { id: String(t.id || "t" + (byProjKeyCount(byProj) + toolItems.length + unkItems.length + 1)), summary, kind: String(t.kind || ""), depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : [], conflict_hints: Array.isArray(t.conflict_hints) ? t.conflict_hints.map(String) : [] };
    if (p) (byProj["proj-" + p] = byProj["proj-" + p] || []).push(item);
    else if (item.kind === "tool" || item.kind === "system") toolItems.push(item);
    else unkItems.push(item);
  }
  // Validate task-level dependencies BEFORE grouping can hide internal cycles.
  const allItems=[...Object.values(byProj).flat(),...toolItems,...unkItems];
  const orderedItems=levelWaves(allItems.map(it=>({key:it.id,b:{},dependsOn:it.depends_on,it}))).flat().map(r=>r.it);
  const rank=new Map(orderedItems.map((it,i)=>[it.id,i]));
  for(const list of [...Object.values(byProj),toolItems,unkItems])list.sort((a,b)=>rank.get(a.id)-rank.get(b.id));
  // fold 规则：某工具/系统任务命中 fold 关键字 -> 折进指定项目（作为该项目任务一环，不再独立并行，避免与项目竞态）。
  for (const key of Object.keys(foldRules)) {
    const targets = (foldRules[key] || []).map((x) => String(x).replace(/[^0-9]/g, ""));
    for (const list of [toolItems, unkItems]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].summary.includes(key)) {
          const tt = list.splice(i, 1)[0];
          for (const pn of targets) {
            (byProj["proj-" + pn] = byProj["proj-" + pn] || []).push({ id: tt.id + "-fold" + pn, summary: tt.summary, sourceTaskId:tt.id, kind: "project", depends_on: tt.depends_on, conflict_hints: tt.conflict_hints });
          }
        }
      }
    }
  }
  const blocks = [];
  const blockItems = [];   // 与 blocks 平行的源 item 数组，用于依赖映射
  for (const [title, arr] of Object.entries(byProj)) {
    arr.sort((a,b)=>rank.get(a.sourceTaskId||a.id)-rank.get(b.sourceTaskId||b.id));
    blocks.push({ type: "independent", title, dependsOn: [], conflictKeys: ["dir:" + title,...arr.flatMap(it=>it.conflict_hints.map(h=>h.includes(":")?h:"file:"+h))], tasks: [{ id: "t" + (blocks.length + 1), title, prompt: "仅处理项目 " + title + "。任务：" + arr.map((a) => a.summary).join("；") + "。不要处理其它项目编号。" }] });
    blockItems.push(arr);
  }
  for (const it of toolItems) {
    const title = "task-" + (blocks.length + 1);
    blocks.push({ type: "independent", title, dependsOn: [], conflictKeys: it.conflict_hints.map((h) => (h.includes(":") ? h : "file:" + h)), tasks: [{ id: "t" + (blocks.length + 1), title, prompt: it.summary }] });
    blockItems.push([it]);
  }
  if (unkItems.length) {
    const title = "linked-ambiguous";
    blocks.push({ type: "linked", title, dependsOn: [], conflictKeys: [], tasks: unkItems.map((it, idx) => ({ id: "t" + (blocks.length + 1) + "-" + (idx + 1), title: it.summary.slice(0, 40), prompt: it.summary })) });
    blockItems.push(unkItems);
  }
  // 依赖映射：item.depends_on (task id) -> 所在块 title
  for (let i = 0; i < blocks.length; i++) {
    const deps = new Set();
    for (const it of blockItems[i]) {
      for (const depId of it.depends_on) {
        for (let j = 0; j < blocks.length; j++) {
          if (j !== i && blockItems[j].some((x) => x.id === depId || x.sourceTaskId === depId)) { deps.add(blocks[j].title); }
        }
      }
    }
    blocks[i].dependsOn = [...deps];
  }
  // tail 规则：命中 tail 关键字的块（收尾/汇总类，如 "最后用Visualize"）依赖所有项目块，跑在最后。
  if (tailKeywords.length) {
    const projTitles = blocks.filter((b) => b.title.startsWith("proj-")).map((b) => b.title);
    for (const b of blocks) {
      const text = (b.tasks && b.tasks[0] && b.tasks[0].prompt) || "";
      if (tailKeywords.some((k) => text.includes(k))) {
        b.dependsOn = Array.from(new Set([...(b.dependsOn || []), ...projTitles]));
      }
    }
  }
  return blocks;
}
function byProjKeyCount(map) { let n = 0; for (const k in map) n += (map[k] || []).length; return n; }
/**
 * 【兜底】当 LLM 拆块失败/超时且重试耗尽时，保证 --run-windows 仍能真正拉起而不是死掉：
 * 把整条请求作为【一个 linked 块】（单窗、严格串行、无并发冲突），确保至少有一个真实执行窗落地，
 * 绝不因「拆不出合法 JSON」而让整批一个窗都不弹。linked = 串行 = 不会与其它窗冲突，符合底层思路。
 */
/**
 * 验收契约覆盖开关（acceptance override，允许重新绑定被改写的验收契约）。
 * 默认关闭：契约与账本记录的摘要不一致时 verify/resume 直接拒绝，
 * 只有操作者显式加 --allow-acceptance-change 或 ORCH_ACCEPTANCE_OVERRIDE=1 才放行并留痕。
 */
function acceptanceOverride() {
  return process.env.ORCH_ACCEPTANCE_OVERRIDE === '1' || process.argv.includes('--allow-acceptance-change');
}
function fallbackPlan(request) {
  return {
    blocks: [
      {
        type: "linked",
        title: "autosafe-serialized",
        dependsOn: [],
        conflictKeys: [],
        tasks: [
          { id: "1", title: "autosafe-serialized", prompt: String(request || "") }
        ]
      }
    ]
  };
}

/**
 * 安全拆块：先用 LLM 分类（read-only），失败/超时则重试（ORCH_DECOMPOSE_RETRIES，默认 2），
 * 重试耗尽仍无合法 JSON 时回退到 fallbackPlan —— 单串行窗，确保整批一定落地。
 * 返回已 normalize + split 的 blocks；绝不因拆块失败而抛错中止整批。
 */
async function decomposeSafely(request, maxWindows = computeMaxWindows(os.totalmem() / 1024 ** 2)) {
  const finalize = plan => capPlanBlocks(normalizePlan(plan), maxWindows);
  const hints = resolveHints(); // hints 参与缓存键（moduleToProj/foldRules/tail），防跨项目映射撞缓存
  // 0) 缓存优先：相同请求+相同 hints 的拆块结果永不自动失效（仅 --clear-cache 或删除缓存文件才重置），
  //    命中直接复用 -> 越用越快（与下方 loadDecomposeCache 的“永不自动失效”实现保持一致）。
  const cached = loadCachedDecompose(request, hints);
  if (cached && Array.isArray(cached.blocks) && cached.blocks.length) {
    console.log("[orchestrator] decompose cache HIT -> " + cached.blocks.map((b) => b.title).join(", "));
    return finalize(cached.blocks);
  }
  // 1) 通用确定性启发（非硬编码项目路径）：请求里出现多个不同项目目录 -> 单独拆块，秒级返回并写缓存。
  const det = genericProjectSplit(request);
  if (det && Array.isArray(det.blocks) && det.blocks.length) {
    console.log("[orchestrator] generic project split -> " + det.blocks.map((b) => b.title).join(", "));
    saveDecompose(request, det.blocks, hints);
    return finalize(det.blocks);
  }
  // 1.5) 单任务快速路径（通用，非写死路径）：明确"单动作"请求 -> 单一窗口，跳过 LLM 拆块，秒级+写缓存。
  const sb = trySingleBlock(request);
  if (sb && Array.isArray(sb.blocks) && sb.blocks.length) {
    console.log("[orchestrator] single-block fast path -> " + sb.blocks[0].title);
    saveDecompose(request, sb.blocks, hints);
    return finalize(sb.blocks);
  }
  // 2) 两段式：LLM 定性（扁平任务清单）→ 确定性分块引擎。失败/超时则重试。
  // hints 已上移到函数开头解析（参与缓存键）。
  const attempts = Math.max(1, Number(process.env.ORCH_DECOMPOSE_RETRIES || 2));
  let lastErr = "";
  let seenNoJson = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await runThreadPrompt(classifyPrompt(request, hints) +
        `\nMaximum execution blocks: ${maxWindows}. Return ALL tasks; overflow tasks will be merged into serial blocks. Never omit tasks to meet the window budget.`, { sandboxMode: "read-only" });
      if (res?.errored) throw new Error(String(res.errored));
      let plan;
      try {
        const tasks = bindClassifiedTasks(request,extractTasks(res.final || ""));
        plan = buildBlocksFromTasks(tasks, hints);
        if (!plan || !plan.length) throw new Error("plan.blocks empty");
      } catch (e2) {
        if (/no JSON in classify output|no tasks array|plan\.blocks empty/.test(e2 && e2.message ? e2.message : String(e2))) seenNoJson = true;
        if (i === attempts - 1) throw e2;
        lastErr = e2 && e2.message ? e2.message : String(e2);
        continue;
      }
      if (plan && plan.length) { saveDecompose(request, plan, hints); return finalize(plan); }
      lastErr = lastErr || "(extracted empty plan)";
      if (i === attempts - 1) throw new Error(lastErr);
    } catch (e) {
      if(/Unknown dependency|Self dependency|Cyclic dependencies|Ambiguous block identity/.test(e.message||""))throw e;
      const retry = capacityRetryPolicy(e, i + 1);
      if (retry.retry) {
        console.warn(`[orchestrator] provider capacity; retry ${retry.attempt}/${retry.maxRetries} after ${retry.delayMs}ms`);
        if (retry.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
        lastErr = e && e.message ? e.message : String(e);
        continue;
      }
      lastErr = e && e.message ? e.message : String(e);
    }
  }
  console.warn("[orchestrator] decompose LLM failed after " + attempts + " attempt(s): " + lastErr +
    (seenNoJson ? " (no valid JSON)" : "") + " -> fallback to single serial block (autosafe detect).");
  return finalize(fallbackPlan(request).blocks);
}
function extractTasks(raw) {
  const s = String(raw || "");
  const stripped = s.replace(/```(?:json)?/gi, "").trim();
  let parsed;
  try {
    const m = stripped.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : stripped);
  } catch (e) {
    throw new Error("no JSON in classify output: " + s.slice(0, 300));
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
  throw new Error("no tasks array in classify output");
}
/**
 * 【确定性拆块 · 面向 open-code-review 方向】不依赖 LLM，按请求里显式提及的项目目录
 * （build/80、build/81、build/82、build/83，或任意 build/<N>）把任务拆成独立块，秒级返回。
 * 用于「按项目/目录并行」这类高确定性的场景，避免 LLM 分类慢/不稳。
 * 若请求未明确提及多个项目目录，返回 null（交给 LLM 拆块）。
 */
/**
 * Hard-split: any "independent" block that carries multiple tasks is flattened into one
 * block per task (so each independent task gets its OWN window and runs in parallel).
 * Only a block typed "linked" may keep multiple tasks (those run serialized in ONE window).
 * This enforces "don't over-merge independent work" even if the decompose model mis-bundles.
 */
// ---------------------------------------------------------------------------
// Decompose cache: reuse identical-request block plans INDEFINITELY.
// It NEVER auto-expires (no year rollover / TTL); only `--clear-cache` (or
// deleting the cache file) resets it, so ANY user who installs this
// orchestrator gets "the more you use it, the faster it gets" without any
// hardcoded project paths. Deterministic safety heuristic below is generic
// (any mention of multiple distinct project-like dirs), not specific to build/80|81|82|83.
// ---------------------------------------------------------------------------
const DECOMPOSE_CACHE = path.join(STATE_DIR, "orchestrator-decompose-cache.json");
function buildBlockPrompt(body, tk) {
  return String(body || "") + "\n\n【本块唯一标识】" + tk + "\n（执行结束判定 = 本窗完成实际操作并现场验证后，**最后只输出一行结束标记 `__ORCH_DONE__ " + tk + "`**，不做任何汇报/多余输出；输出后等待被 watchdog 关闭。主控会关窗后按本任务提示词核对真实落盘状态。）\n";
}

function hintsKey(hints = {}) {
  const norm = {
    moduleToProj: (hints && hints.moduleToProj) || {},
    foldRules: (hints && hints.foldRules) || {},
    tailKeywords: Array.isArray(hints && hints.tailKeywords) ? hints.tailKeywords : [],
  };
  return JSON.stringify(norm);
}
function decomposeHash(request, hints = {}) {
  return crypto.createHash("sha1").update(CORE_VERSION + "|" + String(request || "") + "|" + hintsKey(hints)).digest("hex");
}
function loadDecomposeCache() {
  try {
    if (existsSync(DECOMPOSE_CACHE)) {
      const j = JSON.parse(readFileSync(DECOMPOSE_CACHE, "utf8").replace(/^\uFEFF/, ""));
      if (j && j.version === CORE_VERSION && j.entries && typeof j.entries === "object") return j; // 永不自动失效（用户 --clear-cache 才清）
    }
  } catch { /* corrupted -> rebuild */ }
  return { version: CORE_VERSION, entries: {} };
}
function saveDecomposeCache(obj) {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(DECOMPOSE_CACHE, JSON.stringify(obj), "utf8"); } catch { /* best effort */ }
}
function loadCachedDecompose(request, hints) {
  const h = decomposeHash(request, hints);
  const j = loadDecomposeCache();
  const e = j.entries[h];
  if (!e) return null;
  return e;
}
function saveDecompose(request, plan, hints) {
  withRegistryLock(()=>{
  const h = decomposeHash(request, hints);
  const j = loadDecomposeCache();
  j.entries[h] = { createdAt: Date.now(), blocks: plan };
  saveDecomposeCache(j);
  });
}
// Generic deterministic aid (NOT hardcoded to build/80|81|82|83): if the request
// names several distinct existing project-like dirs, split them into independent
// windows. Returns null when ambiguous, so the LLM handles the rest.
function genericProjectSplit(request) {
  // 保守、确定性拆分（权威修复）：仅当请求能被可靠切成"每个编号各有一个专属句子"时才拆，
  // 且每个块 prompt 只针对该项目（绝不整段重复）。混合/歧义请求返回 null 交给 LLM 语义拆块。
  const dirs = new Set();
  const re = /(?:^|[\s,/\\：:])(?:项目|project|proj|build|app|src|workspace|web|site|game)[-\s/\\：:]*(\d{1,3})(?=\D|$)/gi;
  let m;
  while ((m = re.exec(request))) { const n = m[1]; if (n) dirs.add("proj-" + n); }
  // fallback: bare 2-3 digit project numbers only in a task/action context
  // (e.g. "给80的前端", "修复81的空白").  Do not scan every standalone number:
  // UUID nonces, ids embedded in filenames, and numeric acceptance values are
  // data, not project references, and must not change the parallel plan.
  const bareRe = /(?:^|[\s，,、:：;；])(?:(?:修复|优化|修改|更新|检查|创建|处理|给|为|对|向|在|针对)\s*)?(\d{2,3})(?=\D|$)/g;
  while ((m = bareRe.exec(request))) { const n = m[1]; if (n) dirs.add("proj-" + n); }
  if (dirs.size < 2) return null;
  const sentences = requestTasks(request).map(t=>t.prompt);
  const ownByProj = {};
  const misc = [];
  let ambiguous = false;
  for (const s of sentences) {
    const hits = [];
    for (const d of dirs) { const n = d.replace("proj-", ""); if (projectRef(s, n)) hits.push(d); }
    if (hits.length === 1) (ownByProj[hits[0]] = ownByProj[hits[0]] || []).push(s);
    else if (hits.length > 1) ambiguous = true;
    else misc.push(s);
  }
  const allOwn = [...dirs].every((d) => (ownByProj[d] && ownByProj[d].length > 0));
  // 保守(权威修复)：一旦存在无法归属到某个具体项目编号的句子（如"给会员管理…做分页"这种跨项目续句），
  // 确定性拆分无法安全归类——若硬把它当成独立 task-* 并行块，会与它真实所属项目竞态/改同一批文件。
  // 此时整体交给 LLM 拆块：LLM 能读上下文，把它归到正确项目，同时仍会把真正独立的工具任务(openclaw/theme-repo/visualize 等)单独成块。
  if (!allOwn || ambiguous || misc.length > 0) return null;
  const blocks = [...dirs].map((title, i) => ({
    type: "independent", title, dependsOn: [],
    conflictKeys: ["dir:" + title],
    tasks: [{ id: "t" + (i + 1), title, prompt: "仅处理项目 " + title + "。任务：" + ownByProj[title].join("；") + "。不要处理其它项目编号。" }],
  }));
  return blocks.length ? { blocks } : null;
}
function projectRef(s, n) {
  // Require a project keyword/path or an action-context bare number.  A loose
  // optional prefix would also match UUID chunks, receipt ids, and sums.
  const named = new RegExp("(?:^|[\\s,/\\\\：:])(?:项目|project|proj|build|app|src|workspace|web|site|game)[-\\s/\\\\：:]*" + n + "(?![0-9])", "i");
  const bare = new RegExp("(?:^|[\\s，,、:：;；])(?:(?:修复|优化|修改|更新|检查|创建|处理|给|为|对|向|在|针对)\\s*)?" + n + "(?![0-9])", "i");
  return named.test(s) || bare.test(s);
}
// 通用单任务快速判定（不写死 build/N）：无"多动作/多目标"标记、且命中明确动作词 -> 生成单一独立块。
function trySingleBlock(request) {
  const text = String(request || "").trim();
  if (!text) return null;
  // 多动作/多目标/并列连词/分号/列举 -> 保守：一律交给 LLM/genericProjectSplit（少拆不误拆）。
  if (/(和|同时|还|以及|另外|一并|分别|然后|随后|再|并|与|或|、|；|，|,)/.test(text)) return null;
  if ((text.match(/。/g) || []).length > 1) return null; // 多个句子视为多任务
  // 项目目录计数：>1 交 LLM；=1 且单动作 -> 单块指向该目录。
  const dirRe = /(?:build|proj|project|app|src|workspace|web|site|game)[\s/\\]+(\d{1,3})/gi;
  const dirSet = new Set(); let mm; while ((mm = dirRe.exec(text))) dirSet.add("proj-" + mm[1]);
  if (dirSet.size > 1) return null;
  const actionRe = /(?:创建|写|改|删|复制|启动|重启|生成|新增|修改|优化|修复|清理|列出|检查|删掉|建立|添加)/;
  if (!actionRe.test(text)) return null;
  if (dirSet.size === 1) {
    const d = [...dirSet][0];
    return { blocks: [{ type: "independent", title: d, dependsOn: [], conflictKeys: ["dir:" + d], tasks: [{ id: "t1", title: d, prompt: text }] }] };
  }
  return { blocks: [{ type: "independent", title: "single-task", dependsOn: [], conflictKeys: [], tasks: [{ id: "t1", title: "single-task", prompt: text }] }] };
}
function splitSentences(request) {
  // 分句含全角/半角逗号：逗号常分隔多个并列目标（如 "修复81的空白，优化82的UI" 是两个独立项目）。
  // 若逗号后是不带项目号的续句，会在 genericProjectSplit 落入 misc -> 整体交 LLM，仍安全（少拆不误拆）。
  return String(request).split(/[。；;，,\n]+/).map((s) => s.trim()).filter(Boolean);
}
async function runThreadPrompt(prompt, opts = {}) {
  if(AGENT.agent==='pi')return runPiPlanner(AGENT.config,prompt,WORKSPACE);
  // outputSchema 走 runStreamed 的 turn 选项（强制结构化输出 / 纯 JSON），不能混进 startThread 配置。
  const { outputSchema, ...threadOpts } = opts;
  const thread = codex.startThread({ ...threadBase(), ...threadOpts });
  const ac = new AbortController();
  const turnOpts = { signal: ac.signal };
  if (outputSchema) turnOpts.outputSchema = outputSchema;
  const { events } = await thread.runStreamed(prompt, turnOpts);
  const ORCH_DECOMPOSE_TIMEOUT_MS = Number(process.env.ORCH_DECOMPOSE_TIMEOUT_MS || 60000);
  const abortTimer = setTimeout(() => { try { ac.abort(); } catch {} }, ORCH_DECOMPOSE_TIMEOUT_MS);
  let final = "";
  let errored = null;
  const warnings = [];
  let turnDone = false;
  // The SDK streams raw JSONL events from `codex exec` as {type:"event_msg",payload:{type:...}}; it
  // also accepts an AbortSignal. Two facts:
  //   1. `codex exec` can exit non-zero (e.g. "Reading prompt from stdin", exit -1) on a flaky call —
  //      treat that as a failed attempt so the orchestrator RETRIES it instead of crashing the batch.
  //   2. The RECURRING "codex-sdk stuck" bug: `codex exec` FINISHES normally (session rollout gets
  //      `task_complete`) but the async generator NEVER closes, so a naive `for await` hangs forever and
  //      --run-windows stalls at the decompose/execute step. We therefore read until the terminal event
  //      (`task_complete` / `turn.completed` / `turn.failed` / `error`), capture the final message, then
  //      `break` + abort to close the generator immediately (no idle stall tax).
  const textOf = (item) => {
    if (!item) return "";
    if (typeof item.text === "string") return item.text;
    if (typeof item.reasoning === "string") return item.reasoning;
    if (Array.isArray(item.content)) return item.content.map((c) => (c && (c.text || c.text_delta || c.reasoning_text || c.reasoning_content)) || "").join("");
    return "";
  };
  let lastReasoning = ""; // GLM 会把思考写进 reasoning_content、正文留空；作为兜底
  const startedAt = Date.now();
  try {
    for await (const ev of events) {
      // Absolute safety cap (never hang forever), used only if no terminal event arrives.
      if (Date.now() - startedAt > (Number(process.env.ORCH_STREAM_CAP_MS) || 600000)) { errored = errored || "thread absolute timeout"; ac.abort(); clearTimeout(abortTimer); break; }
      const p = ev.payload || {};
      const ptype = p.type;
      const normType = ev.type;
      const item = ev.item || p.item;
      // Terminal: the turn is genuinely finished. Capture the final message, then close the stream.
      if (
        ptype === "task_complete" || ptype === "turn_failed" || ptype === "error" ||
        normType === "turn.completed" || normType === "turn.failed" || normType === "error"
      ) {
        if (p.last_agent_message && typeof p.last_agent_message === "string" && p.last_agent_message) final = p.last_agent_message;
        if (!final && lastReasoning) final = lastReasoning; // content 优先、空则读 reasoning
        if (normType === "turn.failed" || ptype === "turn_failed") errored = (ev.error && ev.error.message) || p.error_message || p.error || "turn failed";
        else if (normType === "error" || ptype === "error") errored = ev.message || p.message || "error";
        turnDone = true;
        ac.abort(); // close the generator now — do not wait for it to finish on its own
        clearTimeout(abortTimer); // 修象: 不在正常终止路径泄漏
        break;
      }
      if (ptype === "item_completed" || normType === "item.completed") {
        if (item) {
          if (item.type === "agent_message" || item.type === "AgentMessage") {
            const t = textOf(item) || textOf(p);
            if (t) final = t.trim();
          } else if (item.type === "reasoning" || item.type === "Reasoning") {
            const rt = textOf(item) || textOf(p);
            if (rt) lastReasoning = rt.trim();
          } else if (item.type === "command_execution" && (item.status === "failed" || item.status === "error")) {
            warnings.push("cmd exit " + item.exit_code + ": " + String(item.command || "").slice(0, 120));
          } else if (item.type === "file_change" && (item.status === "failed" || item.status === "error")) warnings.push("patch failed");
        }
      }
      else if (ptype === "reasoning" || normType === "reasoning" || p.type === "reasoning" || (item && (item.type === "reasoning" || item.type === "Reasoning"))) {
        const rt = textOf(item) || textOf(p);
        if (rt) lastReasoning = rt.trim();
      }
    }
  } catch (e) {
    clearTimeout(abortTimer);
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    // If we completed via task_complete/turn then an abort is the intended close, not an error.
    if (!aborted || !turnDone) errored = "codex exec failed (" + (e && e.message ? e.message : String(e)) + ")";
  }
  if (!errored && !final) errored = warnings.length ? warnings[warnings.length - 1] : "(no output)";
  return { final, errored, warnings };
}
function trunc(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "..." : s;
}
function titleOf(key, title) {
  // 可读 ASCII 标题：保留英数/常见符号，中文与其它非ASCII统一转成 -（避免 conhost 标题乱码）
  const a = String(title || "").replace(/[^A-Za-z0-9_.\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return key + ":" + (a || "task");
}
function safe(t) {
  return String(t).replace(/[^A-Za-z0-9_-]/g, "_") || "codex-task";
}
function blockBody(block) {
  const body = block.tasks.map((t, i) => `${i + 1}. ${t.prompt}`).join("\n");
  // 防御：无论 block.type 为何，只要一个窗里塞了多个任务，就绝不能说“互相独立/并行”——多任务在同一窗内必然串行。
  // 曾有独立型块携带两个有先后依赖的任务（写 s.txt → 读它追加 z.txt），却因 type 标成 independent 而被 blockBody
  // 输出“互不依赖、并行执行”，误导窗内 agent 把有依赖的任务当独立处理、漏做第二步，导致落盘缺失但 status=done。
  // 修正：>1 任务的块一律按串行说明，杜绝“并行”误导。
  const multiTask = block.tasks.length > 1;
  return (
    (block.type === "linked" || multiTask
      ? "\n上面任务共享同一资源/存在依赖，若并行会冲突，故必须串行：先做第1个，做完再做第2个，依次进行，绝不同时并行。全部完成再汇报。"
      : "\n上面任务之间互相独立、互不依赖：并行执行，互不等待。全部完成后汇总结果。") +
    "\n\n【每个任务做完都必须现场自验】对每个改动：1) 读回创建/修改的文件，确认内容与编码（UTF-8 无 BOM）；2) 跑一次回归/验证命令确认可用；3) 确认无残留临时文件、无中文乱码。**自验不过=该任务未完成**，如实说明失败点与现场，禁止以“做完了”掩盖。" +
    "\n\n【执行纪律·禁止只计划不干活】本窗是授权真实执行窗，必须**在本窗内真正动手修改/执行**，逐项完成并自验，最后才输出以「【本块唯一标识】…完成」开头的汇报。**禁止**只输出“已定位/先读配置/先看日志/先确认归属/继续核查”这类计划、定位、核查性文字就当作完成；禁止停在“先…”。若确需先核查，也必须在同一窗内继续把改动做完、验证到位，不要只规划不落地。" +
    "\n\n" + body
  );
}
// ---- "原型/可行性检测"前置门禁（硬约束，已内嵌本 SDK，不依赖外部技能文件）----
// 每个真实块在 spawn 前做一次内嵌预检：prototype-validation 的"可行性"能力已并入本函数。
// 判定标准：本地执行块几乎都是用户明确要求做的真实改动，默认可行；仅当提示为空/无实际指令才判不可行，避免误拦"新建文件"类任务。
// 确定性复杂度分类：命中任一 -> "复杂"，才可能走 LLM 原型。简单块永远不拦（防误拦建新目录等）。
function classifyBlockComplexity(prompt) {
  const t = String(prompt || "");
  if ((t.match(/。/g) || []).length > 1) return true;          // 多句
  if (/检查|修复|优化|重构|排查|为什么|怎么回事|调整|完善|推进|分析/.test(t)) return true; // 分析/决策
  if (/根据|按照|结合|参照/.test(t)) return true;               // 上下文依赖
  if (t.length > 300) return true;                              // 长指令
  return false;
}
// 可行性门禁（L1 空判）：复杂/可行性判断已由拆块 LLM 定性（feasible/already_done）承担，
// 这里只保留最后一道确定性 sanity 空判，不再为每块单独调一次 LLM（避免重复往返）。
async function runPrototypeGate(title, prompt) {
  const text = String(prompt || "").trim();
  if (!text) { console.log("  preflight FAILED for [" + title + "] (empty/无动作): reject."); return false; }
  console.log("  preflight PASSED for [" + title + "] (feasibility already resolved at decompose)");
  return true;
}
// Enforcement: once the orchestrator is engaged, mark that real executions are gated. The
// sanction engine is --run-windows (a real, visible, interactive TUI window). headless --run/--exec
// open-tui-orchestrator-force.mjs reads
// this marker: from a NON-window context it refuses real-execution kinds and tells the caller to
// route through --run-windows. A sanctioned window sets $env:ORCH_WINDOW=1 (in its launcher)
// so it passes the guard.
const ORCH_ARMED = path.join(STATE_DIR, ".orchestrator-enabled");
function armEnforcement() {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ORCH_ARMED, String(Date.now()), "utf8"); } catch { /* ignore */ }
}
// ---- CLI 环境检测与安装（硬约束：先确保 codex CLI 可用，再谈后续）----
// 检测 codex 可执行；找不到则用 node22 的 npm 全局安装 @openai/codex；仍不行则报错中止。
function ensureCodexCli() { return AGENT.config.bin; }
// ---------------------------------------------------------------------------
// Superpowers 插件检测（用户要求：运行环境检测里加入对 Superpowers plugin 的检测）。
// 若 Superpowers 可正常使用 -> 让 Superpowers 参与到后续流程（并发分析 + 并发干活，强强联合）；
// 若未检测到 -> 一切照旧（不因缺少它而降级/报错）。只读探测，绝不安装/改动 Superpowers。
// 判定标准：插件缓存目录存在 + 其 using-superpowers SKILL.md 存在 + 该插件在 config.toml 被启用。
// ---------------------------------------------------------------------------
// 通用化：superpowers 缓存目录默认在 CODEX_HOME 下；允许外部用 ORCH_SUPERPOWERS_CACHE_DIR 覆盖，适配不同宿主/插件市场。
const SUPERPOWERS_CACHE_DIR = process.env.ORCH_SUPERPOWERS_CACHE_DIR || path.join(CODEX_HOME, "plugins", "cache", "openai-api-curated", "superpowers");
function configPluginEnabled(name) {
  try {
    const cfg = readFileSync(path.join(CODEX_HOME, "config.toml"), "utf8");
    return cfg.includes('plugins."' + name + '"') && /\[plugins\."[^"]+"\]\s*\r?\nenabled\s*=\s*true/.test(cfg);
  } catch { return false; }
}
function detectSuperpowers() {
  try {
    if (!existsSync(SUPERPOWERS_CACHE_DIR)) return { available: false, reason: "plugin cache dir absent" };
    const skillMd = path.join(SUPERPOWERS_CACHE_DIR, "1e285826", "skills", "using-superpowers", "SKILL.md");
    if (!existsSync(skillMd)) return { available: false, reason: "using-superpowers SKILL.md absent" };
    if (!configPluginEnabled("superpowers@openai-api-curated")) return { available: false, reason: "superpowers plugin not enabled" };
    return { available: true, reason: "superpowers usable" };
  } catch (e) { return { available: false, reason: (e && e.message ? e.message : "unknown") }; }
}
// ---------------------------------------------------------------------------
// 初始环境检测：磁盘空间检查（与技术栈/CLI 同层）。工作区所在盘需容纳 TUI 窗临时文件与窗内产物。
// 低于 ORCH_MIN_FREE_MB（默认 12000MB≈12GB）告警；低于 ORCH_MIN_FREE_HARD_MB（默认 3600MB≈3.6GB）直接拒绝（fail-closed）。
// warnOnly=true：只告警、绝不拦截（供 --plan 等只读命令使用）。
function checkDiskSpace(opts = {}) {
  const warnOnly = !!opts.warnOnly;
  const wsPath = opts.workspace || WORKSPACE;
  try {
    const s = statfsSync(wsPath);
    const freeMB = Math.round((s.bavail * s.bsize) / (1024 * 1024));
    const minMB = Number(process.env.ORCH_MIN_FREE_MB || 12000);
    let hardMB = Number(process.env.ORCH_MIN_FREE_HARD_MB || 3600);
    if (!Number.isFinite(hardMB) || hardMB > minMB) {
      if (Number.isFinite(hardMB) && hardMB > minMB) console.warn("[orchestrator] WARN: ORCH_MIN_FREE_HARD_MB (" + hardMB + ") > ORCH_MIN_FREE_MB (" + minMB + "); clamping hard floor to min.");
      hardMB = minMB;
    }
    if (!Number.isFinite(freeMB) || freeMB < 0) throw new Error("unexpected statfs result");
    if (freeMB < hardMB) {
      if (warnOnly) {
        console.warn("[orchestrator] WARN: workspace disk critically low (" + freeMB + "MB free < " + hardMB + "MB hard floor) at " + wsPath + "; --plan is read-only so still runs, but --run-windows would refuse.");
        return true;
      }
      console.error("[orchestrator] FATAL: workspace disk too low (" + freeMB + "MB free < " + hardMB + "MB hard floor) at " + wsPath + "; refusing to run (fail-closed).");
      return false;
    }
    if (freeMB < minMB) {
      console.warn("[orchestrator] WARN: low disk space (" + freeMB + "MB free < " + minMB + "MB) at " + wsPath + "; TUI window/temp may fail.");
      return true;
    }
    console.log("[orchestrator] disk: workspace " + wsPath + " free=" + freeMB + "MB (min " + minMB + "MB / hard " + hardMB + "MB)");
    return true;
  } catch (e) {
    console.warn("[orchestrator] WARN: could not stat workspace disk (" + (e && e.message ? e.message : String(e)) + "); skipping space check.");
    return true;
  }
}
// ---------------------------------------------------------------------------
// Visible window (REAL popup, via cmd /c start — reliably opens a new console)
// ---------------------------------------------------------------------------
// Trust configuration is owned by the user, never rewritten here.
function spawnVisibleWindow(lp, title) {
  // Workspace trust remains under the host/user configuration.
  // Prefer Windows Terminal: it natively supports IME/TSF composition, so the Codex
  // TUI keeps accepting Microsoft 拼音/日语 IME switches (fixes "偶发失效"). Codex
  // runs the same launcher (UTF-8 + chcp 65001), just hosted in a WT ConPTY.
  if (TUI_MODE === "wt" && WT_EXE && wtAvailable()) {
    // Unique window name is for terminal routing only; never kill its shared host process.
    const bn = path.basename(String(lp || ""));
    const winS = bn.replace(/^win-launch-/, "").replace(/\.ps1$/, "");
    const windowName = "win-" + (winS || "x");
    spawnInactiveWindow(WT_EXE, ["-w", windowName, "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", lp], WORKSPACE);
    console.log("spawned visible " + AGENT.agent + " TUI (Windows Terminal): " + title + " (window=" + windowName + ")");
    return;
  }
  const powershell=path.join(process.env.SystemRoot||process.env.WINDIR||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const conhost=path.join(process.env.SystemRoot||process.env.WINDIR||'C:\\Windows','System32','conhost.exe');
  spawnInactiveWindow(conhost,[powershell,'-NoProfile','-ExecutionPolicy','Bypass','-File',lp],WORKSPACE);
  console.log("spawned visible " + AGENT.agent + " TUI (inactive console): " + title);
}
// 弹窗后精准检测：pid 文件存在 + launcher(WT pane 宿主)进程存活 => 窗口真弹出（见 windowGenuinelyPopped）。
// 失败重试（上限 maxRetry，默认 3），仍失败返回 false（由调用方标记 popup-failed 并汇报）。
const launcherScanAt = new Map();
function launcherPidByScript(lp) {
  if (!lp) return 0;
  const now = Date.now();
  const previous = launcherScanAt.get(lp) || 0;
  if (previous && now - previous < 2000) return 0;
  launcherScanAt.set(lp, now);
  if (launcherScanAt.size > 256) launcherScanAt.delete(launcherScanAt.keys().next().value);
  try {
    const escaped = String(lp).replace(/'/g, "''");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      "$ErrorActionPreference='SilentlyContinue'; $q = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*" + escaped + "*' } | Sort-Object CreationDate | Select-Object -First 1; if ($q) { $q.ProcessId }"],
      { windowsHide: true, encoding: "utf8", timeout: 8000 });
    const pid = readPidFileValue(String(r.stdout || "").trim());
    return pidAliveCheck(pid) ? pid : 0;
  } catch { return 0; }
}
function readPidFileValue(value) {
  const p = Number(String(value || "").trim());
  return Number.isFinite(p) && p >= 1 && p <= 4194304 ? p : 0;
}
function windowGenuinelyPopped(pidf, token, launcherPath) {
  // 弹窗精准判定 = pid 文件存在 + launcher 进程真实存活（launcher 是 Windows Terminal pane 宿主进程，存活即窗口已弹出）。
  // 不把 agent 子进程作为必选证据：agent 冷启动(模型 provider)可能很慢，若等它会把"已弹出"误判为未弹出而重复弹窗；agent 未起由回收超时兜底。
  if (!pidf) return false;
  let pid = existsSync(pidf) ? readPidFile(pidf) : 0;
  // Recover the pid file when the launcher is already alive but has not flushed
  // its first line yet. This closes the late-start/retry race without touching
  // another window because launcherPath is unique to this attempt.
  if (!pid && launcherPath) {
    const discovered = launcherPidByScript(launcherPath);
    if (discovered) {
      try { writeFileSync(pidf, String(discovered), "utf8"); } catch { /* launcher may win the race */ }
      pid = readPidFile(pidf) || discovered;
    }
  }
  if (!pid) return false;
  if (!pidAliveCheck(pid)) return false;
  return true;
}
// 加固②：检测「launcher 下是否已出现 agent 子进程」。windowGenuinelyPopped 只证明 launcher(WT pane 宿主)活着，
// 但 codex TUI 冷启动(模型 provider)可能仍很慢——若父进程立刻去等 session rollout，会因 rollout 还没建而误判
// "no session rollout matched"。此函数在弹窗确认后继续短等 agent 子进程出现，让父进程的会话匹配不会起跑太早。
// 只读探测，绝不弹出/关闭；失败也不强制 (只是再等，绝不误判未弹出而重复弹窗)。
function agentDescendantAlive(pidf) {
  try {
    const pid = readPidFile(pidf);
    if (!pid) return false;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      "$ErrorActionPreference='SilentlyContinue'; $a=@{}; $p=Get-CimInstance Win32_Process; foreach($pr in $p){ if($pr.ParentProcessId -eq 0){continue}; $a[$pr.ProcessId]=$pr.ParentProcessId }; $root=" + Number(pid) + "; $s=@($root); $i=0; while($i -lt $s.Count){ $cur=$s[$i]; $i++; foreach($pr in $p){ if($pr.ParentProcessId -eq $cur){ if(($pr.Name -match 'codex|node') -or ($pr.CommandLine -like '*codex*')){ Write-Output 1; exit 0 }; $s+=$pr.ProcessId } } }; Write-Output 0"],
      { windowsHide: true, encoding: "utf8", timeout: 8000 });
    return /^1/m.test(String(r.stdout || ""));
  } catch { return false; }
}
async function warmupWindow(pidf, token) {
  // 通用冷启动错峰：已确认 launcher 存活后，再短等 agent 子进程出现（避免父进程过早去等 session rollout 而漏匹配）。
  // 不特判任何 agent 的子进程形态（对 codex/claude/gemini/opencode 等主流 agent 通用）；失败只继续等，绝不误判未弹出。
  const agentWarm = Date.now() + 15000;
  while (Date.now() < agentWarm) {
    if (agentDescendantAlive(pidf)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await new Promise((r) => setTimeout(r, 800));
}
async function spawnWindowWithRetry(lp, title, pidf, maxRetry = 3, token, reservedByRunner = false) {
  const auxiliaryId="aux-"+path.basename(lp); let coordinator,admitted=false,bound=false;
  try {
    if(!reservedByRunner){
      coordinator=coordinatorDir(WORKSPACE);
      const claim=reserve(coordinator,{id:auxiliaryId,keys:["aux:"+token]},computeMaxWindows(os.totalmem() / 1024 ** 2));
      if(!claim.ok)throw new Error("Window admission waiting: "+claim.reason);
      admitted=true;
    }
    // 恢复调用方传入的重试上限（默认 3）：同步拉起后每次尝试约 2.5s，重试成本可控，兜底 WT 偶发不弹窗。
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      // 同步拉起（no-activate helper 经 spawnSync 完成 CreateProcessW 再返回）：实测 async 路径窗口经常不弹。
      try {
        spawnVisibleWindow(lp, title);
      } catch (error) {
        console.log("  !! [window] launch error (attempt " + attempt + "/" + maxRetry + ") for [" + title + "]: " + error.message);
        continue;
      }
      const deadline = Date.now() + 35000;
      let ok = false;
      const t0 = Date.now();
      while (Date.now() < deadline) {
        // The launcher writes its pid file as its first action, but Windows Terminal
        // can delay process startup. Discover the still-running launcher by its
        // unique script path before retrying; otherwise a late first attempt and a
        // retry can open two panes while sharing one pid/result file.
        if (windowGenuinelyPopped(pidf, token, lp)) { ok = true; break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (ok) {
        // 加固②：弹窗确认后再等 agent 子进程真正拉起（冷启动），确保父进程随后去等 session rollout 时不会起跑太早。
        await warmupWindow(pidf, token);
        if(!reservedByRunner){bind(coordinator,auxiliaryId,launcherIdentity(readPidFile(pidf),pidf));bound=true;}
        if (attempt > 1 || Date.now() - t0 > 6500) console.log("  [window] popup CONFIRMED (pidf+launcher+" + AGENT.agent + " child) for [" + title + "]");
        return true;
      }
      console.log("  [window] popup NOT confirmed (attempt " + attempt + "/" + maxRetry + ") for [" + title + "]");
    }
    console.log("  !! [window] popup FAILED after " + maxRetry + " attempts for [" + title + "]");
    return false;
  } finally {
    // A failed admission/popup/bind must release its coordinator lease. A
    // successful auxiliary window remains leased until its caller closes it.
    if(admitted&&!bound){
      try{release(coordinator,auxiliaryId);}
      catch(error){console.warn("[orchestrator] auxiliary lease cleanup failed: "+error.message);}
    }
  }
}
function releaseAuxiliaryWindow(lp) {
  try { release(coordinatorDir(WORKSPACE), "aux-" + path.basename(lp)); }
  catch(error) { console.warn("[orchestrator] auxiliary lease cleanup failed: "+error.message); }
}
// Interactive-TUI launcher. The interactive `codex "prompt"` window does not exit on its own; a
// background watchdog in the launcher scans THIS window session rollout: as soon as the LAST assistant
// message containing this block token + 完成 appears, it writes the strong `.self-closed` marker and
// kills the full codex descendant tree (hit-to-close, no stability wait), so the launcher runs `exit 0` and the
// pane auto-closes. `Write-Result` then uses `Get-LastReport` to persist the window last assistant output
// into `win-<s>.result.json`, accepting a tokenless report only when it belongs to the token-bearing turn.
// The launcher ALWAYS reaches `exit 0` (a non-zero exit is the "process exited, code X" stuck-pane bug).
// Encoding + Windows Terminal hosting set here (see ORCH_TUI and the chcp 65001 + InputEncoding UTF-8) for CJK/IME.

// Shared PowerShell descendant-kill routine used by BOTH the launcher watchdog and closeWindowByPid:
// snapshot Win32_Process once, then walk the ParentProcessId chain starting at the launcher ($root) to
// collect EVERY descendant, and kill each PID individually. Each victim is also passed to taskkill
// with /T so a child that appears between snapshots is reaped atomically with its parent; the
// launcher itself is never in the walk's kill set; $PID (the watchdog's own job
// process) is always excluded; when the list is empty (codex already exited on its own) nothing is
// killed, which preserves the "never force-kill launcher / skip if codex exited" safety boundaries.
function psKillDescendantsLines() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$known=@{}; $cutoff=@{}; $total=0",
    "for($pass=0;$pass -lt 3;$pass++) {",
    "$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "if(-not $known.ContainsKey($root)){$known[$root]=$all|Where-Object ProcessId -eq $root}",
    "$victims = New-Object 'System.Collections.Generic.List[int]'",
    "$queue = New-Object 'System.Collections.Generic.Queue[int]'",
    "$seen = @{}",
    "$seen[$root] = $true",
    "foreach($k in @($known.Keys)){$queue.Enqueue([int]$k)}",
    "while ($queue.Count -gt 0) {",
    "  $cur = $queue.Dequeue()",
    "  foreach ($pr in $all) {",
    "    if ($pr.ProcessId -ne $PID -and $pr.ParentProcessId -eq $cur -and -not $seen.ContainsKey($pr.ProcessId) -and $known[$cur] -and $pr.CreationDate -ge $known[$cur].CreationDate -and (-not $cutoff.ContainsKey($cur) -or $pr.CreationDate.ToUniversalTime() -le $cutoff[$cur])) {",
    "      $seen[$pr.ProcessId] = $true",
    "      $known[[int]$pr.ProcessId]=$pr",
    "      $victims.Add($pr.ProcessId)",
    "      $queue.Enqueue($pr.ProcessId)",
    "    }",
    "  }",
    "}",
    "$victims.Reverse()",
    "foreach ($v in $victims) { $before=$all | Where-Object ProcessId -eq $v; $now=Get-CimInstance Win32_Process -Filter ('ProcessId='+$v); if($now -and $now.CreationDate -eq $before.CreationDate -and $now.CommandLine -eq $before.CommandLine -and $now.Name -eq $before.Name){$cutoff[[int]$v]=[DateTime]::UtcNow;taskkill /PID $v /F /T 2>$null | Out-Null; try { Wait-Process -Id $v -Timeout 3 -ErrorAction SilentlyContinue } catch { } } }",
    "$total += $victims.Count",
    "}",
    "Write-Output $total",
  ];
}

// computeMaxWindows 已下沉至 contracts.mjs（fresh 规划与 resume 校验共用），此处经 import 复用。

// Capacity is a planning constraint, not a queue of extra windows.
export function capPlanBlocks(input, capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
  const plan = structuredClone(input);
  levelWaves(plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn||[]})));
  if (plan.length <= capacity) return plan;
  const aliases = new Map();
  plan.forEach((b, i) => { aliases.set(`B${i + 1}`, i); aliases.set(titleOf(`B${i + 1}`, b.title), i); aliases.set(b.title, i); });
  const deps = plan.map((b, i) => new Set((b.dependsOn || []).map(d => aliases.get(String(d))).filter(d => d !== undefined && d !== i)));
  const order = [], done = new Set();
  while (order.length < plan.length) {
    const next = plan.findIndex((_, i) => !done.has(i) && [...deps[i]].every(d => done.has(d)));
    if (next < 0) throw new Error('Cannot compact cyclic block dependencies; no tasks were executed');
    order.push(next); done.add(next);
  }
  // Consecutive topological ranges prevent merge-induced dependency cycles.
  const groups = Array.from({ length: capacity }, (_, i) => order.slice(
    Math.floor(i * order.length / capacity), Math.floor((i + 1) * order.length / capacity)));
  const owner = new Map();
  groups.forEach((g, i) => g.forEach(index => owner.set(index, i)));
  return groups.map((g, i) => ({
    type: g.length > 1 || g.some(index => plan[index].type === 'linked') ? 'linked' : 'independent',
    title: `capacity-${i + 1}`,
    tasks: g.flatMap(index => plan[index].tasks || []),
    conflictKeys: [...new Set(g.flatMap(index => blockKeys(plan[index])))],
    dependsOn: [...new Set(g.flatMap(index => [...deps[index]].map(d => owner.get(d))))]
      .filter(group => group !== i).map(group => `capacity-${group + 1}`),
  }));
}
// Shared by the real window scheduler and its capacity boundary tests.
export function buildWindowWaves(recs, maxByMem) {
  if (!Number.isInteger(maxByMem) || maxByMem < 1) {
    throw new RangeError('maxByMem must be a positive integer');
  }
  if (recs.length > maxByMem) throw new RangeError('plan exceeds window capacity; compact before scheduling');
  return levelWaves(recs);
}
// ---------------------------------------------------------------------------
// 窗内 auth 提示词的确定性策略改写（纯函数，可单测）：
//   TUI 渲染重叠修复：把「三遍检查」提示词里的 ①②③ 改成 1) 2) 3)（纯 ASCII 宽度），避免 Windows Terminal CJK 宽度歧义导致序号与文字重叠。
//   说明：窗内不再使用子代理（用户明确：orchestrator 发起的 TUI 窗不再使用子代理），故不再替换子代理相关子句。
export function applyAuthPromptPolicy(auth) {
  let s = String(auth || "");
  s = s.replace(
    "随后按此顺序自查：①先检查一遍这个 TODO LIST 是否完整/是否有遗漏或错误，发现问题就修复；②再检查一遍这个 TODO LIST 的**逻辑问题**（先后依赖、因果、边界、是否会冲突/漏步），发现问题就修复；③最后再检查一遍这个 TODO LIST 的问题（复查，确保①②都改彻底）。",
    "随后按此顺序自查：1) 先检查一遍这个 TODO LIST 是否完整/是否有遗漏或错误，发现问题就修复；2) 再检查一遍这个 TODO LIST 的**逻辑问题**（先后依赖、因果、边界、是否会冲突/漏步），发现问题就修复；3) 最后再检查一遍这个 TODO LIST 的问题（复查，确保 1) 2) 都改彻底）。"
  );
  return s;
}

// 硬性要求（用户明确，必须遵守）：对 orchestrator 自身的改动，必须先于并独立于所有 TUI 窗执行——
// 先 inline 就地把 orchestrator 改完，再据此发起并发 TUI 窗。原因：TUI 窗依赖 orchestrator SDK；
// 若把“改 SDK”交给一个 TUI 窗去做，该窗的 watchdog/关窗也依赖被改的 SDK，会出现“改它的窗自己关不掉”。
// 故 --run-windows 检测到这类请求一律返回 inline（由发起对话就地改完再另发窗）。
function isOrchestratorSelfMod(text) {
  const t = String(text || "");
  // 通用化（不假设特定 agent/语言）：识别「改/修/升级 编排器自身 源码/脚本/进程/skill」这类自引用意图。
  // 覆盖英文 + 中文关键词，并对编排器自身的通用称谓（orchestrator/编排/调度/TUI 窗/skill）都命中；
  // 命中只是「可能改自己」的信号，进一步由调用方决定是否返回 inline（宁可多识、不误把改自己的活交给窗）。
  const selfRef =
    /open-tui-orchestrator|orchestrator|orchestrate|编排|调度器|调度窗|TUI 窗|TUI窗|并发编排/i.test(t) ||
    /scripts\/?orchestrate|orchestrate-sdk\.mjs|\.codex.*\/?orchestrat/i.test(t);
  if (!selfRef) return false;
  const modifyIntent =
    /(修复|修改|改|升级|加固|优化|调整|重构|补|加固|收紧|fix|edit|update|build|harden|refactor|improve|rework)/i.test(t);
  return modifyIntent;
}

// Shared by the launcher and its isolated watchdog job. Parse message envelopes rather
// than searching raw JSON, which may contain copied events inside parent tool output.
function psRolloutReaderLines() {
  return String.raw`function Get-EventTurnId($ev) {
  if ($ev.turn_id) { return [string]$ev.turn_id }
  if ($ev.payload.turn_id) { return [string]$ev.payload.turn_id }
  if ($ev.payload.internal_chat_message_metadata_passthrough.turn_id) { return [string]$ev.payload.internal_chat_message_metadata_passthrough.turn_id }
  if ($ev.internal_chat_message_metadata_passthrough.turn_id) { return [string]$ev.internal_chat_message_metadata_passthrough.turn_id }
  return ''
}
function Test-MessageToken([string]$msg, [string]$tok) {
  return ($tok -and $msg -cmatch ('(?<![A-Za-z0-9_-])' + [regex]::Escape($tok) + '(?![A-Za-z0-9_-])'))
}
function Read-OwnedRollout([string]$raw, [string]$tok, [string]$ownerTurnId = '') {
  $owner = $ownerTurnId; $bound = [bool]$owner; $current = ''; $report = ''; $done = $false
  foreach ($line in ($raw -split "\r?\n")) {
    try { $ev = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    $p = $ev.payload; $turn = Get-EventTurnId $ev
    if ($ev.type -eq 'turn_context' -or $ev.type -eq 'task_started' -or ($ev.type -eq 'event_msg' -and $p.type -eq 'task_started')) { $current = $turn }
    $role = ''; $msg = ''; $isFinal = $false
    if ($ev.type -eq 'response_item' -and $p.type -eq 'message') {
      $role = [string]$p.role
      $msg = (($p.content | ForEach-Object { if ($_.text -is [string]) { $_.text } elseif ($_.content -is [string]) { $_.content } elseif ($_.value -is [string]) { $_.value } }) -join '')
      $isFinal = ($p.phase -eq 'final_answer')
    } elseif ($ev.type -eq 'event_msg' -or $ev.t -eq 'event_msg') {
      if ($p.type -eq 'user_message') { $role = 'user'; $msg = [string]$p.message }
      if ($p.type -eq 'agent_message') { $role = 'assistant'; $msg = [string]$p.message; $isFinal = $true }
    }
    if (-not $bound -and $role -eq 'user' -and (Test-MessageToken $msg $tok)) {
      $bound = $true; $owner = if ($turn) { $turn } else { $current }
    }
    if (-not $bound) { continue }
    $own = if ($owner) { $turn -eq $owner -or (-not $turn -and $current -eq $owner) } else { Test-MessageToken $msg $tok }
    if ($role -eq 'assistant' -and $own -and $msg.Trim()) {
      $report = $msg
      # Only a standalone completion marker closes this window. A final
      # assistant message may quote the token/word "完成" while still
      # explaining unfinished work; substring matching caused false closes.
      if ($isFinal -and (Test-MessageToken $msg $tok) -and ($msg -match ('(?m)^\s*__ORCH_DONE__\s+' + [regex]::Escape($tok) + '(?:\s+\S+)?\s*$'))) { $done = $true }
    }
    $isTaskComplete = $ev.type -eq 'task_complete' -or ($ev.type -eq 'event_msg' -and $p.type -eq 'task_complete')
    # 一旦本 rollout 被本窗 token 绑定（$bound），task_complete 就足以收窗：
    # 自检窗只要求模型回两行，模型偶尔漏写结束标记；此时旧的 turn 精确匹配会兜不住，
    # 面板只能等主控 20 秒兜底关窗（实测 20992ms，严格判据判失败）。
    # 放宽为“已绑定 + task_complete（turn 为空或等于本窗 turn）”，宁可早关也不挂死；
    # 任务是否真的完成仍由主控按检查点/回执独立验收，关窗本身不构成成功证据。
    if ($isTaskComplete -and $bound -and (-not $turn -or -not $owner -or $turn -eq $owner)) { $done = $true }
    elseif ($isTaskComplete -and (($owner -and $turn -eq $owner) -or (-not $owner -and (Test-MessageToken ([string]$p.last_agent_message) $tok)))) { $done = $true }
  }
  return @{ matched = $bound; turnId = $owner; report = $report; done = $done }
}`.split('\n');
}

function writeInteractiveLauncher(title, prompt, sfx, metadata={}) {
  if(AGENT.agent==='pi')return writePiLauncher(AGENT.config,{key:title,prompt,suffix:sfx,workspace:WORKSPACE,temp:TMP});
  // Runner metadata is authoritative. Legacy direct callers append their own
  // marker after task text, so its last occurrence is the compatibility fallback.
  const token=metadata.token??[...String(prompt||'').matchAll(/【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_\-]*)/g)].at(-1)?.[1]??'';
  if(typeof token!=='string'||(token&&!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(token)))throw new Error('Invalid launcher ownership token');
  const s = safe(title) + (sfx ? "-" + sfx : "");
  mkdirSync(TMP, { recursive: true });
  const pf = path.join(TMP, `agent-win-${s}.md`);
  const lp = path.join(TMP, `win-launch-${s}.ps1`);
  const pidf = path.join(TMP, `window-${s}.pid`);
  const rf = path.join(TMP, `win-${s}.result.json`);
  // 加固：生成新窗启动脚本时清掉本块路径上可能残留的旧 result / .self-closed 标记，避免窗内 watchdog 把
  // “旧块已完成的残留标记”误当成“本窗 agent 已退出”，从而提前 exit 0 不再杀 codex，造成“窗口任务完成但
  // agent 仍存活、窗未自动关”的常驻窗。仅删本块自己的 result 产物，绝不触碰其它窗/活窗。
  try { if (existsSync(rf)) rmSync(rf, { force: true }); } catch { /* ignore */ }
  try { if (existsSync(rf + ".self-closed")) rmSync(rf + ".self-closed", { force: true }); } catch { /* ignore */ }
  writeFileSync(pf, prompt, "utf8");
  // Unique ASCII token embedded in every block prompt ("【本块唯一标识】<token>"): the watchdog uses it
  // to find THIS window's own session rollout (same token the orchestrator matches, ASCII-only so the
  // PowerShell match never has to deal with JSON-escaped CJK).
  // Only capture the REAL ASCII token (alnum/_/-) right after the marker. The block prompt/report
  // contract also contains boilerplate text like 「【本块唯一标识】…完成」开头 BEFORE the injected
  // unique token; the old pattern ([^\s\r\n】]+) matched that boilerplate first, stripped it to an
  // empty $token, which silently disabled the launcher's self-close watchdog (thence the stuck
  // "[进程已退出，代码为 1]" pane). Requiring an ASCII-leading token skips the CJK boilerplate and
  // lands on the true block token.
  const BOM = "\uFEFF";
  // PowerShell 单引号字符串内嵌路径/变量：把 ' 转义成 ''，避免路径含引号时破坏脚本/注入。
  const pidfQ = String(pidf || "").replace(/'/g, "''");
  const pfQ = String(pf || "").replace(/'/g, "''");
  const rfQ = String(rf || "").replace(/'/g, "''");
  const PY_Q = String(PY || "").replace(/'/g, "''");
  const body = [
    "$ErrorActionPreference = 'Continue'",
    // 根治：最外层 trap 兜底——任何未捕获的 terminating error 都恒 exit 0，绝不让 launcher 以非 0 退出，
    // 否则 Windows Terminal 会留下「[已退出进程，代码为 1]」且不自动关的卡壳窗。
    "trap { exit 0 }",
    `$PID | Set-Content -Path '${pidfQ}' -Encoding UTF8`,
    "$env:TERM = 'xterm-256color'",
    "$env:Path = '" + PY_Q + ";' + $env:Path",
    "$env:ORCH_WINDOW = '1'",
    "if ($env:ORCH_SDIR) { $env:ORCH_SDIR = $env:ORCH_SDIR } elseif ($env:ORCH_SESSION_DIR) { $env:ORCH_SDIR = $env:ORCH_SESSION_DIR } elseif ($env:CODEX_HOME) { $env:ORCH_SDIR = Join-Path $env:CODEX_HOME 'sessions' } else { $env:ORCH_SDIR = Join-Path $env:USERPROFILE '.codex\\sessions' }",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    // Align BOTH console code pages to UTF-8: on a Chinese-locale Windows the default INPUT code page
    // is 936 (GBK); Codex expects UTF-8 and the Microsoft Pinyin/TSF IME composes against the console
    // code page. chcp 65001 + InputEncoding UTF-8 keep IME composition UTF-8 (best-effort for CJK).
    "if(-not $env:PATHEXT){$env:PATHEXT='.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'}",
    "try { chcp 65001 | Out-Null } catch { }",
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "Write-Host '============================================='",
    "Write-Host '  TASK RUNNING - closes automatically on completion'",
    "Write-Host '============================================='",
    "$resultFile = '" + rfQ + "'",
    // 加固：结果/完成标记写入前先确保父目录存在。避免“launcher 产物目录在运行中被删除/被插件升级重装清掉”
    // 后，Set-Content 因父目录不存在而抛 DirectoryNotFoundException，导致窗以 exit 1 退出且不自动关（常见根因）。
    "function Ensure-ResultDir {",
    "  try { $d = Split-Path -Parent $resultFile; if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } } catch { }",
    "}",
    ...psRolloutReaderLines(),
    "$rolloutNotBefore = [datetime]::UtcNow.AddSeconds(-2)",
    "function Get-LastReport {",
    "  param([string]$dir,[string]$tok)",
    "  $files = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.CreationTimeUtc -ge $rolloutNotBefore } | Sort-Object CreationTimeUtc -Descending",
    "  foreach ($f in $files) {",
    "    $raw = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue",
    "    $owned = Read-OwnedRollout $raw $tok",
    "    if ($owned.matched -and $owned.report) { return [string]$owned.report }",
    "  }",
    "  return ''",
    "}",
    "function Write-Result {",
    "  param([int]$code)",
    "  try {",
    "    # 执行结束判定（用户方案：done=做完了，不等同于成功）：agent 已退出即视为本窗执行结束，写 result + .self-closed 完成标记。",
    "    # 是否真的达成 prompt 预期，由主控关窗后去核对真实落盘状态；这里不因其未输出长篇汇报就判定未完成。",
    "    $dir = $env:ORCH_SDIR",
    "    $report = Get-LastReport -dir $dir -tok $token",
    "    $line = '__EXIT__=' + $code",
    "    $json = '{\"__EXIT__\":' + $code + ',\"__DONE__\":true,\"__LAUNCHER_PID__\":' + $PID + ',\"__TOKEN__\":' + (ConvertTo-Json $token -Compress) + ',\"__REPORT__\":' + (ConvertTo-Json $report -Compress) + ',\"ts\":\"' + (Get-Date -Format o) + '\"}'",
    "    Ensure-ResultDir",
    "    Set-Content -LiteralPath $resultFile -Value ($json + \"`r`n\" + $line) -Encoding UTF8",
    "    Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { /* ignore */ }",
    "  } catch { }",
    "}",
    "$p = (Get-Content -Raw -Encoding UTF8 '" + pfQ + "').Trim()",
    "if ([string]::IsNullOrWhiteSpace($p)) { Write-Result 2; exit 0 }",
    "$token = '" + token + "'",
    // Self-close watchdog (background job): when this window's own rollout reaches task_complete, kill
    // the launcher's FULL codex descendant tree (recursive along ParentProcessId, each PID killed
    // individually) so `& codex` returns and the launcher runs exit 0 -> the Windows Terminal pane
    // auto-closes ~1s after completion. Also exits when the result marker exists (codex already exited
    // on its own), and the recursive kill skips when no descendants remain. Never touches the launcher,
    // the watchdog job itself, or other windows.
    "$watch = Start-Job -ScriptBlock {",
    "  param($token, $rootPid, $resultFile, $rolloutNotBefore)",
    "  if ([string]::IsNullOrWhiteSpace($token)) { return }",
    "  # 独立 runspace：本 job 看不到主作用域的 Ensure-ResultDir，需在此自行复刻（与主作用域实现一致）。",
    "  function Ensure-ResultDir {",
    "    try { $d = Split-Path -Parent $resultFile; if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } } catch { }",
    "  }",
    ...psRolloutReaderLines().map(ln => "  " + ln),
    "  function Stop-LauncherDescendants {",
    "    param([int]$root)",
    ...psKillDescendantsLines().map((ln) => "    " + ln),
    "  }",
    "  # 加固：连续重扫并递归杀净，直到 launcher 不再有任何后代（codex 若在快照后重新生成子进程也一并回收），",
    "  # 绝不因为一次快照遗漏子进程就放过 codex，造成“窗口任务已完成但 codex TUI 仍存活、窗未自动关”。",
    "  function Kill-LauncherTree {",
    "    param([int]$root)",
    "    for ($k = 0; $k -lt 10; $k++) {",
    "      $n = Stop-LauncherDescendants $root",
    "      if ($n -eq 0) { break }",
    "      Start-Sleep -Milliseconds 300",
    "    }",
    "  }",
    "  $dir = $env:ORCH_SDIR",
    "  $seen = @{}",
  "  $sizes = @{}",
  "  $match = $null",
  "  $sawChild = $false",
  "  $ownerTurnId = ''",
    "  $watchdogMaxMin = 45",
    "  try { if ($env:ORCH_WATCHDOG_MAX_MIN) { $watchdogMaxMin = [double]$env:ORCH_WATCHDOG_MAX_MIN } } catch { }",
    "  $deadline = (Get-Date).AddMinutes($watchdogMaxMin)",
    "  while ((Get-Date) -lt $deadline) {",
    "    $resultOwned = $false",
    "    try { $saved = (Get-Content -LiteralPath $resultFile -Encoding UTF8 -TotalCount 1 -ErrorAction Stop) | ConvertFrom-Json -ErrorAction Stop; $resultOwned = $saved.__TOKEN__ -ceq $token -and $saved.__DONE__ -eq $true -and $saved.__LAUNCHER_PID__ -eq $rootPid } catch { }",
    "    if ($resultOwned) {",
    "      $n = Stop-LauncherDescendants $rootPid",
    "      if ($n -gt 0) { $sawChild = $true }",
    "      # 加固：陈旧/旧块 result 文件可能在 codex 尚未生成后代时误触发提前退出；故仅当确曾观测到本窗 codex",
    "      # 后代（$sawChild）且现已杀净时才结束，并补写 .self-closed 完成标记，避免“任务完成但窗未自动关”。",
    "      if ($n -eq 0 -and $sawChild) { Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { }; exit 0 }",
    "    }",
    "    try {",
    "      $files = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.CreationTimeUtc -ge $rolloutNotBefore } | Sort-Object CreationTimeUtc -Descending",
    "      foreach ($f in $files) {",
    "        if ($match) {",
    "          if ($f.FullName -ne $match) { continue }",
    "          try {",
    "            $raw = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue",
    "            $owned = Read-OwnedRollout $raw $token $ownerTurnId",
    "            if ($owned.done) {",
    "              Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { }",
    "              Kill-LauncherTree $rootPid",
    "              exit 0",
    "            }",
    "          } catch { }",
    "          continue",
    "        }",
    "        $cur = 0",
    "        try { $cur = $f.Length } catch { $cur = 0 }",
    "        if ($seen.ContainsKey($f.FullName) -and $sizes[$f.FullName] -eq $cur) { continue }",
    "        $seen[$f.FullName] = $true",
    "        $sizes[$f.FullName] = $cur",
    "        try {",
    "          $raw = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue",
    "          $owned = Read-OwnedRollout $raw $token",
    "          if ($owned.matched) {",
    "            $match = $f.FullName",
    "            $ownerTurnId = $owned.turnId",
    "            break",
    "          }",
    "        } catch { }",
    "      }",
    "    } catch { }",
    "    Start-Sleep -Milliseconds 500",
    "  }",
    "  # 兜底（明显问题：卡死/无进展/异常未正常汇报）：watchdog 到达 deadline 仍未见 __ORCH_DONE__/task_complete，",
    "  # 视为异常窗口——写完成标记 + 杀净 agent 后代，让 `& codex` 返回、launcher 恒 exit 0 干净关窗；",
    "  # 是否真达成 prompt 预期由主控关窗后按盘面复核（此处只保证不挂死、不残留 code-1/常驻窗）。",
    "  Ensure-ResultDir",
    "  try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { }",
    "  Kill-LauncherTree $rootPid",
    "  exit 0",
    "} -ArgumentList $token, $PID, $resultFile, $rolloutNotBefore",
    "$code = 1",
    "try {",
    "  $agentArgs = " + buildPsArrayLit(AGENT_ARGS_LIST) + " + $p",
    "  # Only the controller may recover checked remaining tasks; never replay the whole prompt here.",
    "  $attempt = 0",
    "  $rep = ''",
    "  $wdDone = $false",
    ...nativeArgumentLines(),
    "  while ($attempt -lt 1) {",
    "    $attempt++",
    "    & '" + AGENT_BIN_Q + "' @agentArgs",
    "    $code = $LASTEXITCODE",
    "    $rdir = $env:ORCH_SDIR",
    "    $rep = Get-LastReport -dir $rdir -tok $token",
    "    if ($rep) { break }",
    "    # 加固：watchdog 刚杀完 codex，rollout 汇报 / .self-closed 标记可能仍在落盘/跨进程可见性传播中，",
    "    # 先短等再复检，避免把“已完成、正在关窗”的窗口误判成失败，重跑出一个失去 watchdog 背书的常驻 codex。",
    "    Start-Sleep -Milliseconds 400",
    "    $rep = Get-LastReport -dir $rdir -tok $token",
    "    if ($rep) { break }",
    "    # 加固：watchdog 已自关（已写入 .self-closed 完成标记）就意味着完成汇报已被确认，此时绝不再重跑，",
    "    # 避免 agent 重新生成一个失去 watchdog 背书的常驻 TUI（正是“窗口任务完成但 agent 仍存活、窗未自动关”的根因）。",
    "    if (Test-Path -LiteralPath ($resultFile + '.self-closed')) { $wdDone = $true; break }",
    "    if ($code -eq 0) { break }",
    "    Write-Host ('  [launcher] codex session exited (code=' + $code + '); controller will reconcile task checkpoints')",
    "  }",
    "} catch {",
    "  $code = 1",
    "}",
    // 任务完成判定：只要本窗最终汇报已捕获（$rep 非空），watchdog 会为快速关窗而强杀 agent 子进程使
    // $LASTEXITCODE=1，但那不等于失败。此时统一按完成处理并以 exit 0 干净关闭（Windows Terminal
    // closeOnExit:graceful 只认 exit 0；非零会留下“[进程已退出，代码为 1]”的卡壳窗），结果文件也记录 0。
    // 拿到最终汇报（$rep）或 watchdog 已确认完成（$wdDone）都归零，确保窗必关、绝不留常驻 codex。
    "if ($rep -or $wdDone) { $code = 0 }",

    "if ($rep -or $wdDone) { Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { /* ignore */ } }",
    "if($rep -or $wdDone){$null=Wait-Job -Job $watch -Timeout 8}",
    "try { Stop-Job -Job $watch -ErrorAction SilentlyContinue; Remove-Job -Job $watch -Force -ErrorAction SilentlyContinue } catch { }",
    "Write-Result $code",
    // Always exit 0: Windows Terminal auto-closes the pane on exit code 0 (closeOnExit:graceful).
    // A non-zero exit keeps the pane open ("process exited, code X") which is the stuck-window bug.
    "exit 0",
  ].join("\r\n");
  writeFileSync(lp, BOM + body, "utf8");
  return { lp, pidf, pf, rf };
}
// ---- session-rollout discovery + task_complete detection (for interactive auto-close) ----
function sessionDir() {
  // 默认 codex 会话目录；ORCH_SESSION_DIR 可指向其它 agent 的会话目录（agent 通用化）。
  // 通用化：优先 CODEX_HOME（可被环境变量覆盖），而非硬编码 USERPROFILE\.codex。
  return process.env.ORCH_SESSION_DIR || path.join(CODEX_HOME, "sessions");
}
function listRollouts(dir, notBeforeMs = 0) {
  const res = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) res.push(...listRollouts(p, notBeforeMs));
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        if (!notBeforeMs || statSync(p).birthtimeMs >= notBeforeMs) res.push(p);
      }
    }
  } catch { /* ignore */ }
  return res;
}
// Find the session rollout belonging to a block by matching a distinctive slice of its prompt text.
// The match token is globally unique per block (it contains a batch id + random suffix), so we do NOT
// need a "before" snapshot filter — matching the unique token is enough and avoids the old fragility.
// `exitMarkerFile` (the launcher's `win-<s>.result.json`) aborts the wait as soon as codex has exited
// on its own (crash / non-zero exit): the caller then reclaims the session immediately instead of
// polling for a rollout that may never appear ("codex 进程先退出" -> no launcher hang).
function tokenInMessage(text, token) {
  const key = resultTokenValue(token);
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?<![A-Za-z0-9_-])" + escaped + "(?![A-Za-z0-9_-])").test(String(text || ""));
}
function rolloutTurnId(ev) {
  return String(ev?.turn_id ?? ev?.payload?.turn_id ?? ev?.payload?.internal_chat_message_metadata_passthrough?.turn_id ?? ev?.internal_chat_message_metadata_passthrough?.turn_id ?? "");
}
function rolloutMessage(ev, role) {
  const p = ev?.payload;
  if (ev?.type === "response_item" && p?.type === "message" && p.role === role && Array.isArray(p.content))
    return p.content.map(c => typeof c.text === "string" ? c.text : "").join("");
  if ((ev?.type === "event_msg" || ev?.t === "event_msg") && p?.type === (role === "user" ? "user_message" : "agent_message")) return String(p.message || "");
  return "";
}
function rolloutEvents(text) {
  return String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).flatMap(line => {
    try { const ev = JSON.parse(line); return ev && typeof ev === "object" ? [ev] : []; } catch { return []; }
  });
}
// Only a structured user task can own a rollout. Tool output in the parent conversation
// routinely contains the same token, paths and copied child events.
function findOwnedTurn(text, token) {
  let current = "";
  for (const ev of rolloutEvents(text)) {
    const turn = rolloutTurnId(ev);
    if (ev.type === "turn_context" || ev.type === "task_started" || (ev.type === "event_msg" && ev.payload?.type === "task_started")) current = turn;
    if (tokenInMessage(rolloutMessage(ev, "user"), token)) return { matched: true, turnId: turn || current };
  }
  return { matched: false, turnId: "" };
}
// Parse a rollout tail and accept only a structured task_complete event belonging to this block.
// The token normally appears in the user prompt while the terminal event carries the turn_id, so
// retain the owner turn across polling iterations and reject text mentions or foreign turns.
function scanTaskComplete(text, matchToken = "", ownerTurnId = "") {
  const found = matchToken ? findOwnedTurn(text, matchToken) : { matched: true, turnId: "" };
  const owner = String(ownerTurnId || found.turnId);
  for (const ev of rolloutEvents(text)) {
    const turnId = rolloutTurnId(ev);
    const typedComplete = ev.type === "task_complete" || (ev.type === "event_msg" && ev.payload?.type === "task_complete");
    const own = owner ? turnId === owner : found.matched && tokenInMessage(ev.payload?.last_agent_message, matchToken);
    if (typedComplete && (!matchToken || own)) return { done: true, ownerTurnId: owner };
  }
  return { done: false, ownerTurnId: owner };
}
async function waitForSessionFile(matchKey, timeoutMs, exitMarkerFile) {
  const start = Date.now();
  const seen = new Set();
  let lastReset = Date.now();
  // The rollout is JSONL: backslashes (Windows paths) are doubled (`\` -> `\\`) and quotes escaped,
  // so we must match against the JSON-escaped form, not the raw text. The task prompt sits after the
  // (large) AGENTS.md/context block, so we read the whole file (once per new candidate), not just the head.
  const notBeforeMs = start - 5000;
  while (Date.now() - start < timeoutMs) {
    // 完成信号优先认窗内自关：result 落盘或窗内 watchdog 写入 .self-closed（即 agent 已报 __ORCH_DONE__）都视为本窗完成，
    // 立即转入回收路径，避免父进程靠 session 文本匹配去等一个可能永远匹配不到的会话（慢速 agent 时长期 HOLDING）。
    if (exitMarkerFile && (existsSync(exitMarkerFile) || existsSync(exitMarkerFile + ".self-closed"))) {
      // The launcher may have exited just after writing the final provider
      // event. Do one last ownership scan before taking the reclaim path so
      // typed quota/capacity diagnostics survive a fast self-close.
      for (const f of listRollouts(sessionDir(), notBeforeMs)) {
        try { if (findOwnedTurn(readFileSync(f, "utf8"), matchKey).matched) return f; } catch { /* ignore */ }
      }
      return null;
    }
    for (const f of listRollouts(sessionDir(), notBeforeMs)) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        if (findOwnedTurn(readFileSync(f, "utf8"), matchKey).matched) return f;
      } catch { /* ignore */ }
    }
    if (Date.now() - lastReset > 15000) { seen.clear(); lastReset = Date.now(); } // 周期重扫：防 rollout 先建后写 token 被永久错过
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
// Poll a rollout for the `task_complete` event (the reliable "turn done" marker), then extract the
// agent's final message. Returns { done, text, exitCode }. Also treats the launcher's exit marker as a
// completion signal (codex exited, whatever the code): a non-zero exit WITH task_complete is a done
// turn, and a launcher exit WITHOUT task_complete is still a reclaimable (already-closing) window.
async function waitTaskComplete(file, timeoutMs, exitMarkerFile, matchToken, pidf) {
  const start = Date.now();
  let ownerTurnId = "";
  try { ownerTurnId = findOwnedTurn(readFileSync(file, "utf8"), matchToken).turnId; } catch { /* unreadable rollout remains unverified */ }
  while (Date.now() - start < timeoutMs) {
    // 根治 run 卡死：窗（launcher 进程）已死 = 该块执行结束。用户方案=完成与否由主控关窗后按任务 prompt
    // 核对真实落盘（零报告原则），父进程绝不因"窗未写 result 汇报 / rollout 无 task_complete"而无限等待。
    if (pidf) {
      if (!existsSync(pidf)) {
        // pid 文件已被清理 = 窗生命周期已结束（正常关窗/被收尾清理），视为该块执行结束。
        const rep = exitMarkerFile ? await waitForCapturedReport(exitMarkerFile, matchToken, 1500) : "";
        if (rep) return annotateCapacityAfterClose({ done: true, verified: true, text: rep, exitCode: readExitCode(exitMarkerFile) }, file);
        return annotateCapacityAfterClose({ done: true, verified: false, text: "(window closed; no report captured)", exitCode: readExitCode(exitMarkerFile) }, file);
      }
      const lp = readPidFile(pidf);
      if (lp > 0 && !pidAliveCheck(lp)) {
        const rep = exitMarkerFile ? await waitForCapturedReport(exitMarkerFile, matchToken, 1500) : "";
        if (rep) return annotateCapacityAfterClose({ done: true, verified: true, text: rep, exitCode: readExitCode(exitMarkerFile) }, file);
        return annotateCapacityAfterClose({ done: true, verified: false, text: "(window closed; no report captured)", exitCode: readExitCode(exitMarkerFile) }, file);
      }
    }
    if (exitMarkerFile && existsSync(exitMarkerFile)) {
      const rep = await waitForCapturedReport(exitMarkerFile, matchToken, 15000);
      if (rep) return annotateCapacityAfterClose({ done: true, verified: true, text: rep, exitCode: readExitCode(exitMarkerFile) }, file);
      const code = readExitCode(exitMarkerFile);
      const base = matchToken ? { text: extractOwnResult(file, matchToken) } : extractResult(file);
      if (base.text) return annotateCapacityAfterClose({ done: true, verified: true, text: base.text, exitCode: code }, file);
      return annotateCapacityAfterClose({ done: true, verified: false, text: "(launcher exited code " + (code === null ? "?" : code) + " before task_complete captured)", exitCode: code }, file);
    }
    if (exitMarkerFile && existsSync(exitMarkerFile + ".self-closed")) {
      // watchdog 已写自关标记 = 窗收尾并关闭；即时视为执行结束（无汇报文本，主控按落盘核对）。
      const rep = await waitForCapturedReport(exitMarkerFile, matchToken, 15000);
      if (rep) return annotateCapacityAfterClose({ done: true, verified: true, text: rep, exitCode: readExitCode(exitMarkerFile) }, file);
      return annotateCapacityAfterClose({ done: true, verified: false, text: "(window self-closed; no report captured)", exitCode: readExitCode(exitMarkerFile) }, file);
    }
    let tail = "";
    try {
      const st = statSync(file);
      const fd = openSync(file, "r");
      const len = Math.min(65536, st.size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      closeSync(fd);
      tail = buf.toString("utf8");
    } catch { /* ignore */ }
    // Provider capacity errors are actionable before task_complete and may leave the
    // TUI open while showing its countdown. Surface them immediately so the runner
    // can close this empty attempt and honor the bounded retry policy.
    const capacityError=rolloutCapacityError(tail);
    if (capacityError) {
      return { done: true, verified: false, text: capacityError, retryable:'capacity',capacityError,exitCode: readExitCode(exitMarkerFile) };
    }
    const quotaError=rolloutQuotaError(tail);
    if (quotaError) {
      return { done: true, verified: false, text: quotaError, retryable:'quota',quotaError,exitCode: readExitCode(exitMarkerFile) };
    }
    const completion = scanTaskComplete(tail, matchToken, ownerTurnId);
    ownerTurnId = completion.ownerTurnId;
    if (completion.done) {
      // exit code non-zero but task_complete seen -> still a completed turn
      let text = matchToken ? extractOwnResult(file, matchToken) : extractResult(file).text;
      // task_complete can be observed just before the final assistant message is flushed.
      // Give the same rollout a short bounded window before declaring evidence verified.
      for (let i = 0; !text && i < 15; i++) {
        await new Promise((r) => setTimeout(r, 100));
        text = matchToken ? extractOwnResult(file, matchToken) : extractResult(file).text;
      }
      return annotateCapacityAfterClose({ done: true, verified: Boolean(text), text, exitCode: readExitCode(exitMarkerFile) }, file);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return annotateCapacityAfterClose({ done: false, verified: false, text: "" }, file);
}
function annotateCapacity(result, file) {
  const quota = file ? rolloutQuotaError(readTail(file, 65536)) : '';
  if (quota) return { ...result, retryable: "quota", quotaError: quota.slice(-4000) };
  const evidence = file ? rolloutCapacityError(readTail(file, 65536)) : '';
  if (!evidence) return result;
  return { ...result, retryable: "capacity", capacityError: evidence.slice(-4000) };
}
// A launcher can write its self-close marker a few milliseconds before the
// provider flushes the terminal `task_complete.error` event. Re-scan briefly
// after the close so the final result keeps typed quota/capacity diagnostics
// without reopening a window or waiting for an unbounded session poll.
async function annotateCapacityAfterClose(result, file, timeoutMs = 2000) {
  let current = annotateCapacity(result, file);
  if (!file || current.retryable) return current;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = annotateCapacity(current, file);
    if (current.retryable) break;
  }
  return current;
}
// 只读文件尾部窗口(UTF-8, 最多 maxBytes 字节), 用于从超大 rollout 提取末尾的完成汇报。
// 完成标记/最终消息总在文件末尾, 全量 readFileSync 读 160MB+ rollout 是纯浪费。
// 返回 null 表示文件不可读(与"读到空串"区分)。这是纯函数、无语义改变、O(1) 内存。
export function readTail(file, maxBytes = 262144) {
  let s = "";
  try {
    const st = statSync(file);
    const len = Math.min(maxBytes, st.size);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      s = buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return null; }
  return s;
}
function extractResult(file) {
  // 优化(降时间复杂度/内存): 只读文件尾部窗口(最后 maxTailBytes), 而非 readFileSync 整个 rollout。
  // 完成汇报/最终消息必然在文件末尾, 全量读对超大 rollout(可达 160MB+)是纯浪费。
  let full = readTail(file, 262144);
  if (full === null) return { done: true, text: "" };
  let last = "";
  for (const line of full.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      const p = o.payload || {};
      if (p.type === "agent_message" && p.message) last = p.message;
      else if (o.type === "response_item" && p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
        const t = p.content.map((c) => c.text || c.content || c.value || "").join("");
        if (t) last = t;
      }
    } catch { /* ignore */ }
  }
  return { done: true, text: last };
}
// 真实 token 观测：从 codex rollout(JSONL) 里累积 usage，为 plugin-eval 的 "measure real token usage" 提供确凿数字。
// 纯函数、只读尾部窗口(内存 O(1))、容错：字段名兼容 input_tokens/prompt_tokens、output_tokens/completion_tokens、
// cached_tokens/cached_input_tokens、total_tokens；从每条含 usage 的 JSON 里取该对象。所有 token 值为缺省 0。
function extractUsage(file) {
  const u = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0 };
  let full;
  try { full = readTail(file, 262144); } catch { return u; }
  if (full === null) return u;
  const pickNum = (o, ...keys) => { for (const k of keys) { if (o && typeof o[k] === "number" && o[k] > 0) return o[k]; } return 0; };
  for (const line of full.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      const p = o && o.payload ? o.payload : o;
      // usage 可能直接在对象上，或在 payload.response/usage 里
      const ug = (o && o.usage) || (p && p.usage) || (p && p.response && p.response.usage) || null;
      if (ug && typeof ug === "object") {
        u.input_tokens += pickNum(ug, "input_tokens", "prompt_tokens", "input");
        u.output_tokens += pickNum(ug, "output_tokens", "completion_tokens", "output");
        u.cached_tokens += pickNum(ug, "cached_tokens", "cached_input_tokens", "cached");
        u.total_tokens += pickNum(ug, "total_tokens", "total");
      }
    } catch { /* ignore */ }
  }
  return u;
}
// Deterministic report: require a complete, token-bound launcher receipt before reading its text.
function resultTokenValue(token) {
  const raw = String(token || "");
  const marker = raw.match(/【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_\-]*)/);
  return marker ? marker[1] : raw;
}
function readReportFromResult(resultFile, token) {
  if (!resultFile || !existsSync(resultFile)) return "";
  try {
    const raw = String(readFileSync(resultFile, "utf8")).replace(/^\uFEFF/, "");
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    if (!j || j.__DONE__ !== true) return "";
    if (!Number.isInteger(j.__EXIT__)) return "";
    if (token && String(j.__TOKEN__ || "") !== resultTokenValue(token)) return "";
    if (typeof j.__REPORT__ !== "string") return "";
    const rep = j.__REPORT__;
    if (rep.trim()) return rep;
  } catch { /* ignore */ }
  return "";
}
async function waitForCapturedReport(resultFile, token, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const report = readReportFromResult(resultFile, token);
    if (report) return report;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readReportFromResult(resultFile, token);
}
// 在（可能混合了多窗消息的）rollout 里，取“含本块唯一 token 的最后一条消息”（真正的本块完成汇报），
// 避免混合会话下 extractResult 取到别的窗的“全局最后一条”而跨窗串号。
function extractOwnResult(file, token) {
  if (!token) return "";
  // 优化: 只读尾部窗口, 避免全量读超大 rollout。
  let full = readTail(file, 262144);
  if (full === null) return "";
  let last = "";
  for (const line of full.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      const p = o.payload || {};
      let msg = "";
      if (p.type === "agent_message" && p.message) msg = p.message;
      else if (o.type === "response_item" && p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) msg = p.content.map((c) => c.text || c.content || c.value || "").join("");
      if (msg && tokenInMessage(msg, token)) last = msg;
    } catch { /* ignore */ }
  }
  return last;
}
// Re-scan rollouts for the block's report and return the latest agent message, or "" if none found yet.
// Used so a window is only auto-closed AFTER its report has been captured ("close anchor = report captured"),
// instead of blind-grace timing. Bounded by `timeoutMs`.
async function waitForReportText(matchKey, exitMarkerFile, timeoutMs) {
  const start = Date.now();
  const seen = new Map();
  while (Date.now() - start < timeoutMs) {
    for (const f of listRollouts(sessionDir())) {
      let size = 0; try { size = statSync(f).size; } catch { continue; }
      if (seen.get(f) === size) continue;
      seen.set(f, size);
      try {
        if (findOwnedTurn(readFileSync(f, "utf8"), matchKey).matched) {
          const t = extractOwnResult(f, matchKey);
          if (t) return t;
        }
      } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "";
}
// Close a window GRACEFULLY so Windows Terminal auto-closes the pane. Windows Terminal hosts the
// launcher powershell (the profile process) with closeOnExit:"graceful": exit code 0 -> the pane
// auto-closes; a NON-zero exit -> it keeps the pane open and shows "[已退出进程，代码为 X]". The launcher
// ends with `... & codex ...; exit 0`, so if we recursively kill every launcher descendant (the full
// codex tree, each PID individually), `& codex` returns and the launcher runs `exit 0` -> Windows
// Terminal auto-closes the pane cleanly.
// Force-killing the launcher itself (the old `taskkill /PID <launcher> /T /F`) is exactly what made it
// exit non-zero and left the stuck "[process exited, code 1]" pane. So we target the codex child
// subtree, never the launcher, then poll for the launcher to exit on its own (exit 0). If it is
// genuinely stuck we fall back to a force-kill (last resort / never an orphan) and report it.
function readPidFile(pidf) {
  try {
    const p = Number(String(readFileSync(pidf, "utf8")).trim());
    // 与 force.mjs 的 pidOf 一致：只认 1..4194304 的合理 PID，超出/非正数一律视为无效（0），
    // 防止异常大/负值被当成活进程（process.kill 对大 pid 也可能因平台行为产生困惑）。
    return Number.isFinite(p) && p >= 1 && p <= 4194304 ? p : 0;
  } catch { return 0; }
}
function pidAliveCheck(pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return false;
  try { process.kill(p, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}
async function closeWindowByPid(pid, expected) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (!pidAliveCheck(p)) return true;
  if(!expected)return false;
  if(!sameProcess(expected,processSnapshot().get(p)))return true;
  // Recursively enumerate ALL launcher descendants (the full codex tree) along the ParentProcessId
  // chain and kill each PID individually, so `& codex` always returns and the launcher reaches its own
  // `exit 0`. Never touches the launcher itself; when codex already exited (no descendants) nothing is
  // killed. spawnSync passes args as an array -> no shell arg-splitting of the multi-line script.
  const killScript =
    "$ErrorActionPreference='SilentlyContinue';" + "\r\n" +
    "$root=" + p + ";" + "\r\n" +
    psKillDescendantsLines().join("\r\n").replace('$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue',
      '$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue; $actual=$all | Where-Object ProcessId -eq '+p+'; if(-not $actual -or $actual.CreationDate.ToUniversalTime().ToString("o") -ne '+buildPsArrayLit([expected.Started])+'[0] -or $actual.CommandLine -ne '+buildPsArrayLit([expected.CommandLine])+'[0]) { exit 0 }');
  let killedCount = 0;
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", killScript], { encoding: "utf8", windowsHide: true });
    killedCount = Number(String(r.stdout || "").trim().split(/\r?\n/).pop()) || 0;
  } catch { /* ignore */ }
  // Poll for the launcher to exit on its own; the launcher runs `exit 0` right after `& codex` returns.
  const closeGrace = Number(process.env.ORCH_CLOSE_GRACE_MS || 15000);
  const deadline = Date.now() + (Number.isFinite(closeGrace) ? Math.max(1000, Math.min(60000, closeGrace)) : 15000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!sameProcess(expected,processSnapshot().get(p))) return true;
  }
  if (killedCount === 0) {
    // agent 已退出 / 无后代可杀：launcher 应自行 Write-Result + exit 0。绝不在此时强杀 launcher，
    // 否则 Windows Terminal 会留下 "[已退出进程，代码为 1]" 的误报窗。
    console.log("  !! launcher " + p + " still alive but has no codex descendants (codex already exited); skipping force-kill and leaving it to exit 0 on its own.");
    return false;
  }
  // Last resort (genuine exception only): the launcher did NOT honor `exit 0` within the grace window.
  // 根治：绝不 taskkill launcher 本体——它只会以 exit 1 亡，Windows Terminal 留下「[已退出进程，代码为 1]」
  // 且不自动关的卡壳窗。既然 agent 后代已杀净、launcher 模板带 trap{exit 0} 恒以 0 收尾，就把它留给它自己
  // exit 0（窗格随之干净关闭），仅如实记录，绝不制造 code-1 残窗。
  console.log("  !! launcher " + p + " did not exit after killing its codex child; leaving it to self-exit 0 (no force-kill, avoids code-1 pane).");
  return false;
}
// 多路定位 launcher：pidFile -> registry pid -> 按 win-launch 脚本路径扫描进程；pidFile 被外部清理时依然能关窗。
async function closeWindowRobust(w) {
  const pidf = w && w.pidFile;
  let pid = (pidf && existsSync(pidf)) ? readPidFile(pidf) : 0;
  if (!pid && w && Number(w.pid)) pid = Number(w.pid);
  if (!pid && pidf) {
    const lp = path.join(path.dirname(pidf), path.basename(pidf).replace(/^window-/, "win-launch-").replace(/\.pid$/, ".ps1"));
    try {
      const esc = String(lp).replace(/'/g, "''");
      const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        "$ErrorActionPreference='SilentlyContinue'; $q = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*" + esc + "*' } | Select-Object -First 1; if ($q) { $q.ProcessId }"], { encoding: "utf8", windowsHide: true });
      pid = Number(String(r.stdout || "").trim());
    } catch { /* ignore */ }
  }
  if (!pid) return false;
  if (pidf) { try { writeFileSync(pidf + ".self-closed", "1", "ascii"); } catch { /* ignore */ } }
  await closeWindowByPid(pid, launcherIdentity(pid,pidf));
  // Close only this launcher subtree; the terminal host may own other live windows.
  return true;
}
async function closeWindow(pidf) {
  if (!pidf || !existsSync(pidf)) return;
  try { writeFileSync(pidf + ".self-closed", "1", "ascii"); } catch { /* ignore */ }
  await closeWindowByPid(readPidFile(pidf),launcherIdentity(readPidFile(pidf),pidf));
  // Close only this launcher subtree; the terminal host may own other live windows.
}
// ---------------------------------------------------------------------------
// Running-window registry + conflict locking (stability)
// ---------------------------------------------------------------------------
const WIN_REG = path.join(STATE_DIR, "orchestrator-windows.json");
const LOCK_REG = path.join(STATE_DIR, "orchestrator-locks.json");
const REG_LOCK = path.join(STATE_DIR, "orchestrator-registry.lock");
function sleepSync(ms) { try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms); } catch { /* ignore */ } }
const configuredLockTtl = Number(process.env.ORCH_REGISTRY_LOCK_TTL_MS || 120000);
const REG_LOCK_TTL_MS = Number.isFinite(configuredLockTtl) && configuredLockTtl >= 5000 ? configuredLockTtl : 120000;
function registryLockStale(lockPath) {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age < REG_LOCK_TTL_MS) return false;
    let ownerPid = 0;
    try { ownerPid = Number(JSON.parse(readFileSync(lockPath, "utf8")).pid || 0); } catch { /* legacy empty lock */ }
    return !(ownerPid > 0 && pidAliveCheck(ownerPid));
  } catch { return false; }
}
// 跨进程独占锁：openSync 'wx' 原子创建；冲突则有限重试；陈旧锁只在 owner 已死时回收。
// 获取失败必须 fail-closed，禁止继续执行 registry 事务，否则会绕过容量/冲突保护。
function withRegistryLock(fn, options = {}) {
  const lockPath = options.lockPath || REG_LOCK;
  const attempts = Math.max(1, Number(options.attempts ?? 100));
  const retryMs = Math.max(0, Number(options.retryMs ?? 20));
  // 锁文件所在的目录必须先存在。全新工作区的第一次加锁（例如规划期写拆块缓存）
  // 会 openSync(...,'wx') 拿到 ENOENT，而建目录的 mkdirSync 在锁内，重试永远救不回来，
  // 结果是规划静默退化成单串行块。这里先补目录，失败再交给 openSync 报真实错误。
  try { mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* 让下面的 openSync 报错 */ }
  let got = false;
  for (let i = 0; i < attempts; i++) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), null, "utf8");
      closeSync(fd); got = true; break;
    } catch {
      try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ }
      try {
        // Rename the stale inode before deleting it to close the stale-check/replace race.
        if (registryLockStale(lockPath)) {
          const tombstone = lockPath + ".stale-" + process.pid + "-" + Date.now();
          try { renameSync(lockPath, tombstone); rmSync(tombstone, { force: true }); } catch { /* another owner won */ }
        }
      } catch { /* retry */ }
      if (i + 1 < attempts) sleepSync(retryMs);
    }
  }
  if (!got) throw new Error("Registry lock acquisition failed: " + lockPath);
  try { return fn(); }
  finally { try { rmSync(lockPath, { force: true }); } catch { /* ignore */ } }
}
function loadJson(file, fallback) {
  // 写侧在 Windows 上做 "remove+rename"（原子替换），会瞬时让文件不存在；读侧短暂重试即可桥接该间隙。
  let lastError = null;
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { lastError = error; if (i < 2) sleepSync(12); }
  }
  // A missing registry is a normal first-run condition. Malformed state is
  // different: treating it as an empty registry could bypass the capacity or
  // conflict gate and start too many windows. Fail closed after the bounded
  // atomic-replace grace period instead of silently discarding state.
  if (lastError?.code === "ENOENT") return fallback;
  throw new Error("Invalid orchestration state: " + file);
}
function saveJson(file, data) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    try { renameSync(tmp, file); } catch (e) {
      // Windows renameSync 不覆盖已存在目标；先移除再重命名，避免留下半写 registry。
      if (e && (e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES")) {
        try { rmSync(file, { force: true }); } catch {}
        try { renameSync(tmp, file); } catch (e2) { rmSync(tmp, { force: true }); throw e2; }
      } else { rmSync(tmp, { force: true }); throw e; }
    }
  } catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
}
function loadWindows() { return loadJson(WIN_REG, []); }
function loadLocks() { return loadJson(LOCK_REG, []); }
function saveLocks(l) { withRegistryLock(() => saveJson(LOCK_REG, l)); }
// 全事务：load+mutate+save 在同一个锁内完成，杜绝跨进程 lost-update。
function updateWindows(mutator) { withRegistryLock(() => { const w = loadJson(WIN_REG, []); saveJson(WIN_REG, mutator(w)); }); }
function updateLocks(mutator) { withRegistryLock(() => { const l = loadJson(LOCK_REG, []); saveJson(LOCK_REG, mutator(l)); }); }
// ---- 跨进程原子占位（防「检查-弹窗」间隙双进程同键竞态）----
// 弹窗前先在独占锁内写入 pending=true 的记录（pid=0、预留 pidFile），其它编排进程把新鲜占位视作已占用；
// 弹出成功后再 commit 真实 pid，失败则 cancel。崩溃遗留的占位超过 ORCH_RESERVE_TTL_MS（默认 120s）自动作废。
const RESERVE_TTL_MS = Math.max(30000, Number(process.env.ORCH_RESERVE_TTL_MS || 120000));
function freshPending(w) {
  return !!(w && w.pending === true && Number(w.reservedAt || 0) > Date.now() - RESERVE_TTL_MS);
}
// ---- 测试注入点（仅测试用，生产缺省走真实实现；避免单测触发真实 tasklist/文件锁）----
// hooks: { db, alive, lock, now }。db=注册表 json 路径；alive=windowAlive 替代；lock=withRegistryLock 替代；now=Date.now 替代。
let __orchHooks = null;
function testDb() { return (__orchHooks && __orchHooks.db) ? String(__orchHooks.db) : WIN_REG; }
function testAlive() { return (__orchHooks && __orchHooks.alive) ? __orchHooks.alive : (w) => windowAlive(w); }
function testNow() { return (__orchHooks && __orchHooks.now) ? __orchHooks.now : Date.now; }
function testFresh(w) {
  return !!(w && w.pending === true && Number(w.reservedAt || 0) > testNow()() - RESERVE_TTL_MS);
}
function testLock(fn) { return (__orchHooks && __orchHooks.lock) ? __orchHooks.lock(fn) : withRegistryLock(fn); }
function testUpdateWindows(mutator) {
  return testLock(() => { const w = loadJson(testDb(), []); saveJson(testDb(), mutator(w)); });
}
function __setOrchHooks(h) { __orchHooks = h || null; }
function tryReserveWindow(rec) {
  let conflictTitle = null;
  testLock(() => {
    const ws = loadJson(testDb(), []);
    const cleaned = ws.filter((w) => {
      if (w && w.pending === true) return testFresh(w);
      // A committed window with a pid file is authoritative only while that
      // exact launcher identity is alive. Prune dead records here so a failed
      // popup or an orderly close cannot leave the registry growing forever.
      // Legacy records without a pid file are retained because their owner
      // identity cannot be rechecked safely.
      return !w?.pidFile || testAlive()(w);
    });
    for (const w of cleaned) {
      if (testAlive()(w) || testFresh(w)) {
        const wk = Array.isArray(w.keys) ? w.keys.map(String) : (w.title ? ["__" + w.title] : []);
        if (keysOverlap(Array.isArray(rec.keys) ? rec.keys.map(String) : [], wk)) {
          conflictTitle = w.title || "?";
          break;
        }
      }
    }
    if (!conflictTitle) {
      cleaned.push(rec);
      saveJson(testDb(), cleaned);
    } else if (cleaned.length !== ws.length) {
      saveJson(testDb(), cleaned); // 只清死占位也落盘，避免堆积
    }
  });
  return conflictTitle;
}
function commitReservation(id, pid) {
  testUpdateWindows((ws) => ws.map((w) => w.id === id ? { ...w, pid: Number(pid) || w.pid, identity: __orchHooks ? undefined : launcherIdentity(pid,w.pidFile), pending: false, reservedAt: testNow()() } : w));
}
function cancelReservation(id) {
  testUpdateWindows((ws) => ws.filter((w) => w.id !== id));
}
// The launcher writes its codex-exit marker to `win-<s>.result.json` (same dir as the pidfile).
function resultFileOf(pidf) {
  return pidf ? path.join(path.dirname(pidf), path.basename(pidf).replace(/^window-/, "win-").replace(/\.pid$/, ".result.json")) : "";
}
// Read the recorded codex exit code from a launcher result marker (null if absent/unparseable).
function readExitCode(rf) {
  try {
    const raw = String(readFileSync(rf, "utf8")).replace(/^\uFEFF/, "");
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        if (j && Number.isInteger(j.__EXIT__)) return j.__EXIT__;
      } catch { /* fall through to the explicit marker line */ }
    }
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      const marker = line.match(/^__EXIT__=(-?\d+)$/);
      if (marker) return Number(marker[1]);
    }
  } catch { /* ignore */ }
  return null;
}
// A window is "alive" if its launcher PID still exists (window still open).
function windowAlive(win) {
  if(!win?.pidFile||!existsSync(win.pidFile))return false;
  const actual=launcherIdentity(readPidFile(win.pidFile),win.pidFile);
  return !!actual&&(!win.identity||sameProcess(win.identity,actual));
}
// Returns the conflictKeys of a block (never empty -> at least [<title>]).
function blockKeys(block) {
  const k = Array.isArray(block.conflictKeys) ? block.conflictKeys.map(String) : [];
  return k.length ? k : ["__" + (block.title || "block")];
}

// For each running window, add a pseudo-record so new blocks can be compared.
function runningRecord() {
  return loadWindows().filter((w) => windowAlive(w) || freshPending(w)).map((w) => ({ title: w.title, keys: w.keys }));
}
// Check a new block against alive windows; return the blocking window title or null.
function conflictBlock(block) {
  const nkeys = blockKeys(block);
  for (const w of runningRecord()) {
    if (keysOverlap(nkeys, w.keys)) return w.title;
  }
  return null;
}
// Check a set of keys against currently-alive windows; return the blocking window title or null.
function conflictByKeys(keys) {
  for (const w of runningRecord()) {
    if (keysOverlap(keys, w.keys)) return w.title;
  }
  return null;
}
// Poll until no alive window conflicts with `keys`, or the timeout elapses. Returns true if clear.
async function waitClear(keys, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!conflictByKeys(keys)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
// 兜底：从任务文本推断"具体目标文件"作为额外冲突键。LLM 漏给 conflict_hints / depends_on 时，
// 共享同一目标文件的独立块仍会被识别为冲突并合并为一个串行块（依赖/同目标任务绝不并行竞态）。
// 只提取"像具体文件"的绝对路径（含扩展名），避免把裸目录(D:\temp)当目标造成过度串行、伤并发。
function inferTargetKeys(text) {
  const keys = new Set();
  const s = String(text || "");
  const isFileLike = (p) => /[A-Za-z0-9_\-.]+\.[A-Za-z0-9]{1,5}$/.test(p);
  // Windows 绝对盘符路径
  for (const m of s.matchAll(/[A-Za-z]:[\\/][^\s"'`,;)]+/g)) {
    const p = m[0].replace(/[\\/]+$/, "");
    if (isFileLike(p)) keys.add("file:" + p);
  }
  // Unix 风格绝对路径：仅接受带目录成分的多段路径（≥2 个斜杠），且排除前导字符为字母/数字/冒号的情况——
  // 否则 “project-91/probe.mjs” 这类数字结尾目录会把 “/probe.mjs” 抽成碎片 key：多个任务写同名文件即互相撞 key，
  // normalizePlan 会把彼此独立的块静默合并成单块（并行计划坍缩为 inline）。
  for (const m of s.matchAll(/(?<![A-Za-z0-9:])\/[^\s"'`,;)]+/g)) {
    const p = m[0].replace(/[\\/]+$/, "");
    if (!isFileLike(p)) continue;
    if ((p.match(/\//g) || []).length < 2) continue; // 单段 “/file.ext” 视为碎片，不生成冲突 key
    keys.add("file:" + p);
  }
  return [...keys];
}
// Over-merge guard (code-level, not relying on the model):
//   - any `independent` block carrying multiple tasks -> split into one block per task.
//   - any two blocks that share a conflictKey (would conflict if parallel) -> merge into ONE linked block.
// This makes "over-merge into a parallel block" impossible and "under-merge into a self-colliding batch" impossible.
function normalizePlan(plan) {
  const originals=structuredClone(plan);
  const recs=originals.map((b,i)=>({key:'B'+(i+1),title:b.title,b,dependsOn:b.dependsOn||[]}));
  const ordered=levelWaves(recs).flat();
  for(const r of recs) r.keys=[...new Set([...(r.b.conflictKeys||[]),...r.b.tasks.flatMap(t=>inferTargetKeys(t.prompt||t.title||''))])];
  const groups=[];
  for(const r of ordered) {
    const hits=groups.filter(g=>g.some(x=>keysOverlap(x.keys,r.keys)));
    if(hits.length){
      // 合并诊断：块因共享冲突 key 被并组。若 key 是“/单段文件名”碎片形式，提示可能为误合并来源。
      const shared=[...new Set(hits.flat().flatMap(x=>x.keys).filter(k=>r.keys.includes(k)))];
      console.warn("[orchestrator] plan merge: blocks [" + [...new Set(hits.flat().map(x=>x.key)),r.key].join(",") + "] share conflict key(s): " + shared.join(", ") + (shared.some(k=>/^file:(\/|\\)[^/\\]+$/.test(k)) ? "（含单段文件名碎片 key，警惕同名文件导致的非预期合并）" : ""));
    }
    const group=[...hits.flat(),r];for(const hit of hits)groups.splice(groups.indexOf(hit),1);groups.push(group);
  }
  const owner=new Map();groups.forEach((g,i)=>g.forEach(r=>owner.set(r.key,i)));
  const result=groups.map((g,i)=>({title:g.length===1?g[0].title:'merged-'+(i+1),type:g.length>1||g.some(r=>r.b.type==='linked')?'linked':g[0].b.type,
    tasks:ordered.filter(r=>g.includes(r)).flatMap(r=>r.b.tasks),conflictKeys:[...new Set(g.flatMap(r=>r.keys))],
    dependsOn:[...new Set(g.flatMap(r=>r.dependsOn).filter(k=>owner.get(k)!==i).map(k=>owner.get(k)))]}));
  for(const b of result)b.dependsOn=b.dependsOn.map(i=>result[i].title);
  try{levelWaves(result.map((b,i)=>({key:'B'+(i+1),title:b.title,b,dependsOn:b.dependsOn})));return result;}
  catch(e){if(!/Cyclic/.test(e.message))throw e;return [{title:'serial-conflict-dependencies',type:'linked',dependsOn:[],conflictKeys:[...new Set(recs.flatMap(r=>r.keys))],tasks:ordered.flatMap(r=>r.b.tasks)}];}
}
// Stale transient auto-clean ("用完即弃"): remove orchestrator's own leftover temp artifacts
// (prompt/launcher/result/log/pid/.self-closed markers) and dead-window pid files;
// never remove anything belonging to a live process (registry is not the only source of truth:
// a launcher may be alive but not yet registered, so the pid file itself is consulted).
function pidFileOfTransient(f) {
  let m;
  if ((m = f.match(/^window-(.*)\.pid$/))) return f;
  if ((m = f.match(/^window-(.*)\.pid\.self-closed$/))) return "window-" + m[1] + ".pid";
  if ((m = f.match(/^win-(.*)\.result\.json\.self-closed$/))) return "window-" + m[1] + ".pid";
  if ((m = f.match(/^win-(.*)\.result\.json$/))) return "window-" + m[1] + ".pid";
  if ((m = f.match(/^win-launch-(.*)\.ps1$/))) return "window-" + m[1] + ".pid";
  if ((m = f.match(/^agent-win-(.*)\.md$/))) return "window-" + m[1] + ".pid";
  if ((m = f.match(/^win-(.*)\.log$/))) return "window-" + m[1] + ".pid";
  return null;
}
function staleTransientFiles() {
  const alivePids = new Set();
  const res = [];
  let names = [];
  try { names = readdirSync(TMP); } catch { return res; }
  // 先扫一遍全部 window-*.pid：只要进程仍存活即受保护（无论是否已入 registry）。
  for (const f of names) {
    if (!/^window-.*\.pid$/.test(f)) continue;
    try {
      const pid = Number(String(readFileSync(path.join(TMP, f), "utf8")).trim());
      if (pid > 0 && pidAliveCheck(pid)) alivePids.add(pid);
    } catch { /* unreadable -> stale */ }
  }
  for (const f of names) {
    const p = path.join(TMP, f);
    if (!/^(agent-win-.*\.md|win-launch-.*\.ps1|win-.*\.(result\.json|log)|window-.*\.pid(\.self-closed)?|win-.*\.result\.json\.self-closed)$/.test(f)) continue;
    const pidf = pidFileOfTransient(f);
    if (!pidf) continue;
    try {
      const pid = Number(String(readFileSync(path.join(TMP, pidf), "utf8")).trim());
      if (pid > 0 && alivePids.has(pid)) continue; // 活窗的附属文件一律不删
    } catch { /* pid 文件缺失/不可读 -> 残留 */ }
    res.push(p);
  }
  return res;
}
/**
 * 判断一个 WindowsTerminal 进程是否由编排器拉起：命令行里出现 `...\temp\win-launch-*.ps1`
 * 这种启动器路径。**与工作区无关**——编排器在任意工作区（例如 D:\temp\xxx\ws）都会用同一命名，
 * 只认本仓库 temp 会漏掉其它工作区留下的错误窗（实测踩到过）。是否安全杀由调用方再用
 * “launcher 已死 + 该窗无活子进程”把关。纯函数，便于单测。
 */
export function isPluginOwnedTerminalCommand(commandLine, tempDir = "") {
  const cmd = String(commandLine || "").toLowerCase();
  if (!/win-launch-[\w.\-]+\.ps1/.test(cmd)) return false;
  if (!/[\\/]temp[\\/]win-launch-/.test(cmd)) return false;
  // tempDir 只作为额外的“确实是编排器工作区”佐证；为空时不影响判定。
  return true;
}
/**
 * 主动清扫"代码 1"残留窗：Windows Terminal 会在窗内进程非 0 退出后把面板留着，
 * 于是屏幕上出现一片报错窗。这里只认本插件自己的窗口（命令行带本工作区 temp 下的
 * win-launch-*.ps1），并且要求 launcher 已死且该窗没有任何活着的子进程，才会强杀；
 * 活窗、别人的窗口、共享的 WT 宿主一律不碰。
 */
export async function closeOrphanTerminals() {
  let closed = 0;
  try {
    const procs = [...processSnapshot().values()];
    for (const proc of procs) {
      if (!/^WindowsTerminal\.exe$/i.test(String(proc.Name || ""))) continue;
      const cmd = String(proc.CommandLine || "");
      if (!isPluginOwnedTerminalCommand(cmd, TMP)) continue;
      const m = /win-launch-([\w.\-]+)\.ps1/i.exec(cmd);
      let launcherAlive = false;
      if (m) {
        const pidf = path.join(TMP, "window-" + m[1] + ".pid");
        try {
          const pid = Number(String(readFileSync(pidf, "utf8")).replace(/^\uFEFF/, "").trim());
          launcherAlive = pid > 0 && pidAliveCheck(pid);
        } catch { /* pid 缺失/不可读 -> 视为已死 */ }
      }
      const hasLiveChild = procs.some(p => Number(p.ParentProcessId) === Number(proc.ProcessId));
      if (launcherAlive || hasLiveChild) continue;
      spawnSync("taskkill.exe", ["/F", "/T", "/PID", String(proc.ProcessId)], { windowsHide: true });
      closed++;
      console.log("[orchestrator] closed orphan error window pid=" + proc.ProcessId + " (launcher exited non-zero; pane left open)");
    }
  } catch { /* 清扫是尽力而为，绝不影响主流程 */ }
  return closed;
}
async function cleanStaleWindows() {
  // 兜底：上次若被中断/异常退出，会遗留 orchestrator 窗口(win-launch-*.ps1 launcher + 其 agent 子进程)。
  // 下次启动时按 orchestrator 自己的命名(win-launch-)识别历史残留，用优雅关窗关闭(杀 codex -> launcher exit0 -> WT pane 自动关)。
  // 安全边界：只清理「没有活着 pid 文件 / 未被 registry 追踪 / 当前没有 pending 占位」的 launcher——
  // 绝不误杀同一或另一编排批次仍在运行的窗口（活窗应走冲突锁，而不是被“陈旧清理”干掉）。
  try {
    const freshReservations = loadWindows().filter(freshPending);
    if (freshReservations.length) {
      console.log("[orchestrator] another process is mid-popup (" + freshReservations.length + " pending reservation(s)); skipping stale-window cleanup.");
      return;
    }
    const protectedPids = new Set();
    let names = [];
    try { names = readdirSync(TMP); } catch { names = []; }
    for (const f of names) {
      if (!/^window-.*\.pid$/.test(f)) continue;
      try {
        const pid = Number(String(readFileSync(path.join(TMP, f), "utf8")).trim());
        if (pid > 0 && pidAliveCheck(pid)) protectedPids.add(pid);
      } catch { /* ignore */ }
    }
    for (const w of loadWindows()) {
      if (windowAlive(w) && w.pidFile && existsSync(w.pidFile)) {
        try { protectedPids.add(Number(String(readFileSync(w.pidFile, "utf8")).trim())); } catch { /* ignore */ }
      }
    }
    const r = spawnSync("powershell.exe", ["-NoProfile","-ExecutionPolicy","Bypass","-Command",
      "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*win-launch-*' } | ForEach-Object { $_.ProcessId }"], { encoding: "utf8", windowsHide: true });
    const stale = String(r.stdout || "").split(/\r?\n/).map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0 && !protectedPids.has(n));
    const pidFiles = new Map();
    for (const f of names) if (/^window-.*\.pid$/.test(f)) {
      try { const pid = Number(String(readFileSync(path.join(TMP, f), "utf8")).trim()); if (pid > 0) pidFiles.set(pid, path.join(TMP, f)); } catch { /* stale */ }
    }
    const ids = stale.filter((pid) => pidFiles.has(pid));
    if (!ids.length) { console.log("[orchestrator] no stale orchestrator windows from previous run."); await closeOrphanTerminals(); return; }
    console.log("[orchestrator] cleaning " + ids.length + " stale orchestrator window(s) from previous run (protected live windows: " + protectedPids.size + ")...");
    await Promise.all(ids.map(async (pid) => { try { await closeWindowByPid(pid, launcherIdentity(pid, pidFiles.get(pid))); } catch { /* ignore */ } }));
    await closeOrphanTerminals();
  } catch { /* ignore */ }
}
function cleanStaleTransients() {
  try {
    const stale = staleTransientFiles();
    for (const f of stale) rmSync(f, { force: true });
    if (stale.length) console.log("[orchestrator] cleaned " + stale.length + " stale transient file(s)");
  } catch { /* ignore */ }
}
// --status: print alive windows, pending locks, auto-release locks whose window closed.
// readonly=true 仅用于外部只读查询（如 poll-windows），不释放/改写锁，避免与运行中的编排器竞争。
function showStatus(readonly) {
  const wins = loadWindows();
  const alive = wins.filter((w) => windowAlive(w));
  const closed = wins.filter((w) => !windowAlive(w));
  let locks = loadLocks();
  const before = locks.length;
  locks = locks.filter((l) => { const bw = alive.find((w) => w.title === l.blockedBy); return !!bw; });
  if (!readonly && locks.length !== before) { updateLocks(() => { const cur = loadJson(LOCK_REG, []); return cur.filter((l) => { const bw = (loadWindows()).find((w) => w.title === l.blockedBy); return !!bw; }); }); console.log("released " + (before - locks.length) + " lock(s) whose window closed"); }
  console.log("=== alive agent TUI windows ===");
  for (const w of alive) console.log("  [" + w.title + "] keys=" + (w.keys || []).join(","));
  if (!alive.length) console.log("  (none)");
  console.log("=== pending window reservations (mid-popup) ===");
  const pending = wins.filter(freshPending);
  for (const w of pending) console.log("  [reserve:" + w.title + "] keys=" + (w.keys || []).join(","));
  if (!pending.length) console.log("  (none)");
  console.log("=== pending locks (waiting for a window to close) ===");
  for (const l of locks) console.log("  [blocked] \"" + (l.title || l.block) + "\" waits for window \"" + l.blockedBy + "\"");
  if (!locks.length) console.log("  (none)");
}
// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// 入口判定（真实执行 vs 只读分析）：明显两端走确定性快判，歧义交给 LLM（更准）。
// fail-safe：LLM 失败/无结论 -> 判 execute（宁可弹窗，也不把真实执行误当只读而跳过）。
async function classifyExecutionMode(request) {
  const req = String(request || "").trim();
  if (!req) return "inline";
  const RO_RE = /(分析|方案|看看|说明|回答|解读|介绍|评估|为什么|怎么回事|怎样|如何|是否|规划|理解|解释|回顾|概述|总结|探讨|讨论|这是什么|怎么理解|报告一下|列表|[?？]\s*$)/;
  const REAL_RE = /(创建|写入|写文件|修改|改|删除|删|复制|启动|重启|生成|新增|优化|修复|清理|删掉|建立|添加|安装|测试|执行|部署|停止|停|重命名|迁移|解耦|还原|配置|编辑|刷新|重置|连接|运行|编译|构建|打包|发布|提交|推送|发起|build|write|delete|create|fix|install|restart|start|stop|restore|migrate|deploy|run|edit)/i;
  const ro = RO_RE.test(req);
  const real = REAL_RE.test(req);
  if (real && !ro) return "execute";
  if (ro && !real) return "inline";
  // 歧义（同时命中或都不命中）→ LLM 判定，更准。
  const prompt = "你只做一件事：判断下面这段请求是「只读/纯分析（不修改文件、不安装、不构建、不运行、不配置，只是看/解释/评估/方案/回答）」还是「真实执行（会写文件/改代码/安装/构建/运行/配置/重启/删除等）」。只回一个词：inline 或 execute，不要任何其它文字。\n请求：" + req;
  try {
    const res = await runThreadPrompt(prompt, { sandboxMode: "read-only" });
    const ans = String((res && res.final) || "");
    if (/execute|真实|执行|修改|写入|安装|构建|运行|部署|重启|删除/.test(ans)) return "execute";
    if (/inline|只读|分析|评估|查看|方案|回答|说明/.test(ans)) return "inline";
  } catch { /* ignore */ }
  return "execute"; // fail-safe
}
export async function main() {
  process.argv=[...process.argv.slice(0,2),...configureEntryArgs(process.argv.slice(2))];
  const bareRequest=process.argv[2]&&!process.argv[2].startsWith('--');
  const mode = bareRequest?'--run':process.argv[2];
  const modeFlags = new Set(['--run-windows','--visible','--run','--exec','--headless','--resume-run','--spawn','--selftest-close','--doctor','--plan','--status','--clear-cache','--verify-run']);
  const requestedModes = leadingModeFlags(process.argv.slice(2),modeFlags);
  if (requestedModes.length > 1) throw new Error('Conflicting execution modes: ' + requestedModes.join(', '));
  if (mode === "--doctor") {
    const executionMode=resolveExecutionMode('',process.env),visible=executionMode==='visible';
    console.log(JSON.stringify({ agent: AGENT.agent, cli: CODEX, workspace: WORKSPACE,
      stateDir: STATE_DIR, executionMode, terminal: visible?(TUI_MODE==='wt'&&wtAvailable() ? "wt" : "conhost"):null,
      windowActivation: visible?(TUI_MODE==='wt'&&wtAvailable() ? 'terminal-managed' : 'no-activate'):'none',
      args: visible?AGENT_ARGS_LIST:buildExecArgs(AGENT_ARGS_LIST), interactiveOutput: visible?'inherited':'jsonl' }, null, 2));
    return;
  }
  if (mode === "--plan") {
    const request = process.argv.slice(3).join(" ");
    checkDiskSpace({ warnOnly: true });
    const plan = await decomposeSafely(request);
    console.log(JSON.stringify({ blocks: plan }, null, 2));
    return;
  }
  if (mode === "--clear-cache") {
    try { rmSync(DECOMPOSE_CACHE, { force: true }); console.log("[orchestrator] decompose cache cleared: " + DECOMPOSE_CACHE); }
    catch (e) { console.log("[orchestrator] nothing to clear (cache absent or unreadable): " + (e && e.message ? e.message : e)); }
    return;
  }
  if (mode === "--spawn") {
    armEnforcement();
    await cleanStaleWindows();
    cleanStaleTransients();
    ensureCodexCli();
    if (!checkDiskSpace()) { process.exitCode = 1; return; }
    const title = process.argv[3] || "codex-task";
    let promptContent = process.argv.slice(4).join(" ");
    const probablyFile = process.argv[4];
    if (probablyFile && existsSync(probablyFile) && statSync(probablyFile).isFile()) promptContent = readFileSync(probablyFile, "utf8");
    const rid = Date.now().toString(36);
    const trackedPrompt = promptContent + "\n\n【本块唯一标识】spawn-" + rid + (AGENT.agent==='pi'?"\n完成后最后只输出 __ORCH_DONE__ spawn-"+rid:"\n（最终汇报请以「【本块唯一标识】spawn-" + rid + " 完成」开头，并说明本块完成情况）");
    const { lp, pidf, pf, rf } = writeInteractiveLauncher(title, trackedPrompt, rid);
    const stok = "spawn-" + rid;
    const claim = { id: "claim-" + rid + "-spawn", title: titleOf("spawn-" + rid, title), keys: ["spawn:" + rid], pidFile: pidf, pid: 0, locked: false, pending: true, reservedAt: Date.now() };
    const claimBlocker = tryReserveWindow(claim);
    if (claimBlocker) {
      console.log("spawn REFUSED: atomic claim blocked by [" + claimBlocker + "]; not opening another window.");
      for (const f of [pf, lp]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      process.exitCode = 1;
      return;
    }
    let popped;
    try { popped = await spawnWindowWithRetry(lp, title, pidf, 3, stok); }
    catch (error) {
      cancelReservation(claim.id);
      releaseAuxiliaryWindow(lp);
      for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      console.log("spawn ADMISSION-FAILED: " + error.message);
      process.exitCode = 1;
      return;
    }
    if (!popped) {
      cancelReservation(claim.id);
      releaseAuxiliaryWindow(lp);
      for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      console.log("spawn POPUP-FAILED: window did not appear.");
      process.exitCode = 1;
      return;
    }
    commitReservation(claim.id, readPidFile(pidf) || 0);
    console.log("write launcher -> " + lp);
    console.log("spawned tracked TUI window, polling for completion...");
    const matchToken = "【本块唯一标识】spawn-" + rid;
    const sessionFile = AGENT.agent==='pi'?rf:await waitForSessionFile(matchToken, 120000, rf);
    let res = { done: false, text: "" };
    if (sessionFile) {
      res = AGENT.agent==='pi'?await waitPiResult(rf,POLL_TIMEOUT_MS,pidf):await waitTaskComplete(sessionFile, POLL_TIMEOUT_MS, rf, matchToken, pidf);
    } else if (existsSync(rf)) {
      const report = await waitForCapturedReport(rf, matchToken);
      res = report
        ? { done: true, verified: true, text: report, exitCode: readExitCode(rf) }
        : { done: false, verified: false, text: "(launcher exit marker seen; no rollout matched)", exitCode: readExitCode(rf) };
    }
    if (res.verified !== true) {
      const report = await waitForCapturedReport(rf, matchToken);
      if (report) res = { done: true, verified: true, text: report, exitCode: readExitCode(rf) };
    }
    const summaryPath = path.join(TMP, "win-summary.json");
    let summary = {};
    try { summary = JSON.parse(readFileSync(summaryPath, "utf8")); } catch {}
    const captured = Boolean(res.done && res.verified === true && res.text && !/^\(.*(?:no report captured|no rollout matched|no result captured|before task_complete captured)/i.test(String(res.text).trim()));
    // Wait for launcher to exit on its own, then force close if needed.
    let launcherAliveAfter = true;
    if (res.done) {
      const pid = Number(String(readFileSync(pidf, "utf8")).trim());
      let alive = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        try { process.kill(pid, 0); } catch (e) { if (!e || e.code !== "EPERM") { alive = false; break; } }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (alive) { await closeWindow(pidf); }
      await new Promise((r) => setTimeout(r, Number(process.env.ORCH_CLOSE_DELAY_MS) || 6000));
      try { process.kill(pid, 0); } catch (e) { if (!e || e.code !== "EPERM") alive = false; }
      launcherAliveAfter = alive;
      if (!launcherAliveAfter) {
        cancelReservation(claim.id);
        releaseAuxiliaryWindow(lp);
        for (const fp of [pidf, lp, pf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(fp)) rmSync(fp, { force: true }); } catch {} }
      }
    } else {
      console.log("spawn window still running (manual interactive); registry record kept for tracking/enforcement.");
    }
    const spawnPassed = captured && !launcherAliveAfter;
    summary["spawn-" + rid] = { title, status: spawnPassed ? "done" : (captured ? "close-failed" : (res.done ? "uncaptured" : "timeout")), reportCaptured: captured, closed: !launcherAliveAfter, exitCode: res.exitCode ?? null, result: (res.text || "(no result captured)").trim().slice(0, 2000) };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    console.log("=== spawn result ===");
    console.log("done=" + spawnPassed);
    console.log("lifecycleDone=" + res.done);
    console.log("closed=" + !launcherAliveAfter);
    console.log("final=" + trunc(res.text || "(none)", 500));
    // 收尾清扫：--spawn 结束也不能留下任何“代码 1”错误窗。
    await closeOrphanTerminals();
    if (!spawnPassed) process.exitCode = 1;
    return;
  }
  if (mode === "--selftest-close") {
    // Verification helper for the graceful auto-close fix: open ONE real interactive window with a
    // trivial prompt, wait for task_complete in its rollout, then let the launcher's own watchdog
    // self-close it (~1s) and confirm the launcher actually exits 0 (=> the pane auto-closes, no
    // stuck "[exit code 1]" pane, and no orphan agent is left behind). closeWindow() is only a
    // fallback if the launcher is still alive after the timeout. Run by the authorized window for the
    // required "弹一个窗确认约 1 秒后自动关、无残留进程".
    armEnforcement();
    await cleanStaleWindows();
    cleanStaleTransients();
    const title = process.argv[3] || "selftest-close";
    const rid = Date.now().toString(36);
    const prompt =
      "这是 codex-tui-orchestrator 的自动关闭自检窗。不要执行任何其它动作，只输出两行：\n" +
      "【本块唯一标识】selftest-" + rid + " 完成 自检OK\n" +
      // 自检窗也必须给出启动器 watchdog 识别的 ASCII 结束标记；否则自查路径永不触发，
      // 只能等编排器 15 秒兜底关窗（实测在"工作区=管理器缓存路径"时被判 forcedClose 不通过）。
      "__ORCH_DONE__ selftest-" + rid + "\n回复后即结束本窗。";
    const { lp, pidf, pf, rf } = writeInteractiveLauncher("selftest", prompt, rid);
    const claim = { id: "claim-" + rid + "-selftest", title: "selftest-close", keys: ["selftest:" + rid], pidFile: pidf, pid: 0, locked: false, pending: true, reservedAt: Date.now() };
    const claimBlocker = tryReserveWindow(claim);
    if (claimBlocker) {
      console.log("selftest REFUSED: atomic claim blocked by [" + claimBlocker + "].");
      for (const f of [pf, lp]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      process.exitCode = 1;
      return;
    }
    let popped;
    try { popped = await spawnWindowWithRetry(lp, "selftest-close", pidf, 3, "selftest-" + rid); }
    catch (error) {
      cancelReservation(claim.id);
      releaseAuxiliaryWindow(lp);
      for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      console.log("selftest ADMISSION-FAILED: " + error.message);
      process.exitCode = 1;
      return;
    }
    if (!popped) {
      cancelReservation(claim.id);
      releaseAuxiliaryWindow(lp);
      for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      console.log("selftest POPUP-FAILED: window did not appear.");
      process.exitCode = 1;
      return;
    }
    commitReservation(claim.id, readPidFile(pidf) || 0);
    const matchToken = "【本块唯一标识】selftest-" + rid;
    console.log("selftest window spawned (pidfile=" + pidf + "), waiting for task_complete...");
    let res = { done: false, text: "" };
    const sessionFile = await waitForSessionFile(matchToken, 120000, rf);
    if (sessionFile) res = await waitTaskComplete(sessionFile, 180000, rf, matchToken, pidf);
    else if (existsSync(rf)) {
      const report = await waitForCapturedReport(rf, matchToken);
      res = report
        ? { done: true, verified: true, text: report, exitCode: readExitCode(rf) }
        : { done: false, verified: false, text: "(launcher exit marker seen; no rollout matched)", exitCode: readExitCode(rf) };
    }
    if (res.verified !== true) {
      const report = await waitForCapturedReport(rf, matchToken, 15000);
      if (report) res = { done: true, verified: true, text: report, exitCode: readExitCode(rf) };
    }
    const tComplete = Date.now();
    console.log("=== selftest-close result ===");
    console.log("sessionFile=" + sessionFile);
    console.log("done=" + res.done);
    console.log("final=" + trunc(res.text || "(none)", 200));
    const pid = Number(String(readFileSync(pidf, "utf8")).trim());
    // Wait for the LAUNCHER to exit on its own (watchdog self-close, expect ~1s after completion).
    // If it is still alive after 15s, fall back to the graceful closeWindow() (last resort cleanup).
    let launcherAlive = true;
    let forcedClose = false;
    const tWait = Date.now();
    while (Date.now() - tWait < 15000) {
      try { process.kill(pid, 0); } catch (e) { if (!e || e.code !== "EPERM") { launcherAlive = false; break; } }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (launcherAlive) {
      console.log("  !! launcher still alive after task_complete; calling graceful closeWindow() fallback...");
      forcedClose = true;
      await closeWindow(pidf);
      try { process.kill(pid, 0); launcherAlive = true; } catch (e) { if (!e || e.code !== "EPERM") launcherAlive = false; }
    }
    const tClosed = Date.now();
    const elapsedAfterDetectMs = tClosed - tComplete;
    // Settle briefly so a just-exiting watchdog job can't count as an orphan.
    await new Promise((r) => setTimeout(r, 1500));
    let orphanAgent = false;
    let orphanCheckSucceeded = false;
    try {
      // 自查秒关后，被 watchdog 杀掉的子进程可能仍处于退出过程中：给一个短暂的收敛窗口，
      // 避免把"正在退出的后代"误判成孤儿（旧路径因为等 15 秒兜底而掩盖了这个竞态）。
      const orphanDeadline = Date.now() + 5000;
      do {
        orphanAgent = [...processSnapshot().values()].some(child => child.ParentProcessId === pid);
        if (!orphanAgent) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < orphanDeadline);
      orphanCheckSucceeded = true;
    } catch (error) { console.error("selftest process verification failed: " + error.message); }
    console.log("launcherPid=" + pid + " launcherStillAlive=" + launcherAlive + " (expect false => pane auto-closed)");
    console.log("elapsedAfterDetectMs=" + elapsedAfterDetectMs + " (orchestrator-detect -> launcher gone; launcher watchdog itself polls every 500ms, expect ~1s from task_complete)");
    console.log("orphanChildren=" + orphanAgent + " (expect false => no orphan agent)");
    let selftestOk = Boolean(res.done && res.verified === true && res.text && !launcherAlive && orphanCheckSucceeded && !orphanAgent && !forcedClose);
    console.log("selftestPassed=" + selftestOk + " (requires verified own report, launcher closed, and no orphan children)");
    const selftestEvidence = {
      schema: 1,
      token: matchToken,
      done: Boolean(res.done),
      reportCaptured: Boolean(res.verified === true && res.text && String(res.text).trim()),
      final: String(res.text || "").trim().slice(0, 2000),
      launcherAlive,
      orphanAgent,
      orphanCheckSucceeded,
      forcedClose,
      passed: selftestOk,
      exitCode: selftestOk ? 0 : 1,
      agentExitCode: res.exitCode ?? readExitCode(rf),
      retryable: res.retryable || null,
      providerError: res.quotaError || res.capacityError || null,
      sessionFile,
      generatedAt: new Date().toISOString(),
    };
    try { writeFileSync(path.join(TMP, "selftest-close.json"), JSON.stringify(selftestEvidence, null, 2), "utf8"); }
    catch (e) { selftestOk = false; console.error("selftest evidence write failed: " + (e?.message || e)); }
    console.log("=== selftest-close done ===");
    if (!launcherAlive && orphanCheckSucceeded && !orphanAgent) {
      cancelReservation(claim.id);
      releaseAuxiliaryWindow(lp);
      for (const f of (selftestOk ? [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"] : [pf, lp, pidf])) { if (existsSync(f)) { try { rmSync(f, { force: true }); } catch { /* ignore */ } } }
    }
    // 收尾清扫：自检窗结束后同样不许留下错误窗。
    await closeOrphanTerminals();
    process.exitCode = selftestOk ? 0 : 1;
    return;
  }
  if (mode === '--verify-run') {
    const id=process.argv[3]||process.env.ORCH_RUN_ID;
    process.exitCode=verifyRun(WORKSPACE,id,process.env.ORCH_ACCEPTANCE_FILE,{override:acceptanceOverride()})?0:1;return;
  }
  if (['--run-windows','--visible','--run','--exec','--headless','--resume-run'].includes(mode)) {
    const resume=mode==='--resume-run';
    const request=resume?'':process.argv.slice(bareRequest?2:3).join(' ');
    if(resume)process.env.ORCH_RUN_ID=process.argv[3]||process.env.ORCH_RUN_ID;
    if(!resume&&!request)throw new Error('Execution needs a request');
    if(isOrchestratorSelfMod(request)){console.log(JSON.stringify({mode:'inline',reason:'Modify the orchestrator in the initiating conversation before opening windows'}));return;}
    if(!resume&&await classifyExecutionMode(request)==='inline'){console.log(JSON.stringify({mode:'inline',reason:'Read-only analysis'}));return;}
    if(!checkDiskSpace()) {process.exitCode=1;return;}
    // 容量模式：dynamic 用运行时内存预算（规划期同层合并 + 开窗前复检 + 暂缓/硬跑），
    // formula 保留旧的"机器内存/2000"公式。dynamic 下 capacity 只是并发上限的安全边界。
    const budget=budgetSettings();
    const capacity=budget.mode==='dynamic'?64:computeMaxWindows(os.totalmem() / 1024 ** 2);
    if(capacity<1)throw new Error('Insufficient memory for an execution block');
    // 每窗成本：优先用滚动修正的历史实测值（越跑越准），没有历史样本时用默认 400MB。
    const memoryBudget=budget.mode==='dynamic'?(()=>{const stateFile=budgetStateFile(STATE_DIR);const state=loadBudgetState(stateFile);const windowCostMB=state.samples>0?Math.max(budget.windowCostMB,state.windowCostMB):budget.windowCostMB;const headroom=firstRunHeadroom(state.samples,budget.headroom);console.log(`[orchestrator] memory budget: floor=${budget.floorMB}MB windowCost=${windowCostMB}MB headroom=x${headroom} (samples ${state.samples})`);return {mode:'dynamic',floorMB:budget.floorMB,windowCostMB,stateFile,samples:state.samples,headroom};})():undefined;
    let savedMode;
    if(resume){
      const id=process.env.ORCH_RUN_ID;
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(id||''))throw new Error('Invalid run ID');
      savedMode=JSON.parse(readFileSync(path.join(WORKSPACE,'temp','orchestrator','runs',id,'summary.json'),'utf8')).executionMode;
    }
    const executionMode=resolveExecutionMode(mode,process.env,savedMode);
    if(AGENT.agent!=='codex'&&executionMode==='headless')throw new Error('Headless executor requires Codex');
    // 单任务请求不在编排范围内：编排的价值是并发，单任务直接交给 Codex 普通执行。
    if(!resume&&memoryBudget){
      const preplan=await decomposeSafely(request,capacity);
      const plannedTasks=(preplan||[]).reduce((n,block)=>n+(block.tasks?.length||0),0);
      if((preplan||[]).length===1&&plannedTasks===1){
        console.log(JSON.stringify({status:'out-of-scope',reason:'单任务请求：编排不带来并发收益，请直接用 Codex 执行该任务',tasks:1}));
        return;
      }
    }
    armEnforcement();
    await cleanStaleWindows();
    cleanStaleTransients();
    const executor=executionMode==='headless'?createHeadlessHooks({cli:CODEX,args:buildExecArgs(AGENT_ARGS_LIST),workspace:WORKSPACE,timeoutMs:POLL_TIMEOUT_MS}):{
      launcher:writeInteractiveLauncher,
      spawn:(...args)=>spawnWindowWithRetry(...args,true),readPid:readPidFile,
      session:AGENT.agent==='pi'?async(_token,_timeout,rf)=>rf:waitForSessionFile,
      wait:AGENT.agent==='pi'?async(_session,timeout,rf,_token,pidf)=>waitPiResult(rf,timeout,pidf):waitTaskComplete,exitCode:readExitCode,
      close:closeWindowByPid,
      cleanup:la=>{for(const f of [la.lp,la.pf,la.pidf,la.rf,la.pidf+'.self-closed',la.rf+'.self-closed'])try{rmSync(f,{force:true});}catch{}}
    };
    const onEvent=event=>{
      if(process.env.ORCH_STATUS_FORMAT==='json')console.log(JSON.stringify(event));
      else if(process.stdout.isTTY){process.stdout.write('\x1b[2J\x1b[H');console.log(renderRunStatus(event));}
      else console.log(`[status] ${event.type} | TodoList: ${(event.todoList||[]).map(t=>t.id+':'+t.status).join(' ')} | Execution: ${(event.executionStatus||[]).map(b=>b.block+':'+b.mode+':'+b.status).join(' ')}`);
    };
    // 运行期间每 30 秒扫一次死窗：长任务途中也不让"代码 1"窗口一直挂在屏幕上。
    const runSweepTimer=setInterval(()=>{closeOrphanTerminals().catch(()=>{});},30000);
    const result=await runWindows(request,{
      plan:decomposeSafely,compact:capPlanBlocks,infer:inferTargetKeys,prompt:buildBlockPrompt,...executor,
      register:r=>updateWindows(ws=>[...ws,{...r,mode:executionMode}]),commit:commitReservation,unregister:cancelReservation,
    },{workspace:WORKSPACE,capacity,resume,executionMode,onEvent,agent:AGENT.agent,runId:process.env.ORCH_RUN_ID,acceptanceFile:process.env.ORCH_ACCEPTANCE_FILE,acceptanceOverride:acceptanceOverride(),timeoutMs:POLL_TIMEOUT_MS,auth:readAuthPrompt(),memoryBudget});
    // 收尾再扫一次并停表（Windows Terminal 会把非 0 退出的面板留在屏幕上）。
    clearInterval(runSweepTimer);
    await closeOrphanTerminals();
    process.exitCode=result.success?0:1;return;
  }

  if (mode === "--status") {
    if(process.env.ORCH_RUN_ID||process.argv.includes('--watch')){
      const {main:statusMain}=await import('../status.mjs');
      await statusMain([...process.argv.slice(3),'--workspace',WORKSPACE]);return;
    }
    showStatus(process.argv.includes("--readonly"));
    return;
  }
  if(mode?.startsWith('--')&&mode!=='--help')throw new Error('Unknown mode: '+mode);
  console.log(
    "Usage:\n" +
      "  node orchestrate-sdk.mjs --plan \"<request>\"\n" +
      "  node orchestrate-sdk.mjs --run  \"<request>\"\n" +
      "  node orchestrate-sdk.mjs --exec \"<request>\"  (default: headless)\n" +
      "  node orchestrate-sdk.mjs --run-windows \"<request>\"\n" +
      "  node orchestrate-sdk.mjs --status --run-id <id> --watch\n" +
      "  node orchestrate-sdk.mjs --spawn <title> \"<prompt or .md>\"",
  );
}
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((e) => {
  console.error("[orchestrator] FATAL: " + e.message);
  process.exitCode = 1;
});
export { findOwnedTurn, waitForSessionFile, classifyBlockComplexity, classifyExecutionMode, appendModelEffortArgs, genericProjectSplit, trySingleBlock, conflictByKeys, loadCachedDecompose, buildBlocksFromTasks, resolveHints, extractTasks, classifyPrompt, buildBlockPrompt, levelWaves, decomposeHash, checkDiskSpace, readPidFile, pidAliveCheck, closeWindowByPid, windowGenuinelyPopped, extractResult, extractUsage, readReportFromResult, sessionDir, writeInteractiveLauncher, staleTransientFiles, pidFileOfTransient, tryReserveWindow, commitReservation, cancelReservation, withRegistryLock, computeMaxWindows, blockKeys, keysOverlap, scanTaskComplete, waitTaskComplete, __setOrchHooks, isOrchestratorSelfMod, resolveCodexHome, isCapacityError, capacityRetryPolicy, isProviderQuotaError, rolloutQuotaError };
