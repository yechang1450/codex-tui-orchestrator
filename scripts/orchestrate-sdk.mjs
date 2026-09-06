#!/usr/bin/env node
/**
 * codex-TUI-orchestrator — split a multi-part request into safe parallel blocks.
 *
 * Classification axis is "would running two tasks AT THE SAME TIME break something?"
 *   - YES  -> linked  -> ONE block, strictly serialized (a queue), one window/thread.
 *   - NO   -> independent -> its OWN block, run in parallel with the others.
 *
 * Modes:
 *   --plan "<request>"      : decompose only (read-only), print {blocks: [...]}.
 *   --run-windows "<request>" : THE engine for real executions. Decompose (read-only) + execute.
 *                             Independent blocks -> own real visible window, run in PARALLEL;
 *                             linked blocks -> ONE window, serialized. Each window auto-closes when
 *                             its task finishes; results aggregated to temp/win-summary.json.
 *                             Conflicts with already-running windows are locked (not spawned).
 *   --run  "<request>"      : decompose + execute via the Codex SDK threads (reliable, headless,
 *                             streams structured events, auto-retries a failed block once,
 *                             writes temp/win-summary.json with per-block results). For pure
 *                             automation only -- AGENTS.md forbids headless --run for real changes.
 *   --spawn <title> <md>    : open ONE real visible agent-interactive window that runs the given
 *                             prompt/`prompt file`, with a real popup terminal (cmd /c start).
 *                             Best for when you want to WATCH a specific task.
 *
 * Configuration (all optional, env-first with sensible defaults):
 *   WORKSPACE_DIR  (default: process.cwd())  — auto-detected workspace root for the user.
 *   CODEX_HOME     (default: ~/.codex)        — 权威 Codex 家目录；跨用户/设备/宿主适配点。
 *   ORCH_STATE_DIR (default: $CODEX_HOME/orchestrator) — 本插件的稳定运行/状态目录（registry/锁 等）。
 *   ORCH_SESSION_DIR (default: $CODEX_HOME/sessions)   — 会话 rollout 目录。
 *   ORCH_SUPERPOWERS_CACHE_DIR (optional)      — 覆盖 superpowers 插件缓存目录（不同宿主/市场路径适配）。
 *   ORCH_AGENT     — host identity; only Codex adapter is implemented. No fallback.
 *   CODEX_EXE      (default: auto-detect from PATH or a common user install).
 *   PYTHON         (default: `python`; prepended to the spawned window PATH).
 *   ORCH_MODEL     — optional explicit override; otherwise CLI configuration.
 *   ORCH_EFFORT    — optional explicit override; otherwise CLI configuration.
 *
 * 通用化设计：本插件对【不同 Windows 设备 / 不同用户名 / 不同 agent】自适应——
 *   ① 所有敏感路径都走 CODEX_HOME|ORCH_STATE_DIR|ORCH_SESSION_DIR（可用环境变量覆盖），绝不硬编码 "C:\Users\<user>\.codex"；
 *   ② Host identity and native executable are verified; missing/unsupported hosts fail closed.
 *   ③ 任何外部宿主（GUI/CLI/别的 agent）只需在进程环境注入上述可变配置即可运行，无需改本插件源码。
 *
 * Encoding: every text read/write is explicit UTF-8. The window launcher sets
 *   [Console]::OutputEncoding/$OutputEncoding = UTF-8 and reads prompts with -Encoding UTF8,
 *   so Chinese never becomes mojibake on a Chinese-locale Windows (the old GBK trap).
 *
 * ============================================================================
 * 【铁律 · 一次性并发执行】一旦发起 --run-windows 真实执行：
 *   1) 必须在这一轮里把【全部】可执行任务一次性交给 SDK 拆块并【全部】拉起：
 *      independent 并行、linked 串行，同一批里的所有窗同时运行。
 *   2) 发起后【中途不停、不问、不折返、不挑几项、不"下一步再说"、不逐条串行】。
 *   3) 一直轮询到【全部】块都有终态（done/failed/preflight-failed/locked/unfinished），
 *      收齐全部汇报结果才写 win-summary.json 并结束，绝不在"第一扇窗先跑完"就提前收尾。
 *   4) 本窗内【禁止】再调用 --run-windows/--spawn/另开新窗，杜绝 GUI→TUI→TUI 嵌套；
 *      窗自身即被授权执行环境，直接执行并汇报，不以"需要授权/要我修吗/"为由暂停。
 * ============================================================================
 */
import { Codex } from "@openai/codex-sdk";
import { spawn, spawnSync } from "node:child_process";
import { resolveAgent, launchArgs } from "./agent.mjs";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync, statfsSync, openSync, readSync, closeSync, renameSync } from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
// ---------------------------------------------------------------------------
// Config (env-first, portable)
// ---------------------------------------------------------------------------
// 通用化：仅把 ~/.codex 当作【缺省回退】，真正权威是 CODEX_HOME 环境变量。
// 这样同一份 orchestrator 可以跑在【不同用户 / 不同设备 / 不同 agent】上——
// 只要外部（用户/调用方/宿主 agent）设置了 CODEX_HOME（或 ORCH_STATE_DIR / ORCH_SESSION_DIR 等），
// 就不再依赖 hard-coded 的 "C:\Users\<user>\.codex"，避免跨用户/跨宿主失效。
function resolveCodexHome() {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) return process.env.CODEX_HOME.trim().replace(/[\\/]+$/, "");
  return path.join(os.homedir(), ".codex");
}
const CODEX_HOME = resolveCodexHome();
// 通用工作区解析：env WORKSPACE_DIR 优先，否则当前目录。不依赖任何平台特定配置（可移植）。
// 判据补充：编排器自身的插件安装/缓存目录绝不能被当成用户工作区——否则 launcher 产物（temp\win-launch-*、
// temp\win-*.result.json*、window-*.pid）会建在会被插件版本升级/重装（cachebuster）整体清掉的路径下，
// 运行中的窗随后写 .self-closed 时父目录已消失，正是「任务完成却报 [进程已退出，代码为 1] 且窗不自动关」的根因。
function resolveWorkspace() {
  // 显式指定的 WORKSPACE_DIR 始终优先、照用（用户/调用方说了算）。
  if (process.env.WORKSPACE_DIR && process.env.WORKSPACE_DIR.trim()) return process.env.WORKSPACE_DIR.trim();
  const here = process.cwd();
  // 编排器插件自身库：源码安装目录（plugins/codex-TUI-orchestrator）与运行时缓存目录
  // （plugins/cache/personal/codex-TUI-orchestrator/<ver>）。两者都可能在升级/重装时被整目录清掉。
  const h = path.resolve(here).replace(/[\\/]+$/, "");
  const isPluginTree =
    /(?:[\\/]plugins[\\/]cache[\\/]personal[\\/]codex-TUI-orchestrator(?:[\\/]|$))/i.test(h) ||
    /(?:[\\/]plugins[\\/]codex-TUI-orchestrator(?:[\\/]|$))/i.test(h);
  if (isPluginTree) {
    // 拒绝把插件自身目录当工作区：落地到稳定运行目录（STATE_DIR 同级 family home），绝不被插件升级清掉。
    const stable = path.join(CODEX_HOME, "orchestrator");
    console.warn("[orchestrator] WARN: resolved workspace '" + here + "' is the orchestrator plugin's own tree; ignoring it for launcher/temp artifacts and using stable '" + stable + "' instead.");
    return stable;
  }
  return here;
}

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
  return "\n\n（已获授权推进并执行。本窗为 codex-TUI-orchestrator 授权的真实执行窗：直接在本窗内用自己的工具干活，不要再发起 --run-windows、不要另开新窗、不要以「需要授权/要我修吗」等为由暂停或询问。执行结束再输出结束标记。）";
}

const WORKSPACE = resolveWorkspace();
const AGENT = resolveAgent();
const CODEX = AGENT.config.bin;
// PowerShell 单引号字符串内嵌路径：把 ' 转义成 ''，避免路径含引号时破坏脚本/注入。
const WORKSPACE_Q = WORKSPACE.replace(/'/g, "''");
const CODEX_Q = CODEX.replace(/'/g, "''");
const PY = process.env.PYTHON || "python";
// Leave model selection to the host CLI unless explicitly overridden.
const MODEL = process.env.ORCH_MODEL || undefined;
const EFFORT = process.env.ORCH_EFFORT || undefined;
// A caller may pass its effective permissions; never elevate implicitly.
const SANDBOX = process.env.ORCH_SANDBOX || "workspace-write";
const APPROVAL = process.env.ORCH_APPROVAL || "on-request";
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
  // Explicit overrides only; otherwise the selected CLI owns configuration.
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
const AGENT_ARGS_EXEC = (() => {
  const raw = launchArgs(AGENT.config, { cwd: WORKSPACE, approval: APPROVAL, sandbox: SANDBOX });
  const cleaned = [];
  for (let i = 0; i < raw.length; i++) { if (raw[i] === "-a") { i++; continue; } cleaned.push(raw[i]); }
  return ["exec", ...appendModelEffortArgs(cleaned, AGENT.config)].map((aa) => "'" + String(aa).replace(/'/g, "''") + "'").join(" ");
})();
const AGENT_ARGS_LIST = appendModelEffortArgs(launchArgs(AGENT.config, { cwd: WORKSPACE, approval: APPROVAL, sandbox: SANDBOX }), AGENT.config);
// AGENT_ARGS 保留给老式拼接（AGENT_ARGS_EXEC / 兜底），主 launcher 改用 buildPsArrayLit 生成的数组字面量。
const AGENT_ARGS = AGENT_ARGS_LIST.map((aa) => "'" + String(aa).replace(/'/g, "''") + "'").join(" ");
const TMP = path.join(WORKSPACE, "temp");
// plugin-owned runtime state lives in a stable family home, not workspace temp (override via ORCH_STATE_DIR).
const STATE_DIR = process.env.ORCH_STATE_DIR || path.join(CODEX_HOME, "orchestrator");
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
// Default = Windows Terminal. ORCH_TUI=wt is confirmed EXPLICITLY below (the env var
// defaults to "wt"), so the visible agent TUI window is hosted in Windows Terminal
// whenever wt.exe is present; conhost is only the runtime fallback when wt.exe is missing.
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
const TUI_MODE = String(process.env.ORCH_TUI).toLowerCase();
const codex = new Codex({ codexPathOverride: CODEX });
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
    "project(80|81|82|83，只在请求里明确写了才填，否则填 null)、" +
    "hint(该任务涉及模块/资源关键词，如 会员管理、商品、订单)、" +
    "conflict_hints(会碰到的资源字符串数组，如 [\"db:订单\",\"dir:管理端\"]，无则 [])、" +
    "depends_on(依赖的其它任务 id 数组，无则 [])、" +
    "feasible(是否可行，布尔)、already_done(是否已达成无需做，布尔)。" +
    "规则：不遗漏任何任务；不合并；请求没写项目号时 project 必须为 null，交给模块映射校正，不许猜；" +
    "禁止调用任何工具/读文件/搜索/联网；只输出一个 JSON 对象 {\"tasks\":[...]}，能被 JSON.parse 直接解析，不要 Markdown 代码块、不要任何前后缀文字。" +
    hintText + "\n请求：" + request
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
    if (t.already_done === true || t.feasible === false) continue; // 已达成/不可行 -> 跳过
    const summary = String(t.summary || t.prompt || "").trim();
    if (!summary) continue;
    let p = String(t.project || "").replace(/[^0-9]/g, "");
    if (!p) for (const [mod, pn] of Object.entries(modToProj)) { if (summary.includes(mod)) { p = String(pn).replace(/[^0-9]/g, ""); break; } }
    const item = { id: String(t.id || "t" + (byProjKeyCount(byProj) + toolItems.length + unkItems.length + 1)), summary, kind: String(t.kind || ""), depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : [], conflict_hints: Array.isArray(t.conflict_hints) ? t.conflict_hints.map(String) : [] };
    if (p) (byProj["proj-" + p] = byProj["proj-" + p] || []).push(item);
    else if (item.kind === "tool" || item.kind === "system") toolItems.push(item);
    else unkItems.push(item);
  }
  // fold 规则：某工具/系统任务命中 fold 关键字 -> 折进指定项目（作为该项目任务一环，不再独立并行，避免与项目竞态）。
  for (const key of Object.keys(foldRules)) {
    const targets = (foldRules[key] || []).map((x) => String(x).replace(/[^0-9]/g, ""));
    for (const list of [toolItems, unkItems]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].summary.includes(key)) {
          const tt = list.splice(i, 1)[0];
          for (const pn of targets) {
            (byProj["proj-" + pn] = byProj["proj-" + pn] || []).push({ id: tt.id + "-fold" + pn, summary: tt.summary, kind: "project", depends_on: [], conflict_hints: [] });
          }
        }
      }
    }
  }
  const blocks = [];
  const blockItems = [];   // 与 blocks 平行的源 item 数组，用于依赖映射
  for (const [title, arr] of Object.entries(byProj)) {
    blocks.push({ type: "independent", title, dependsOn: [], conflictKeys: ["dir:" + title], tasks: [{ id: "t" + (blocks.length + 1), title, prompt: "仅处理项目 " + title + "。任务：" + arr.map((a) => a.summary).join("；") + "。不要处理其它项目编号。" }] });
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
          if (j !== i && blockItems[j].some((x) => x.id === depId)) { deps.add(blocks[j].title); break; }
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
async function decomposeSafely(request) {
  const hints = resolveHints(); // hints 参与缓存键（moduleToProj/foldRules/tail），防跨项目映射撞缓存
  // 0) 缓存优先：相同请求+相同 hints 的拆块结果永不自动失效（仅 --clear-cache 或删除缓存文件才重置），
  //    命中直接复用 -> 越用越快（与下方 loadDecomposeCache 的“永不自动失效”实现保持一致）。
  const cached = loadCachedDecompose(request, hints);
  if (cached && Array.isArray(cached.blocks) && cached.blocks.length) {
    console.log("[orchestrator] decompose cache HIT -> " + cached.blocks.map((b) => b.title).join(", "));
    return normalizePlan(cached.blocks);
  }
  // 1) 通用确定性启发（非硬编码项目路径）：请求里出现多个不同项目目录 -> 单独拆块，秒级返回并写缓存。
  const det = genericProjectSplit(request);
  if (det && Array.isArray(det.blocks) && det.blocks.length) {
    console.log("[orchestrator] generic project split -> " + det.blocks.map((b) => b.title).join(", "));
    saveDecompose(request, det.blocks, hints);
    return normalizePlan(det.blocks);
  }
  // 1.5) 单任务快速路径（通用，非写死路径）：明确"单动作"请求 -> 单一窗口，跳过 LLM 拆块，秒级+写缓存。
  const sb = trySingleBlock(request);
  if (sb && Array.isArray(sb.blocks) && sb.blocks.length) {
    console.log("[orchestrator] single-block fast path -> " + sb.blocks[0].title);
    saveDecompose(request, sb.blocks, hints);
    return normalizePlan(sb.blocks);
  }
  // 2) 两段式：LLM 定性（扁平任务清单）→ 确定性分块引擎。失败/超时则重试。
  // hints 已上移到函数开头解析（参与缓存键）。
  const attempts = Math.max(1, Number(process.env.ORCH_DECOMPOSE_RETRIES || 2));
  let lastErr = "";
  let seenNoJson = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await runThreadPrompt(classifyPrompt(request, hints), { sandboxMode: "read-only" });
      let plan;
      try {
        const tasks = extractTasks(res.final || "");
        plan = buildBlocksFromTasks(tasks, hints);
        if (!plan || !plan.length) throw new Error("plan.blocks empty");
      } catch (e2) {
        if (/no JSON in classify output|no tasks array|plan\.blocks empty/.test(e2 && e2.message ? e2.message : String(e2))) seenNoJson = true;
        if (i === attempts - 1) throw e2;
        lastErr = e2 && e2.message ? e2.message : String(e2);
        continue;
      }
      if (plan && plan.length) { saveDecompose(request, plan, hints); return normalizePlan(plan); }
      lastErr = lastErr || "(extracted empty plan)";
      if (i === attempts - 1) throw new Error(lastErr);
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
  }
  console.warn("[orchestrator] decompose LLM failed after " + attempts + " attempt(s): " + lastErr +
    (seenNoJson ? " (no valid JSON)" : "") + " -> fallback to single serial block (autosafe detect).");
  return normalizePlan(fallbackPlan(request).blocks);
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
function levelWaves(recs) {
  const keyByTitle = new Map();
  for (const r of recs) { keyByTitle.set(r.key, r.key); keyByTitle.set(r.title, r.key); keyByTitle.set(String((r.b && r.b.title) || ""), r.key); }
  for (const r of recs) {
    const clean = [];
    for (const d of (Array.isArray(r.dependsOn) ? r.dependsOn : [])) {
      const k = keyByTitle.get(String(d)) || keyByTitle.get(d);
      if (k && k !== r.key && !clean.includes(k)) clean.push(k);
    }
    r.dependsOn = clean;
  }
  const waves = [];
  const remaining = recs.slice();
  const doneKeys = new Set();
  let guard = 0;
  while (remaining.length && guard < 200) {
    guard++;
    const ready = remaining.filter((r) => r.dependsOn.every((d) => doneKeys.has(d)));
    if (!ready.length) { waves.push(remaining.slice()); remaining.length = 0; break; }
    waves.push(ready);
    for (const r of ready) { doneKeys.add(r.key); remaining.splice(remaining.indexOf(r), 1); }
  }
  return waves;
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
  return crypto.createHash("sha1").update(String(request || "") + "|" + hintsKey(hints)).digest("hex");
}
function loadDecomposeCache() {
  try {
    if (existsSync(DECOMPOSE_CACHE)) {
      const j = JSON.parse(readFileSync(DECOMPOSE_CACHE, "utf8").replace(/^\uFEFF/, ""));
      if (j && j.entries && typeof j.entries === "object") return j; // 永不自动失效（用户 --clear-cache 才清）
    }
  } catch { /* corrupted -> rebuild */ }
  return { entries: {} };
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
  const h = decomposeHash(request, hints);
  const j = loadDecomposeCache();
  j.entries[h] = { createdAt: Date.now(), blocks: plan };
  saveDecomposeCache(j);
}
// Generic deterministic aid (NOT hardcoded to build/80|81|82|83): if the request
// names several distinct existing project-like dirs, split them into independent
// windows. Returns null when ambiguous, so the LLM handles the rest.
function genericProjectSplit(request) {
  // 保守、确定性拆分（权威修复）：仅当请求能被可靠切成"每个编号各有一个专属句子"时才拆，
  // 且每个块 prompt 只针对该项目（绝不整段重复）。混合/歧义请求返回 null 交给 LLM 语义拆块。
  const dirs = new Set();
  const re = /(?:^|[\s,/\\])(?:build|proj|project|app|src|workspace|web|site|game)[\s/\\]+(\d{1,3})(?=\D|$)/gi;
  let m;
  while ((m = re.exec(request))) { const n = m[1]; if (n) dirs.add("proj-" + n); }
  // fallback: bare standalone 2-digit project numbers (e.g. "给80的前端", "81登录页")
  const bareRe = /(?<![0-9])(\d{2})(?![0-9])/g;
  while ((m = bareRe.exec(request))) { const n = m[1]; if (n) dirs.add("proj-" + n); }
  if (dirs.size < 2) return null;
  const sentences = splitSentences(request);
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
  // 无正则的确定匹配：检查句子是否含 "build\N" / "build/N" / 关键词N，避免转义坑
  return s.indexOf("build\\" + n) !== -1 || s.indexOf("build/" + n) !== -1 || new RegExp("(?<![0-9])" + n + "(?![0-9])", "i").test(s);
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
// is additionally hard-gated inside this file (needs ORCH_ALLOW_HEADLESS=1). codex-TUI-orchestrator-force.mjs reads
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
    // 唯一窗口名 -> 供"物理关窗"兜底精确定位（见 physicallyCloseWindow），绝不误动它窗/用户窗口。
    const bn = path.basename(String(lp || ""));
    const winS = bn.replace(/^win-launch-/, "").replace(/\.ps1$/, "");
    const windowName = "win-" + (winS || "x");
    const p = spawn(WT_EXE, ["-w", windowName, "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", lp], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      shell: false,
    });
    p.unref();
    console.log("spawned visible codex TUI (Windows Terminal): " + title + " (window=" + windowName + ")");
    return;
  }
  // conhost fallback: cmd /c start "" powershell -File <launcher>  ->  NEW visible console.
  const safeTitle = String(title || "codex-task").replace(/[^A-Za-z0-9_\-:. ]/g, "").replace(/"/g, ""); // 防控制字符/cmd 注入
  const p = spawn("cmd.exe", ["/c", "start", `"${safeTitle}"`, "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", lp], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: false,
  });
  p.unref();
  console.log("spawned visible codex TUI: " + title);
}
// 弹窗后精准检测：pid 文件存在 + launcher(WT pane 宿主)进程存活 => 窗口真弹出（见 windowGenuinelyPopped）。
// 失败重试（上限 maxRetry，默认 3），仍失败返回 false（由调用方标记 popup-failed 并汇报）。
function windowGenuinelyPopped(pidf, token) {
  // 弹窗精准判定 = pid 文件存在 + launcher 进程真实存活（launcher 是 Windows Terminal pane 宿主进程，存活即窗口已弹出）。
  // 不把 agent 子进程作为必选证据：agent 冷启动(模型 provider)可能很慢，若等它会把"已弹出"误判为未弹出而重复弹窗；agent 未起由回收超时兜底。
  if (!pidf || !existsSync(pidf)) return false;
  const pid = readPidFile(pidf);
  if (!pid) return false;
  if (!pidAliveCheck(pid)) return false;
  return true;
}
async function confirmWindowPopped(pidf, token) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    if (windowGenuinelyPopped(pidf, token)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
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
async function spawnWindowWithRetry(lp, title, pidf, maxRetry = 3, token) {
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    spawnVisibleWindow(lp, title);
    const deadline = Date.now() + 35000;
    let ok = false;
    const t0 = Date.now();
    while (Date.now() < deadline) {
      if (windowGenuinelyPopped(pidf, token)) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (ok) {
      // 加固②：弹窗确认后再等 agent 子进程真正拉起（冷启动），确保父进程随后去等 session rollout 时不会起跑太早。
      await warmupWindow(pidf, token);
      if (attempt > 1 || Date.now() - t0 > 6500) console.log("  [window] popup CONFIRMED (pidf+launcher+codex child) for [" + title + "]");
      return true;
    }
    console.log("  [window] popup NOT confirmed (attempt " + attempt + "/" + maxRetry + ") for [" + title + "]");
  }
  console.log("  !! [window] popup FAILED after " + maxRetry + " attempts for [" + title + "]");
  return false;
}
// 失败/未决块自动重试：窗已关但块未完成时，用全新 token 重新弹窗再跑，避免“提前结束轮询/留计划草稿”。
// 返回 { status, exitCode, result }；只有抓到本块自己的完成标记才算 done。
async function retryBlock(rec, rid, auth, maxRetry, closeDelayMs) {
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    const tk = rec.key + "-" + rid + "-" + Math.random().toString(36).slice(2, 8);
    const body = auth + buildBlockPrompt(blockBody(rec.b), tk);
    const { lp, pidf, pf, rf } = writeInteractiveLauncher(rec.key, body, rid);
    // 重试窗同样走原子占位：让其它编排进程能看见/锁定它，也保证本窗满足 enforcement 的“活注册窗”判定。
    const claim = { id: "claim-" + rid + "-" + rec.key + "-" + Math.random().toString(36).slice(2, 8), title: rec.title, keys: rec.keys, pidFile: pidf, pid: 0, locked: false, pending: true, reservedAt: Date.now() };
    const claimBlocker = tryReserveWindow(claim);
    if (claimBlocker) {
      console.log("  !! [retry " + rec.key + " att" + attempt + "] atomic claim blocked by [" + claimBlocker + "].");
      for (const f of [pf, lp]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      continue;
    }
    const popped = await spawnWindowWithRetry(lp, rec.title, pidf, 3, tk);
    if (!popped) {
      cancelReservation(claim.id);
      for (const f of [pf, lp, rf, pidf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      console.log("  !! [retry " + rec.key + " att" + attempt + "] popup failed; reservation cancelled.");
      continue;
    }
    commitReservation(claim.id, readPidFile(pidf) || 0);
    const matchKey = "【本块唯一标识】" + tk;
    const sf = await waitForSessionFile(matchKey, 90000, rf);
    let res = { done: false, text: "" };
    if (sf) res = await waitTaskComplete(sf, POLL_TIMEOUT_MS, rf, matchKey, pidf);
    else if (existsSync(rf)) { const c = readExitCode(rf); res = { done: true, text: "(launcher exited code " + (c === null ? "?" : c) + "; no session rollout matched)", exitCode: c }; }
    // 执行结束判定（用户方案：done=做完了，不等同于成功）：res.done 即收，是否达标由主控核对真实落盘状态。
    let text = res.text || "";
    if (!text || /no session rollout matched|no result captured|launcher exited/.test(text)) {
      try { if (sf) text = extractResult(sf).text || ""; } catch { /* ignore */ }
    }
    if (res.done) {
      console.log("  [retry " + rec.key + " att" + attempt + "] execution ended -> closing");
      await new Promise((x) => setTimeout(x, closeDelayMs));
      await closeWindow(pidf);
      cancelReservation(claim.id);
      for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      return { status: "done", exitCode: res.exitCode ?? null, result: (text && text.trim() ? text.trim() : "(窗内 codex 已执行结束并自动关闭；请按任务提示词核对真实落盘状态)").slice(0, 2000) };
    }
    console.log("  !! [retry " + rec.key + " att" + attempt + "] not own completion (text=" + String(text).slice(0, 50) + ")");
    // 未捕获到完成汇报也一律收窗并取消占位，杜绝“重试窗留在屏幕上/重复弹同键窗”的泄漏。
    await closeWindow(pidf);
    cancelReservation(claim.id);
    for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
  }
  return { status: "uncaptured", exitCode: null, result: "(重试后仍未捕获本块自己完成汇报)" };
}
// Interactive-TUI launcher. The interactive `codex "prompt"` window does not exit on its own; a
// background watchdog in the launcher scans THIS window session rollout: as soon as the LAST assistant
// message containing this block token + 完成 appears, it writes the strong `.self-closed` marker and
// kills the full codex descendant tree (hit-to-close, no stability wait), so the launcher runs `exit 0` and the
// pane auto-closes. `Write-Result` then uses `Get-LastReport` to persist the window last assistant output
// into `win-<s>.result.json` (no token/完成 required), so even a report lacking the token is captured.
// The launcher ALWAYS reaches `exit 0` (a non-zero exit is the "process exited, code X" stuck-pane bug).
// Encoding + Windows Terminal hosting set here (see ORCH_TUI and the chcp 65001 + InputEncoding UTF-8) for CJK/IME.

// Shared PowerShell descendant-kill routine used by BOTH the launcher watchdog and closeWindowByPid:
// snapshot Win32_Process once, then walk the ParentProcessId chain starting at the launcher ($root) to
// collect EVERY descendant, and kill each PID individually (no reliance on taskkill /T reaching the
// whole tree). The launcher itself is never in the walk's kill set; $PID (the watchdog's own job
// process) is always excluded; when the list is empty (codex already exited on its own) nothing is
// killed, which preserves the "never force-kill launcher / skip if codex exited" safety boundaries.
function psKillDescendantsLines() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "$victims = New-Object 'System.Collections.Generic.List[int]'",
    "$queue = New-Object 'System.Collections.Generic.Queue[int]'",
    "$seen = @{}",
    "$seen[$root] = $true",
    "$queue.Enqueue($root)",
    "while ($queue.Count -gt 0) {",
    "  $cur = $queue.Dequeue()",
    "  foreach ($pr in $all) {",
    "    if ($pr.ProcessId -ne $PID -and $pr.ParentProcessId -eq $cur -and -not $seen.ContainsKey($pr.ProcessId)) {",
    "      $seen[$pr.ProcessId] = $true",
    "      $victims.Add($pr.ProcessId)",
    "      $queue.Enqueue($pr.ProcessId)",
    "    }",
    "  }",
    "}",
    "foreach ($v in $victims) { taskkill /PID $v /F 2>$null | Out-Null }",
    "Write-Output $victims.Count",
  ];
}

// 内存 → 最大并发 TUI 窗数：n GB 内存 -> round(n * 1024 / 2000) 台并发（四舍五入取整，约等于 n/2，随内存线性扩展、无封顶），
// 内存越大并发越多；下限由调用方以 <4G 判定为不支持。为可测试而独立成函数。
function computeMaxWindows(memGb) {
  return Math.round((memGb * 1024) / 2000);
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
    /codex-TUI-orchestrator|orchestrator|orchestrate|编排|调度器|调度窗|TUI 窗|TUI窗|并发编排/i.test(t) ||
    /scripts\/?orchestrate|orchestrate-sdk\.mjs|\.codex.*\/?orchestrat/i.test(t);
  if (!selfRef) return false;
  const modifyIntent =
    /(修复|修改|改|升级|加固|优化|调整|重构|补|加固|收紧|fix|edit|update|build|harden|refactor|improve|rework)/i.test(t);
  return modifyIntent;
}

function writeInteractiveLauncher(title, prompt, sfx) {
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
  const tokenMatch = String(prompt || "").match(/【本块唯一标识】\s*([A-Za-z0-9][A-Za-z0-9_\-]*)/);
  const token = tokenMatch ? String(tokenMatch[1]) : "";
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
    "chcp 65001 | Out-Null",
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
    "function Get-LastReport {",
    "  param([string]$dir,[string]$tok)",
    "  $res = ''",
    "  $files = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-30) }",
    "  foreach ($f in $files) {",
    "    $raw = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue",
    "    if ($raw -and $raw.Contains($tok)) {",
    "      foreach ($line in ($raw -split \"`n\")) {",
    "        try {",
    "          $o = $line | ConvertFrom-Json -ErrorAction SilentlyContinue",
    "          $p = $o.payload",
    "          $msg = ''",
    "          if ($p -and $p.type -eq 'agent_message' -and $p.message) { $msg = $p.message }",
    "          elseif ($o.type -eq 'response_item' -and $p -and $p.type -eq 'message' -and $p.role -eq 'assistant' -and $p.content) { $msg = (($p.content | ForEach-Object { if ($_.text) { $_.text } elseif ($_.content) { $_.content } elseif ($_.value) { $_.value } }) -join '') }",
    "          if ($msg -and $msg.Trim()) { $res = $msg }",
    "        } catch { }",
    "      }",
    "    }",
    "  }",
    "  return $res",
    "}",
    "function Write-Result {",
    "  param([int]$code)",
    "  try {",
    "    # 执行结束判定（用户方案：done=做完了，不等同于成功）：agent 已退出即视为本窗执行结束，写 result + .self-closed 完成标记。",
    "    # 是否真的达成 prompt 预期，由主控关窗后去核对真实落盘状态；这里不因其未输出长篇汇报就判定未完成。",
    "    $dir = $env:ORCH_SDIR",
    "    $report = Get-LastReport -dir $dir -tok $token",
    "    $line = '__EXIT__=' + $code",
    "    $json = '{\"__EXIT__\":' + $code + ',\"__DONE__\":true,\"__REPORT__\":' + (ConvertTo-Json $report -Compress) + ',\"ts\":\"' + (Get-Date -Format o) + '\"}'",
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
    "  param($token, $rootPid, $resultFile)",
    "  if ([string]::IsNullOrWhiteSpace($token)) { return }",
    "  # 独立 runspace：本 job 看不到主作用域的 Ensure-ResultDir，需在此自行复刻（与主作用域实现一致）。",
    "  function Ensure-ResultDir {",
    "    try { $d = Split-Path -Parent $resultFile; if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } } catch { }",
    "  }",
    "  function Stop-LauncherDescendants {",
    "    param([int]$root)",
    ...psKillDescendantsLines().map((ln) => "    " + ln),
    "  }",
    "  # 加固：连续重扫并递归杀净，直到 launcher 不再有任何后代（codex 若在快照后重新生成子进程也一并回收），",
    "  # 绝不因为一次快照遗漏子进程就放过 codex，造成“窗口任务已完成但 codex TUI 仍存活、窗未自动关”。",
    "  function Kill-LauncherTree {",
    "    param([int]$root)",
    "    for ($k = 0; $k -lt 3; $k++) {",
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
    "  $watchdogMaxMin = 45",
    "  try { if ($env:ORCH_WATCHDOG_MAX_MIN) { $watchdogMaxMin = [double]$env:ORCH_WATCHDOG_MAX_MIN } } catch { }",
    "  $deadline = (Get-Date).AddMinutes($watchdogMaxMin)",
    "  while ((Get-Date) -lt $deadline) {",
    "    if (Test-Path -LiteralPath $resultFile) {",
    "      $n = Stop-LauncherDescendants $rootPid",
    "      if ($n -gt 0) { $sawChild = $true }",
    "      # 加固：陈旧/旧块 result 文件可能在 codex 尚未生成后代时误触发提前退出；故仅当确曾观测到本窗 codex",
    "      # 后代（$sawChild）且现已杀净时才结束，并补写 .self-closed 完成标记，避免“任务完成但窗未自动关”。",
    "      if ($n -eq 0 -and $sawChild) { Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { }; exit 0 }",
    "    }",
    "    try {",
    "      $files = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-30) }",
    "      foreach ($f in $files) {",
    "        if ($match) {",
    "          if ($f.FullName -ne $match) { continue }",
    "          try {",
            "            $tail = Get-Content -LiteralPath $f.FullName -Tail 200 -Encoding UTF8 -ErrorAction SilentlyContinue",
            "            # 自动关闭设计 = watchdog 检测到【本块 agent 的完成汇报】(agent_message/assistant 行含本块 token 且含 完成) 才关窗。",
            "            # 计划/中间消息不带“完成”，不会被误关；仅真正的完成汇报触发。稳定~1.5s 后关，确保父进程已抓到汇报。",
    "            # 加固：__ORCH_DONE__ 分支必须同时命中「agent/assistant 消息」，绝不能匹配到被注入的【任务/执行纪律提示词】——",
    "            # 该提示词里原文含 '__ORCH_DONE__ <本窗token>'（教 agent 最后怎么汇报），若不过滤 role/type，watchdog 会",
    "            # 在窗口刚拿到任务 prompt、agent 还没产出任何结果时就把这条『用户消息』误判成完成汇报，随即自关窗、丢任务。",
            "            # 加固：__ORCH_DONE__ 分支必须同时命中「agent/assistant 消息」，绝不能匹配到被注入的【任务/执行纪律提示词】——",
            "            # 该提示词里原文含 '__ORCH_DONE__ <本窗token>'（教 agent 最后怎么汇报），若不过滤 role/type，watchdog 会",
            "            # 在窗口刚拿到任务 prompt、agent 还没产出任何结果时就把这条『用户消息』误判成完成汇报，随即自关窗、丢任务。",
            "            # 层级化：watchdog(爷爷)只认 TUI 窗(儿子)是否完成任务——只要 TUI 窗输出 __ORCH_DONE__ <token> 就认为收尾。",
            "            # watchdog 只认 TUI 窗(儿子)输出 __ORCH_DONE__ <token> 即收尾；不再有任何 SUBAGENTS_DONE 后缀。",
            "            $done = ($tail | Where-Object { ($_ -match 'agent_message|\"role\":\"assistant\"') -and $_.Contains('__ORCH_DONE__') -and $_.Contains($token) } | Select-Object -Last 1)",
    "            if ($done) {",
    "                Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { }",
    "                # 递归杀净 launcher 的全部后代（agent 树）：绝不强杀 launcher 自身；agent 已退出(无后代)则函数直接跳过。",
    "                Kill-LauncherTree $rootPid",
    "                exit 0",
    "            }",
            "            $report = ($tail | Where-Object { ($_ -match 'agent_message|\"role\":\"assistant\"') -and $_.Contains($token) -and $_.Contains('完成') } | Select-Object -Last 1)",
    "            if ($report) {",
    "                # 命中即收窗：rollout 中最后一条含本窗 token+完成 的 assistant 消息即最终汇报（模板要求最终汇报以 token 开头、禁止中途输出未完状态），出现即写强标记并结束，无需等 1.5s 稳定。",
    "                Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { }",
    "                # 同上：递归杀净 launcher 的全部后代（agent 树），绝不强杀 launcher 自身，agent 已退出则自动跳过。",
    "                Kill-LauncherTree $rootPid",
    "                exit 0",
    "            }",
    "            # 兜底：若本窗 rollout 已达到 task_complete，但既无 __ORCH_DONE__ 也无『完成』汇报（如 selftest/纯只读窗），",
    "            # 也立即关窗——否则会落到下方依赖 $sawChild 的陈旧 result 分支，拖到 orchestrator 的 15s 兜底才收窗（慢/易卡）。",
    "            # 仅当该 task_complete 属于【本窗】自己（rollout 含本窗 token）时才触发，绝不误关它窗/未完成任务。",
    "            $tcDone = (($tail | Where-Object { $_ -match 'task_complete' }) -and ($tail | Where-Object { $_.Contains($token) }))",
    "            if ($tcDone) {",
    "                Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { }",
    "                Kill-LauncherTree $rootPid",
    "                exit 0",
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
    "          if ($raw -and $raw.Contains($token)) { $match = $f.FullName; break }",
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
    "} -ArgumentList $token, $PID, $resultFile",
    "$code = 1",
    "try {",
    "  $agentArgs = " + buildPsArrayLit(AGENT_ARGS_LIST) + " + $p",
    "  # 会话级容错：codex 若异常退出(无最终汇报)则在同一窗内自动重跑一次，避免并发时 provider/会话瞬时失败造成无输出；不重复弹窗、不二次执行。",
    "  $attempt = 0",
    "  $rep = ''",
    "  $wdDone = $false",
    "  while ($attempt -lt 2) {",
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
    "    Write-Host ('  [launcher] codex session exited (code=' + $code + ', no report); retry ' + $attempt + '/2 ...')",
    "  }",
    "} catch {",
    "  $code = 1",
    "}",
    // 任务完成判定：只要本窗最终汇报已捕获（$rep 非空），watchdog 会为快速关窗而强杀 agent 子进程使
    // $LASTEXITCODE=1，但那不等于失败。此时统一按完成处理并以 exit 0 干净关闭（Windows Terminal
    // closeOnExit:graceful 只认 exit 0；非零会留下“[进程已退出，代码为 1]”的卡壳窗），结果文件也记录 0。
    // 拿到最终汇报（$rep）或 watchdog 已确认完成（$wdDone）都归零，确保窗必关、绝不留常驻 codex。
    "if ($rep -or $wdDone) { $code = 0 }",
    "if ($attempt -gt 0) { $code = 0 }",
    "if ($rep -or $wdDone) { Ensure-ResultDir; try { Set-Content -LiteralPath ($resultFile + '.self-closed') -Value '1' -Encoding ASCII } catch { /* ignore */ } }",
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
function listRollouts(dir) {
  const res = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) res.push(...listRollouts(p));
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) res.push(p);
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
function rolloutKeys(matchKey) {
  // JSON.stringify 不转义 CJK（输出 raw），但 codex rollout 会把 prompt 的 CJK 存成 \uXXXX 转义，
  // 导致仅凭 raw 匹配会漏。ASCII token 在 raw/转义两种形式中都原样存在，最可靠。
  const escaped = JSON.stringify(matchKey).slice(1, -1);
  const ascii = String(matchKey).replace(/[^\x00-\x7F]/g, "");
  return [escaped, ascii].filter(Boolean);
}
function rolloutHit(text, keys) { return keys.some((k) => text.includes(k)); }
async function waitForSessionFile(matchKey, timeoutMs, exitMarkerFile) {
  const start = Date.now();
  const seen = new Set();
  let lastReset = Date.now();
  // The rollout is JSONL: backslashes (Windows paths) are doubled (`\` -> `\\`) and quotes escaped,
  // so we must match against the JSON-escaped form, not the raw text. The task prompt sits after the
  // (large) AGENTS.md/context block, so we read the whole file (once per new candidate), not just the head.
  const keys = rolloutKeys(matchKey);
  while (Date.now() - start < timeoutMs) {
    // 完成信号优先认窗内自关：result 落盘或窗内 watchdog 写入 .self-closed（即 agent 已报 __ORCH_DONE__）都视为本窗完成，
    // 立即转入回收路径，避免父进程靠 session 文本匹配去等一个可能永远匹配不到的会话（慢速 agent 时长期 HOLDING）。
    if (exitMarkerFile && (existsSync(exitMarkerFile) || existsSync(exitMarkerFile + ".self-closed"))) return null; // codex already exited -> reclaim path
    for (const f of listRollouts(sessionDir())) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        if (rolloutHit(readFileSync(f, "utf8"), keys)) return f;
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
  while (Date.now() - start < timeoutMs) {
    // 根治 run 卡死：窗（launcher 进程）已死 = 该块执行结束。用户方案=完成与否由主控关窗后按任务 prompt
    // 核对真实落盘（零报告原则），父进程绝不因"窗未写 result 汇报 / rollout 无 task_complete"而无限等待。
    if (pidf) {
      if (!existsSync(pidf)) {
        // pid 文件已被清理 = 窗生命周期已结束（正常关窗/被收尾清理），视为该块执行结束。
        return { done: true, text: "(window closed; no report captured)", exitCode: readExitCode(exitMarkerFile) };
      }
      const lp = readPidFile(pidf);
      if (lp > 0 && !pidAliveCheck(lp)) {
        return { done: true, text: "(window closed; no report captured)", exitCode: readExitCode(exitMarkerFile) };
      }
    }
    if (exitMarkerFile && existsSync(exitMarkerFile)) {
      const rep = readReportFromResult(exitMarkerFile, matchToken);
      if (rep) return { done: true, text: rep, exitCode: readExitCode(exitMarkerFile) };
      const code = readExitCode(exitMarkerFile);
      const base = matchToken ? { text: extractOwnResult(file, matchToken) } : extractResult(file);
      if (base.text) return { done: true, text: base.text, exitCode: code };
      return { done: true, text: "(launcher exited code " + (code === null ? "?" : code) + " before task_complete captured)", exitCode: code };
    }
    if (exitMarkerFile && existsSync(exitMarkerFile + ".self-closed")) {
      // watchdog 已写自关标记 = 窗收尾并关闭；即时视为执行结束（无汇报文本，主控按落盘核对）。
      return { done: true, text: "(window self-closed; no report captured)", exitCode: readExitCode(exitMarkerFile) };
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
    if (tail.includes('"type":"task_complete"')) {
      // exit code non-zero but task_complete seen -> still a completed turn
      return { done: true, text: (matchToken ? extractOwnResult(file, matchToken) : extractResult(file).text), exitCode: readExitCode(exitMarkerFile) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { done: false, text: "" };
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
// 确定性结果文件：读 launcher 写入的 __REPORT__（本块自己的完成汇报），含本块 token+完成 才返回；否则 ""。
function readReportFromResult(resultFile, token) {
  if (!resultFile || !existsSync(resultFile)) return "";
  try {
    const raw = String(readFileSync(resultFile, "utf8")).replace(/^\uFEFF/, "");
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    const rep = String(j.__REPORT__ || "");
    if (rep && String(rep).trim()) return rep;
  } catch { /* ignore */ }
  return "";
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
      if (msg && msg.includes(token)) last = msg;
    } catch { /* ignore */ }
  }
  return last;
}
// Re-scan rollouts for the block's report and return the latest agent message, or "" if none found yet.
// Used so a window is only auto-closed AFTER its report has been captured ("close anchor = report captured"),
// instead of blind-grace timing. Bounded by `timeoutMs`.
async function waitForReportText(matchKey, exitMarkerFile, timeoutMs) {
  const start = Date.now();
  const seen = new Set();
  const keys = rolloutKeys(matchKey);
  while (Date.now() - start < timeoutMs) {
    for (const f of listRollouts(sessionDir())) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        if (rolloutHit(readFileSync(f, "utf8"), keys)) {
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
async function closeWindowByPid(pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (!pidAliveCheck(p)) return true; // launcher 已退出（watchdog/自关）-> 无需处理
  // Recursively enumerate ALL launcher descendants (the full codex tree) along the ParentProcessId
  // chain and kill each PID individually, so `& codex` always returns and the launcher reaches its own
  // `exit 0`. Never touches the launcher itself; when codex already exited (no descendants) nothing is
  // killed. spawnSync passes args as an array -> no shell arg-splitting of the multi-line script.
  const killScript =
    "$ErrorActionPreference='SilentlyContinue';" + "\r\n" +
    "$root=" + p + ";" + "\r\n" +
    psKillDescendantsLines().join("\r\n");
  let killedCount = 0;
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", killScript], { encoding: "utf8", windowsHide: true });
    killedCount = Number(String(r.stdout || "").trim().split(/\r?\n/).pop()) || 0;
  } catch { /* ignore */ }
  // Poll for the launcher to exit on its own; the launcher runs `exit 0` right after `& codex` returns.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!pidAliveCheck(p)) return true; // launcher gone -> exit 0 + WT closed
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
// 物理关窗兜底：任何情况都不留停留窗。按窗口名找到承载本窗的 WindowsTerminal 实例并 taskkill /T /F，连窗格
// (launcher + agent 树) 一起物理关闭；窗口已不存在则空操作。只匹配本窗唯一窗口名，绝不误动它窗/用户窗口。
function physicallyCloseWindow(pidf) {
  try {
    if (!pidf) return;
    const lp = path.join(path.dirname(pidf), path.basename(pidf).replace(/^window-/, "win-launch-").replace(/\.pid$/, ".ps1"));
    const bn = path.basename(lp);
    const s = bn.replace(/^win-launch-/, "").replace(/\.ps1$/, "");
    if (!s) return;
    const windowName = "win-" + s;
    const esc = String(windowName).replace(/'/g, "''");
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'WindowsTerminal.exe' -and $_.CommandLine -like '*" + esc + "*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }"], { windowsHide: true, stdio: "ignore", timeout: 8000 });
  } catch { /* ignore */ }
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
  await closeWindowByPid(pid);
  physicallyCloseWindow(pidf);
  return true;
}
async function closeWindow(pidf) {
  if (!pidf || !existsSync(pidf)) return;
  try { writeFileSync(pidf + ".self-closed", "1", "ascii"); } catch { /* ignore */ }
  await closeWindowByPid(readPidFile(pidf));
  physicallyCloseWindow(pidf);
}
// ---------------------------------------------------------------------------
// Running-window registry + conflict locking (stability)
// ---------------------------------------------------------------------------
const WIN_REG = path.join(STATE_DIR, "orchestrator-windows.json");
const LOCK_REG = path.join(STATE_DIR, "orchestrator-locks.json");
const REG_LOCK = path.join(STATE_DIR, "orchestrator-registry.lock");
function sleepSync(ms) { try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms); } catch { /* ignore */ } }
// 跨进程独占锁：openSync 'wx' 原子创建；冲突则有限重试；finally 释放。用于串行化 registry 写，防并发丢失/半写。
function withRegistryLock(fn) {
  let got = false;
  for (let i = 0; i < 100; i++) {
    let fd;
    try { fd = openSync(REG_LOCK, 'wx'); closeSync(fd); got = true; break; } catch { sleepSync(20); }
  }
  try { return fn(); }
  finally { if (got) { try { rmSync(REG_LOCK, { force: true }); } catch { /* ignore */ } } }
}
function loadJson(file, fallback) {
  // 写侧在 Windows 上做 "remove+rename"（原子替换），会瞬时让文件不存在；读侧短暂重试即可桥接该间隙。
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch { if (i < 2) sleepSync(12); }
  }
  return fallback;
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
function saveWindows(w) { withRegistryLock(() => saveJson(WIN_REG, w)); }
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
    const cleaned = ws.filter((w) => !(w && w.pending === true && !testFresh(w))); // 顺手回收死占位
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
  testUpdateWindows((ws) => ws.map((w) => w.id === id ? { ...w, pid: Number(pid) || w.pid, pending: false, reservedAt: testNow()() } : w));
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
    const m = String(readFileSync(rf, "utf8")).match(/__EXIT__=(-?\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
// A window is "alive" if its launcher PID still exists (window still open).
function windowAlive(win) {
  if (!win.pidFile) return false;
  if (!existsSync(win.pidFile)) return false;
  const pid = Number(String(readFileSync(win.pidFile, "utf8")).trim());
  if (!pid) return false;
  // 若该窗的 result 文件已含 __EXIT__= → 任务已完成，即使残留 launcher powershell 还在，也不应视为"运行中"（防止误锁后续任务）
  const resolved = resultFileOf(win.pidFile);
  if (existsSync(resolved)) {
    try { const t = readFileSync(resolved, "utf8"); if (t.includes("__EXIT__=")) return false; } catch { /* ignore */ }
  }
  if (process.platform === "win32") {
    try { const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }); return /"\S+","\d+"/.test(r.stdout || ""); } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}
// Returns the conflictKeys of a block (never empty -> at least [<title>]).
function blockKeys(block) {
  const k = Array.isArray(block.conflictKeys) ? block.conflictKeys.map(String) : [];
  return k.length ? k : ["__" + (block.title || "block")];
}
function keysOverlap(a, b) {
  // 优化(时间): O(A*B) 查重 -> O(B) 建索引 + O(A) 查找 = O(A+B), 键多时避免平方级。
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length === 0 || b.length === 0) return false;
  // 只建较小集合的索引, 用较大数组遍历, 平均更省。
  const small = a.length <= b.length ? a : b;
  const large = a.length <= b.length ? b : a;
  const set = new Set(small.map((x) => String(x)));
  return large.some((x) => set.has(String(x)));
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
  // Unix 风格绝对路径
  for (const m of s.matchAll(/(?<![A-Za-z:])\/[^\s"'`,;)]+/g)) {
    const p = m[0].replace(/[\\/]+$/, "");
    if (isFileLike(p)) keys.add("file:" + p);
  }
  return [...keys];
}
// Over-merge guard (code-level, not relying on the model):
//   - any `independent` block carrying multiple tasks -> split into one block per task.
//   - any two blocks that share a conflictKey (would conflict if parallel) -> merge into ONE linked block.
// This makes "over-merge into a parallel block" impossible and "under-merge into a self-colliding batch" impossible.
function normalizePlan(plan) {
  const blocks = [];
  for (const b of plan) {
    const type = b.type === "independent" ? "independent" : "linked";
    const tasks = Array.isArray(b.tasks) ? b.tasks : [];
    const dependsOn = Array.isArray(b.dependsOn) ? b.dependsOn.map(String) : [];
    if (type === "independent" && tasks.length > 1) {
      for (const t of tasks) {
        blocks.push({ type: "independent", title: t.title || b.title, dependsOn: [], conflictKeys: b.conflictKeys || [], tasks: [t] });
      }
    } else {
      blocks.push({ type, title: b.title, dependsOn, conflictKeys: b.conflictKeys || [], tasks });
    }
  }
  // 确定性依赖/同目标兜底：给每个块补上"任务文本里提到的具体目标文件"键，命中即与同目标块串行。
  for (const b of blocks) {
    const inferred = new Set(Array.isArray(b.conflictKeys) ? b.conflictKeys.map(String) : []);
    for (const t of (b.tasks || [])) for (const k of inferTargetKeys(t.prompt || t.title || "")) inferred.add(k);
    if (inferred.size) b.conflictKeys = Array.from(inferred);
  }
  const merged = [];
  for (const b of blocks) {
    const hit = merged.find((m) => m !== b && keysOverlap(blockKeys(m), blockKeys(b)));
    if (hit) {
      // 同目标/冲突块合并为一个串行块（前一个写完，后一个才执行）
      if (hit.type !== b.type) hit.type = "linked";
      hit.tasks.push(...b.tasks);
      hit.conflictKeys = Array.from(new Set([...(hit.conflictKeys || []), ...(b.conflictKeys || [])]));
      hit.dependsOn = Array.from(new Set([...(hit.dependsOn || []), ...(b.dependsOn || [])]));
    } else {
      merged.push(b);
    }
  }
  return merged;
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
    const ids = String(r.stdout || "").split(/\r?\n/).map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0 && !protectedPids.has(n));
    if (!ids.length) { console.log("[orchestrator] no stale orchestrator windows from previous run."); return; }
    console.log("[orchestrator] cleaning " + ids.length + " stale orchestrator window(s) from previous run (protected live windows: " + protectedPids.size + ")...");
    for (const pid of ids) { try { await closeWindowByPid(pid); } catch { /* ignore */ } }
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
async function main() {
  const mode = process.argv[2];
  if (mode === "--doctor") {
    console.log(JSON.stringify({ agent: AGENT.agent, cli: CODEX, workspace: WORKSPACE,
      stateDir: STATE_DIR, terminal: wtAvailable() ? "wt" : "conhost",
      args: AGENT_ARGS_LIST, interactiveOutput: "inherited" }, null, 2));
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
    ensureCodexCli();
    if (!checkDiskSpace()) { process.exitCode = 1; return; }
    const title = process.argv[3] || "codex-task";
    let promptContent = process.argv.slice(4).join(" ");
    const probablyFile = process.argv[4];
    if (probablyFile && probablyFile.toLowerCase().endsWith(".md") && existsSync(probablyFile)) {
      promptContent = readFileSync(probablyFile, "utf8");
    }
    const rid = Date.now().toString(36);
    const trackedPrompt = promptContent + "\n\n【本块唯一标识】spawn-" + rid + "\n（最终汇报请以「【本块唯一标识】spawn-" + rid + " 完成」开头，并说明本块完成情况）";
    const { lp, pidf, pf, rf } = writeInteractiveLauncher(title, trackedPrompt, rid);
    const stok = "spawn-" + rid;
    const claim = { id: "claim-" + rid + "-spawn", title: titleOf("spawn-" + rid, title), keys: ["spawn:" + rid], pidFile: pidf, pid: 0, locked: false, pending: true, reservedAt: Date.now() };
    const claimBlocker = tryReserveWindow(claim);
    if (claimBlocker) {
      console.log("spawn REFUSED: atomic claim blocked by [" + claimBlocker + "]; not opening another window.");
      for (const f of [pf, lp]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      return;
    }
    const popped = await spawnWindowWithRetry(lp, title, pidf, 3, stok);
    if (!popped) {
      cancelReservation(claim.id);
      for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      console.log("spawn POPUP-FAILED: window did not appear.");
      return;
    }
    commitReservation(claim.id, readPidFile(pidf) || 0);
    console.log("write launcher -> " + lp);
    console.log("spawned tracked TUI window, polling for completion...");
    const matchToken = "【本块唯一标识】spawn-" + rid;
    const sessionFile = await waitForSessionFile(matchToken, 120000, rf);
    let res = { done: false, text: "" };
    if (sessionFile) {
      res = await waitTaskComplete(sessionFile, POLL_TIMEOUT_MS, rf, matchToken, pidf);
    } else if (existsSync(rf)) {
      res = { done: true, text: "(launcher exit marker seen; no rollout matched)", exitCode: readExitCode(rf) };
    }
    const summaryPath = path.join(TMP, "win-summary.json");
    let summary = {};
    try { summary = JSON.parse(readFileSync(summaryPath, "utf8")); } catch {}
    summary["spawn-" + rid] = { title, status: res.done ? "done" : "timeout", exitCode: res.exitCode ?? null, result: (res.text || "(no result captured)").trim().slice(0, 2000) };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    console.log("=== spawn result ===");
    console.log("done=" + res.done);
    console.log("final=" + trunc(res.text || "(none)", 500));
    // Wait for launcher to exit on its own, then force close if needed.
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
      cancelReservation(claim.id);
      for (const fp of [pidf, lp, pf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(fp)) rmSync(fp, { force: true }); } catch {} }
    } else {
      console.log("spawn window still running (manual interactive); registry record kept for tracking/enforcement.");
    }
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
    cleanStaleTransients();
    const title = process.argv[3] || "selftest-close";
    const rid = Date.now().toString(36);
    const prompt =
      "这是 codex-TUI-orchestrator 的自动关闭自检窗。请只回复四个字：“自检OK”。不要执行任何其它动作，回复完即结束本窗。\n\n" +
      "【本块唯一标识】selftest-" + rid + "\n（最终汇报请以「【本块唯一标识】selftest-" + rid + " 完成」开头，并说明本块完成情况）";
    const { lp, pidf, pf, rf } = writeInteractiveLauncher("selftest", prompt, rid);
    const claim = { id: "claim-" + rid + "-selftest", title: "selftest-close", keys: ["selftest:" + rid], pidFile: pidf, pid: 0, locked: false, pending: true, reservedAt: Date.now() };
    const claimBlocker = tryReserveWindow(claim);
    if (claimBlocker) {
      console.log("selftest REFUSED: atomic claim blocked by [" + claimBlocker + "].");
      for (const f of [pf, lp]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      return;
    }
    const popped = await spawnWindowWithRetry(lp, "selftest-close", pidf, 3, "selftest-" + rid);
    if (!popped) {
      cancelReservation(claim.id);
      for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
      console.log("selftest POPUP-FAILED: window did not appear.");
      return;
    }
    commitReservation(claim.id, readPidFile(pidf) || 0);
    const matchToken = "【本块唯一标识】selftest-" + rid;
    console.log("selftest window spawned (pidfile=" + pidf + "), waiting for task_complete...");
    let res = { done: false, text: "" };
    const sessionFile = await waitForSessionFile(matchToken, 120000, rf);
    if (sessionFile) res = await waitTaskComplete(sessionFile, 180000, rf, matchToken, pidf);
    else if (existsSync(rf)) res = { done: true, text: "(launcher exit marker seen; no rollout matched)", exitCode: readExitCode(rf) };
    const tComplete = Date.now();
    console.log("=== selftest-close result ===");
    console.log("sessionFile=" + sessionFile);
    console.log("done=" + res.done);
    console.log("final=" + trunc(res.text || "(none)", 200));
    const pid = Number(String(readFileSync(pidf, "utf8")).trim());
    // Wait for the LAUNCHER to exit on its own (watchdog self-close, expect ~1s after completion).
    // If it is still alive after 15s, fall back to the graceful closeWindow() (last resort cleanup).
    let launcherAlive = true;
    const tWait = Date.now();
    while (Date.now() - tWait < 15000) {
      try { process.kill(pid, 0); } catch (e) { if (!e || e.code !== "EPERM") { launcherAlive = false; break; } }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (launcherAlive) {
      console.log("  !! launcher still alive after task_complete; calling graceful closeWindow() fallback...");
      await closeWindow(pidf);
      try { process.kill(pid, 0); launcherAlive = true; } catch (e) { if (!e || e.code !== "EPERM") launcherAlive = false; }
    }
    const tClosed = Date.now();
    const elapsedAfterDetectMs = tClosed - tComplete;
    // Settle briefly so a just-exiting watchdog job can't count as an orphan.
    await new Promise((r) => setTimeout(r, 1500));
    let orphanAgent = false;
    try {
      const spid = Number(pid); const kids = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"ParentProcessId=" + (Number.isFinite(spid) ? spid : -1) + "\" | Measure-Object | Select-Object -ExpandProperty Count"], { windowsHide: true, encoding: "utf8" });
      orphanAgent = Number(String(kids.stdout || "0").trim()) > 0;
    } catch { /* ignore */ }
    console.log("launcherPid=" + pid + " launcherStillAlive=" + launcherAlive + " (expect false => pane auto-closed)");
    console.log("elapsedAfterDetectMs=" + elapsedAfterDetectMs + " (orchestrator-detect -> launcher gone; launcher watchdog itself polls every 500ms, expect ~1s from task_complete)");
    console.log("orphanChildren=" + orphanAgent + " (expect false => no orphan agent)");
    console.log("=== selftest-close done ===");
    cancelReservation(claim.id);
    for (const f of [pf, lp, pidf, rf, pidf + ".self-closed", rf + ".self-closed"]) { if (existsSync(f)) { try { rmSync(f, { force: true }); } catch { /* ignore */ } } }
    return;
  }
  if (mode === "--run-windows") {
    armEnforcement();
    const codexCli = ensureCodexCli(); // CLI 环境检测与安装（硬约束：先确保 codex 可用再继续）
    if (!checkDiskSpace()) { process.exitCode = 1; return; }
    // 内存自适应最大并发：n GB 内存 -> round(n * 1024 / 2000) 并发 TUI 窗（四舍五入取整，约等于 n/2，随内存扩展）。
    // <4G 视为不支持(2G 设备默认不支持 orchestrator)。先算 memGb 供下方 Superpowers 与子代理克制使用复用。
    const memGb = os.totalmem() / (1024 * 1024 * 1024);
    const maxByMem = computeMaxWindows(memGb);
    if (maxByMem < 2) {
      console.error("[orchestrator] 内存不足：" + Math.round(memGb) + "GB < 4G；orchestrator 至少需要 4G 内存，终止。");
      process.exitCode = 1; return;
    }
    // 用户要求：运行环境检测里加入对 Superpowers plugin 的检测。可用则让 Superpowers 参与后续流程（并发分析+并发干活强强联合）；
    // 未检测到则照旧（不因缺少它而降级/报错）。把结果写入进程 env，使 spawn 出的 TUI 窗能继承并感知。
    const sp = detectSuperpowers();
    process.env.ORCH_SUPERPOWERS = sp.available ? "1" : "0";
    process.env.ORCH_SUPERPOWERS_REASON = sp.reason || "";
    console.log("[orchestrator] superpowers plugin: " + (sp.available ? "USABLE -> 参与后续流程 (并发分析+并发干活强强联合)" : "NOT USABLE -> 照旧 (" + sp.reason + ")"));
    console.log("[orchestrator] env: codex=" + codexCli + " workspace=" + WORKSPACE + " tui=" + (wtAvailable() ? "wt" : "conhost") + " superpowers=" + (sp.available ? "on" : "off") + " maxWindows=" + computeMaxWindows(memGb) + " pollCeiling=" + Math.round(POLL_TIMEOUT_MS / 60000) + "min");
    cleanStaleTransients();
    await cleanStaleWindows();
    const request = process.argv.slice(3).join(" ");
    if (!request) throw new Error("--run-windows needs a request");
    // 入口判定（真实执行 vs 只读分析）：明显两端走确定性快判，歧义交给 LLM；fail-safe 判 execute。
    const execMode = await classifyExecutionMode(request);
    if (execMode === "inline") {
      console.log("[orchestrator] 判定为只读/纯分析 -> 留在主对话内联执行，不弹窗。");
      return;
    }
    const rid = Date.now().toString(36);
    console.log("[orchestrator] decomposing (read-only)...");
    const plan = await decomposeSafely(request);
    console.log("[orchestrator] blocks=" + plan.length);
    // 【硬性要求】对 orchestrator 自身的改动：先 inline 就地做，绝不当成“一个改它的 TUI 窗”。
    // （TUI 窗依赖 orchestrator SDK；改 SDK 的窗其自身的 watchdog/关窗也依赖被改的 SDK，会“改它自己关不掉”。）
    if (plan.some((b) => (b.tasks || []).some((t) => isOrchestratorSelfMod(t.prompt || t.title || "")))) {
      console.log("[orchestrator] 检测到对 orchestrator 自身的改动 -> 按硬性要求 inline 就地执行（不弹 TUI 窗）。先改好 orchestrator，再据此发起并发 TUI 窗。");
      console.log(JSON.stringify({ mode: "inline", reason: "orchestrator 自身改动：必须先在发起对话中完成，才能据此发起并发 TUI 窗" }));
      return;
    }
    // autosafe 检测：只有单一/串行块时无需弹窗——直接在发起对话中就地执行（不弹 TUI 窗）。
    if (plan.length < 2) {
      console.log(JSON.stringify({ mode: "inline", blocks: plan, reason: "单一/串行块：直接在发起对话中就地执行（不弹 TUI 窗）" }));
      return;
    }
    // 全事务写 registry：只追加本批新增记录，绝不整表覆盖，避免跨进程 lost-update。
    let pendingWins = [];
    let pendingLocks = [];
    const flushRegistry = () => {
      if (pendingWins.length) { updateWindows((ws) => ws.concat(pendingWins)); pendingWins = []; }
      if (pendingLocks.length) { updateLocks((ls) => ls.concat(pendingLocks)); pendingLocks = []; }
    };
    const inRun = [];
    const lockedBacklog = []; // 被锁块：冲突释放后自动重跑，不静默丢弃
    const waitMs = Number(process.env.ORCH_WAIT_MS || 120000); // max time to wait for a conflict to clear
    const closeDelayMs = Number(process.env.ORCH_CLOSE_DELAY_MS || 1000); // window auto-closes ~1s after the task completes
    const auth = readAuthPrompt();
    // 复用导出的纯函数改写 auth 提示词：三遍检查序号 ①②③ → 1) 2) 3)（修复 WT CJK 宽度重叠）。
    const authWaitCapped = applyAuthPromptPolicy(auth);
    // ---- wave-based scheduling with dependency serialization (D①) ----
    // A block with `dependsOn: [<title>,...]` must WAIT until every prerequisite (by title) has finished.
    // We level blocks into waves: a block joins the earliest wave where all its dependsOn are in earlier waves.
    const recs = plan.map((b, i) => ({
      key: "B" + (i + 1),
      b,
      keys: blockKeys(b),
      title: titleOf("B" + (i + 1), b.title),
      dependsOn: (Array.isArray(b.dependsOn) ? b.dependsOn : []).map(String),
    }));
    const recsByKey = new Map(recs.map((r) => [r.key, r]));
    // B3 双向映射：模型 dependsOn 可能用原始标题/中文标题，统一归一到块 key，再按 key 判 wave。
    const keyByTitle = new Map();
    for (const r of recs) { keyByTitle.set(r.key, r.key); keyByTitle.set(r.title, r.key); keyByTitle.set(String(r.b.title), r.key); }
    for (const r of recs) { r.dependsOn = r.dependsOn.map((d) => keyByTitle.get(String(d)) || keyByTitle.get(d) || String(d)); }
    // B3 双向映射 + 分层 wave：统一由 levelWaves() 归一（剔除自引用/未知依赖），避免死锁整批并跑。
    const baseWaves = levelWaves(recs);
    // 内存自适应并发：把每个依赖层进一步按 maxByMem 切片，最多同时 maxByMem 个窗，避免超出内存承载。
    const chunks = [];
    for (const w of baseWaves) { for (let i = 0; i < w.length; i += maxByMem) { chunks.push(w.slice(i, i + maxByMem)); } }
    const waves = chunks;
    const summary = {};
    // 新 run 清零上次运行的 win-summary.json（账实一致）：杜绝旧 B1/B2/B3 等残留污染本次 poll/汇报/用户查看。
    try { writeFileSync(path.join(TMP, "win-summary.json"), JSON.stringify({ blocks: [], results: {} }, null, 2), "utf8"); } catch { /* ignore */ }
    const allSpawned = [];
    // 记录每个块首次弹窗时刻，用于判断“是否已在盘上做出改动”——避免未决块重复执行同一任务。
    const blockStarted = {};
    const diskProgressSince = (key, rec) => {
      const start = blockStarted[key] || 0;
      if (!start) return false;
      for (const k of (rec && rec.keys) || []) {
        if (typeof k === "string" && k.startsWith("file:")) {
          try {
            const p = k.slice("file:".length);
            if (existsSync(p) && statSync(p).mtimeMs >= start) return true;
          } catch { /* ignore */ }
        }
      }
      return false;
    };
    // 「未落盘=未完成」盘面复核（用户建议治本）：对"产出类"任务（创建/写入/生成/新建等），若其 file:/dir: 目标
    // 自窗启动后没有任何落盘改动（mtime 未变 / 文件未出现 / 目录为空判定靠文件 key），则不允许当作成功收尾，
    // 把 status 降为 uncaptured，让 poll-windows 不把它当成功、主对话能据此发现"计划了但没真正落地"。
    const PROD_VERBS = /创建|写入|生成|新建|添加|改成|追加|marker|create|write|append|add|new|generate/;
    const targetChangedSinceStart = (key, rec) => {
      const start = blockStarted[key] || 0;
      if (!start) return false;
      const fileHit = (rec && rec.keys || []).some((k) => {
        if (typeof k !== "string" || !k.startsWith("file:")) return false;
        try { const p = k.slice("file:".length); return existsSync(p) && statSync(p).mtimeMs >= start; } catch { return false; }
      });
      if (fileHit) return true;
      // 允许"目录目标但其中已出现新文件"也视作落地（dir: 前缀，向下扫一层看是否有 mtime>=start 的新文件）。
      const dirHit = (rec && rec.keys || []).some((k) => {
        if (typeof k !== "string" || !k.startsWith("dir:")) return false;
        try {
          const p = k.slice("dir:".length);
          if (!existsSync(p)) return false;
          for (const e of readdirSync(p, { withFileTypes: true })) {
            const fp = path.join(p, e.name);
            try { if (statSync(fp).mtimeMs >= start) return true; } catch { /* ignore */ }
          }
        } catch { return false; }
      });
      return dirHit;
    };
    const isProducingBlock = (rec, s) => {
      const prompt = ((rec && rec.b && rec.b.tasks || []).map((t) => (t.prompt || "")).join(" ") + " " + (s && s.prompt || "")).trim();
      return PROD_VERBS.test(prompt);
    };
    const assertProductLanding = (key, rec, s, entry) => {
      if (!rec || !isProducingBlock(rec, s)) return entry;
      if (targetChangedSinceStart(key, rec)) return entry;
      entry.status = "uncaptured";
      entry.result = ((entry.result || "") + "\n【盘面复核】任务要求产出文件，但检测到其 file:/dir: 目标自窗启动后无落盘改动，判定为未完成（未落盘），请主对话核实。").trim().slice(0, 2000);
      console.log("  !! [" + s.title + "] producing block shows NO on-disk change since start -> marked uncaptured (未落盘)");
      return entry;
    };
    // 块一旦被锁就立即写入终态记录：即使整批全部被锁（无窗可弹），win-summary.json 也有非空 results，
    // poll-windows 不会因空 summary 空等到超时；冲突释放后自动重跑成功会覆盖成 done。
    const markLocked = (r, by) => {
      summary[r.key] = { title: r.title, status: "locked", exitCode: null, result: "(冲突锁定：等待 [" + by + "] 关闭；释放后自动重跑)" };
    };
    for (const wave of waves) {
      const spawnedWave = [];
      for (const r of wave) {
        const nkeys = r.keys;
        // 同批内部防冲突：normalizePlan 已保证独立块互不重叠；这里双保险，若仍重叠则跳过。
        const clashRun = inRun.find((s) => keysOverlap(nkeys, s.keys));
        if (clashRun) {
          pendingLocks.push({ block: r.key, title: r.title, blockedBy: clashRun.title, keys: nkeys });
          markLocked(r, clashRun.title);
          console.log("  LOCKED " + r.key + " -- conflicts with a block already spawned in this batch [" + clashRun.title + "]");
          lockedBacklog.push({ r, nkeys });
          continue;
        }
        // SDK 预检：与正在跑的窗冲突 -> 等待其关闭（确定不冲突）再执行。
        const blocker = conflictByKeys(nkeys);
        if (blocker) {
          console.log("  WAIT " + r.key + " -- conflict with running window [" + blocker + "], waiting up to " + Math.round(waitMs / 1000) + "s...");
          const ok = await waitClear(nkeys, waitMs);
          if (!ok) {
            pendingLocks.push({ block: r.key, title: r.title, blockedBy: blocker, keys: nkeys });
            markLocked(r, blocker);
            console.log("  LOCKED " + r.key + " -- still conflicting after wait [" + blocker + "]");
            lockedBacklog.push({ r, nkeys });
            continue;
          }
        }
        // 原型检测前置门禁（硬约束）：执行前先跑一次原型检测，通过才允许 spawn 本块。
        const gateBody = blockBody(r.b);
                if (!await runPrototypeGate(titleOf("B" + (recs.indexOf(r) + 1), r.b.title), gateBody)) {
          summary[r.key] = { title: titleOf("B" + (recs.indexOf(r) + 1), r.b.title), status: "preflight-failed", exitCode: null, result: "(preflight prototype-validation 未通过，未执行)" };
          console.log("  SKIPPED " + r.key + " -- preflight prototype-validation failed; not spawning.");
          continue;
        }
        // 并发兜底：冲突检查后、真正 spawn 前紧邻复检一次（另一进程可能在等待期抢占/写入 registry）。
        const recheck = conflictByKeys(nkeys);
        if (recheck) {
          pendingLocks.push({ block: r.key, title: r.title, blockedBy: recheck, keys: nkeys });
          markLocked(r, recheck);
          console.log("  LOCKED " + r.key + " -- conflicted during gate ([" + recheck + "]); not spawning.");
          lockedBacklog.push({ r, nkeys });
          continue;
        }
        const tk = r.key + "-" + rid + "-" + Math.random().toString(36).slice(2, 8);
        const body = authWaitCapped + buildBlockPrompt(blockBody(r.b), tk);                                         
        const { lp, pidf, pf, rf } = writeInteractiveLauncher(r.key, body, rid);
        // 跨进程原子占位：复检后、真正 spawn 前先在独占锁内写入 pending=true（pid=0）记录。
        // 其它进程的 conflictByKeys 会看到这份新鲜占位，从而把“正在弹窗但尚未入册”的窗也视为占用。
        const claim = { id: "claim-" + rid + "-" + r.key + "-" + Math.random().toString(36).slice(2, 8), title: r.title, keys: nkeys, pidFile: pidf, pid: 0, locked: false, pending: true, reservedAt: Date.now() };
        const claimBlocker = tryReserveWindow(claim);
        if (claimBlocker) {
          pendingLocks.push({ block: r.key, title: r.title, blockedBy: claimBlocker, keys: nkeys });
          markLocked(r, claimBlocker);
          console.log("  LOCKED " + r.key + " -- conflicted during atomic claim ([" + claimBlocker + "]); not spawning.");
          lockedBacklog.push({ r, nkeys });
          for (const f of [pf, lp]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
          continue;
        }
        const popped = await spawnWindowWithRetry(lp, r.title, pidf, 3, tk);
        if (!popped) {
          cancelReservation(claim.id);
          summary[r.key] = { title: r.title, status: "popup-failed", exitCode: null, result: "(弹窗失败：多次尝试仍未出现窗口)" };
          console.log("  POPUP-FAILED " + r.key + " -- window did not appear; not tracking as running.");
          for (const f of [pf, lp, rf, pidf, pidf + ".self-closed", rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
          continue;
        }
        commitReservation(claim.id, readPidFile(pidf) || 0);
        spawnedWave.push({ key: r.key, title: r.title, pidf, lp, pf, rf, prompt: body, matchToken: "【本块唯一标识】" + tk, tk });
        inRun.push({ key: r.key, title: r.title, keys: nkeys });
        blockStarted[r.key] = Date.now();
        console.log("  popped interactive TUI window [" + r.title + "] (claim committed)");
      }
      flushRegistry();
      allSpawned.push(...spawnedWave);
      if (!spawnedWave.length) continue;
      // 等待本波所有窗完成（会话 rollout 出现 task_complete，或 launcher 的 result 标记出现=agent 已退出），
      // 抓最终消息，再自动关窗；完成后再开下一波。
      await Promise.all(spawnedWave.map(async (s) => {
        const matchKey = s.matchToken || s.prompt.slice(0, 40);
        const resultFile = resultFileOf(s.pidf);
        const sessionFile = await waitForSessionFile(matchKey, 90000, resultFile);
        let res = { done: false, text: "" };
        if (sessionFile) {
          res = await waitTaskComplete(sessionFile, POLL_TIMEOUT_MS, resultFile, s.matchToken, s.pidf);
        } else if (existsSync(resultFile) || existsSync(resultFile + ".self-closed")) {
          // 完成信号=窗内自关（.self-closed）或 result 已落盘（agent 已退出/Write-Result 完成）：立即回收。
          // 优先读本块自己的完成汇报；尚未写出时交给下游 waitForReportText 短暂等报告落盘。
          const code = readExitCode(resultFile);
          let text = readReportFromResult(resultFile, s.matchToken);
          if (!text && existsSync(resultFile)) text = extractResult(resultFile).text || "";
          res = { done: true, text: (text || ("(launcher exited code " + (code === null ? "?" : code) + "; no session rollout matched)")), exitCode: code };
        } else {
          console.log("  !! " + s.key + " session rollout not found (prompt match) - window left open; close it manually.");
        }
        const tagged = res.done ? "done" : "timeout";
        summary[s.key] = { title: s.title, status: tagged, exitCode: res.exitCode ?? null, result: (res.text || "(no result captured)").trim().slice(0, 2000) };
        // 真实 token 观测：从本窗 rollout 提取真实 usage（input/output/cached/total），供 plugin-eval 把评分钉在事实上。
        try { if (sessionFile) summary[s.key].usage = extractUsage(sessionFile); } catch { /* ignore */ }
        console.log("=== " + s.key + " " + s.title + " ===");
        if (res.done) {
          // 执行结束判定（用户方案：done=做完了，不等同于成功）：窗口已执行结束（识别码/自关标记/codex 退出）即收。
          // 是否真正达成 prompt 预期，由主控关窗后去核对真实落盘状态；这里不因未捕获到“汇报文本”就判定未完成。
          // 汇报文本尽力带出（有则记，无则提示需外部核对落盘），status 一律 done。
          let text = res.text || "";
          if (!text || /no session rollout matched|no result captured|launcher exited/.test(text)) {
            try { if (sessionFile) text = extractResult(sessionFile).text || ""; } catch { /* ignore */ }
          }
          const hasText = !!(text && text.trim());
          summary[s.key].result = (hasText ? text.trim() : ("（窗内 codex 已执行结束并自动关闭；退出码=" + (res.exitCode ?? "?") + "，未捕获汇报文本，请按任务提示词核对真实落盘状态）")).slice(0, 2000);
          summary[s.key].status = "done";
          // 「未落盘=未完成」：产出类任务若窗启动后目标无落盘改动，降为 uncaptured（不当作成功收尾）。
          assertProductLanding(s.key, recsByKey.get(s.key), s, summary[s.key]);
          console.log("  execution ended -> marked done -> closing [" + s.title + "]");
          await new Promise((r) => setTimeout(r, closeDelayMs));
          await closeWindow(s.pidf);
        } else {
          console.log("  timeout; window [" + s.title + "] still open (task may still be running).");
        }
      }));
    }
    // ---- 锁释放→自动重跑被锁块：只要冲突已释放(窗已关/不再冲突)，就重新弹窗执行，保证不被静默丢弃 ----
    if (lockedBacklog.length) {
      console.log("[orchestrator] retrying " + lockedBacklog.length + " locked block(s) whose conflicts may have cleared...");
      for (const item of lockedBacklog) {
        const r = item.r, nkeys = item.nkeys;
        if (conflictByKeys(nkeys)) { console.log("  still locked " + r.key + "; not re-run yet."); continue; }
        console.log("  re-running previously-locked block [" + r.key + "] (conflict cleared)");
        const tk2 = r.key + "-" + rid + "-" + Math.random().toString(36).slice(2, 8);
        const body2 = authWaitCapped + buildBlockPrompt(blockBody(r.b), tk2);                                       
        const la = writeInteractiveLauncher(r.key, body2, rid);
        const claim2 = { id: "claim-" + rid + "-" + r.key + "-" + Math.random().toString(36).slice(2, 8), title: r.title, keys: nkeys, pidFile: la.pidf, pid: 0, locked: false, pending: true, reservedAt: Date.now() };
        const claimBlocker2 = tryReserveWindow(claim2);
        if (claimBlocker2) {
          console.log("  still locked " + r.key + " -- atomic claim blocked by [" + claimBlocker2 + "]; not re-run yet.");
          for (const f of [la.pf, la.lp]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
          continue;
        }
        const popped2 = await spawnWindowWithRetry(la.lp, r.title, la.pidf, 3, tk2);
        if (!popped2) {
          cancelReservation(claim2.id);
          summary[r.key] = { title: r.title, status: "popup-failed", exitCode: null, result: "(弹窗失败：多次尝试仍未出现窗口)" };
          console.log("  POPUP-FAILED " + r.key + " -- window did not appear during locked-block re-run.");
          for (const f of [la.pf, la.lp, la.rf, la.pidf, la.pidf + ".self-closed", la.rf + ".self-closed"]) { try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* ignore */ } }
          continue;
        }
        commitReservation(claim2.id, readPidFile(la.pidf) || 0);
        inRun.push({ key: r.key, title: r.title, keys: nkeys });
        allSpawned.push({ key: r.key, title: r.title, pidf: la.pidf, lp: la.lp, pf: la.pf, rf: la.rf, prompt: body2, matchToken: "【本块唯一标识】" + tk2 });
        blockStarted[r.key] = Date.now();
        flushRegistry();
        const matchKey2 = "【本块唯一标识】" + tk2, resultFile2 = la.rf;
        const sf2 = await waitForSessionFile(matchKey2, 90000, resultFile2);
        let res2 = { done: false, text: "" };
        if (sf2) res2 = await waitTaskComplete(sf2, POLL_TIMEOUT_MS, resultFile2, matchKey2, la.pidf);
        else if (existsSync(resultFile2)) { const c2 = readExitCode(resultFile2); res2 = { done: true, text: "(launcher exited code " + (c2 === null ? "?" : c2) + "; no session rollout matched)", exitCode: c2 }; }
        summary[r.key] = { title: r.title, status: res2.done ? "done" : "timeout", exitCode: res2.exitCode ?? null, result: (res2.text || "(no result captured)").trim().slice(0, 2000) };
        if (res2.done) {
          // 执行结束判定（用户方案：done=做完了，不等同于成功）：res2.done 即收；是否达标由主控核对真实落盘状态。
          let t2 = res2.text || "";
          if (!t2 || /no session rollout matched|no result captured|launcher exited/.test(t2)) {
            try { if (sf2) t2 = extractResult(sf2).text || ""; } catch { /* ignore */ }
          }
          summary[r.key].result = (t2 && t2.trim() ? t2.trim() : ("（窗内 codex 已执行结束并自动关闭；请按任务提示词核对真实落盘状态）")).trim().slice(0, 2000);
          summary[r.key].status = "done";
          console.log("  [re-run " + r.key + "] execution ended -> closed");
          await new Promise((x) => setTimeout(x, closeDelayMs));
          await closeWindow(la.pidf);
          cancelReservation(claim2.id);
        } else {
          console.log("  !! [re-run " + r.key + "] wait timeout; closing window to avoid leak.");
          await closeWindow(la.pidf);
          cancelReservation(claim2.id);
        }
      }
      flushRegistry();
    }
    if (!allSpawned.length && !lockedBacklog.length) {
      console.log("all blocks locked; nothing spawned.");
      // 即便一个窗都没弹，也要把已定终态（preflight-failed/locked）写入汇总，
      // 否则 poll-windows 会因看不到 fresh summary 而空等/挂死。
      const out0 = path.join(TMP, "win-summary.json");
      writeFileSync(out0, JSON.stringify({ blocks: plan.map((b, i) => ({ key: "B" + (i + 1), title: b.title })), results: summary }, null, 2), "utf8");
      return;
    }
    // 收尾（硬约束：全部任务结束前保持轮询，绝不提前收尾/留下"晚生"的孤儿窗）：
    // 只要仍有活窗，或仍有计划块没出现在 summary（未决/未 spawn），就持续轮询等待，直到全部有终态才写 summary/退出。
    const planned = new Set(plan.map((b, i) => "B" + (i + 1)));
    {
      const holdStart = Date.now();
      const holdMax = POLL_TIMEOUT_MS;
      let beat = Date.now();
      let zeroAliveSince = 0;
      // 默认不再自动重跑“未决”块（ORCH_BLOCK_MAX_RETRY 默认 0）：窗若关闭却没捕获到本块自己的
      // “完成”汇报，一律交由主对话外部复核落盘产物；除非显式设置 ORCH_BLOCK_MAX_RETRY>0。
      // 修复此前“未决块反复重启 TUI 窗执行同一任务”的循环。
      const retryState = { attempts: {}, max: Math.max(0, Number(process.env.ORCH_BLOCK_MAX_RETRY || 0)) };
      while (Date.now() - holdStart < holdMax) {
        const alive = loadWindows().filter((w) => windowAlive(w));
        // 【兜底自动关窗】凡某窗的 win-<s>.result.json（由 resultFileOf 从 pidFile 精确推导）已写出且含 __DONE__:true，
        // 即便其 session rollout 匹配失败，也立即 closeWindow 关掉它，杜绝"窗内任务已做完但不关窗"。
        try {
          const allWins = loadWindows();
          for (const w of allWins) {
            const rf = resultFileOf(w.pidFile || "");
            if (!rf || !existsSync(rf)) continue;
            const txt = readFileSync(rf, "utf8").replace(/^\uFEFF/, "");
            if (txt.indexOf("__DONE__") === -1) continue;
                        // 多路兜底关闭：pidFile 缺失/被外部清理时仍按 registry pid 或 launcher 脚本定位并关闭，绝不遗留屏幕窗。
            const robustClosed = await closeWindowRobust(w);
            if (robustClosed) console.log("[orchestrator] done-and-close fallback: closed " + w.title);
          }
          // 移除已写完 result 且 __DONE__ 的窗（避免重复轮询）
          updateWindows((ws) => ws.filter((x) => {
            const rf = resultFileOf(x.pidFile || "");
            if (!rf || !existsSync(rf)) return true;
            const txt = readFileSync(rf, "utf8").replace(/^\uFEFF/, "");
            return txt.indexOf("__DONE__") === -1;
          }));
        } catch { /* ignore */ }
        // 未完成判定（用户方案：用“全部结果是否都成功返回”而非“窗是否都关”）：
        // 某块视为已解决=它在 summary 中，且 结果非占位（真实汇报） 或 状态为 preflight-failed/locked（被正确拦截）。
        const locksNow = loadLocks();
        const unresolved = [...planned].filter((k) => {
          if (locksNow.some((l) => String(l.block) === k)) return false; // 被锁定=终态
          const s = summary[k];
          if (!s) return true;
          const st = String(s.status || "");
          // 只有真正 done、或明确被拦截/终态，才算“已解决”；uncaptured/failed/timeout 一律视为未解决 -> 继续轮询，绝不提前收尾。
          if (st === "done") return false;
          if (st === "preflight-failed" || st === "locked" || st === "unfinished" || st === "popup-failed" || st === "failed" || st === "done-on-disk") return false;
          return true;
        });
        if (alive.length === 0 && unresolved.length === 0) break;
        // 兜底：所有窗已关闭(归零>15s)但仍剩未决块——不提前放弃，把每个未决块自动重试（全新 token 弹窗），
        // 直到重试耗尽(ORCH_BLOCK_MAX_RETRY，默认 0=不自动重试)才结束；显式开启时若目标文件已被改动，
        // 标记 done-on-disk 而不是重复弹窗执行同一任务。
        if (alive.length === 0 && zeroAliveSince && Date.now() - zeroAliveSince > 15000) {
          const keyToIdx = new Map(); recs.forEach((r, i) => keyToIdx.set(r.key, i));
          const retryable = unresolved.filter((k) => {
            if ((retryState.attempts[k] || 0) >= retryState.max) return false;
            const rec = recs[keyToIdx.get(k)];
            if (rec && diskProgressSince(k, rec)) {
              summary[k] = { title: rec.title, status: "done-on-disk", exitCode: null, result: "(窗未捕获本块完成汇报，但目标文件已被修改：视为已落地，不再重复弹窗；请主对话外部复核落盘产物)" };
              return false;
            }
            return true;
          });
          if (!retryable.length) break; // 重试耗尽 -> 结束（如实标记失败）
          for (const k of retryable) {
            const rec = recs[keyToIdx.get(k)];
            if (!rec) continue;
            retryState.attempts[k] = (retryState.attempts[k] || 0) + 1;
            console.log("[orchestrator] RETRY unresolved block [" + k + "] (attempt " + retryState.attempts[k] + "/" + retryState.max + ")");
            summary[k] = await retryBlock(rec, rid, authWaitCapped, 1, closeDelayMs);                            
          }
          zeroAliveSince = 0;
        }
        // 【硬约束】GUI 轮询收尾触发 = 检测到全部 TUI 窗的执行结果均已成功返回。
        // 因此只要还有 unresolved 的块（结果未真实返回），即使所有窗已关闭，也继续轮询，
        // 不提前收尾，直到全部返回或 ORCH_TIMEOUT_MS 超时兜底。
        zeroAliveSince = alive.length === 0 ? (zeroAliveSince || Date.now()) : 0;
        if (Date.now() - beat > 5000) {
          beat = Date.now();
          console.log("[orchestrator] HOLDING (all-tasks-not-done): liveWindows=" + alive.length + " unresolvedBlocks=" + unresolved.join(",") + "  elapsed=" + Math.round((Date.now() - holdStart) / 1000) + "s");
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      // 超时仍存在活窗/未决块：如实记录，不假装完成；但为避免泄漏，写到 summary 并继续。
      const aliveNow = loadWindows().filter((w) => windowAlive(w));
      const unresolvedNow = [...planned].filter((k) => {
        const s = summary[k];
        if (!s) return true;
        const r = String(s.result || "");
        return /\(no result captured\)|no session rollout matched|no result captured/i.test(r) && !/报告 CAPTURED|完成/.test(r);
      });
      if (aliveNow.length || unresolvedNow.length) {
        console.log("  !! orchestrator hold timeout: aliveWindows=" + aliveNow.length + " unresolved=" + unresolvedNow.join(",") + " (这些窗/块未在超时内完成)");
        for (const k of unresolvedNow) {
          summary[k] = aliveNow.length
            ? { title: k, status: "unfinished", exitCode: null, result: "(未在窗口保持期结束前完成)" }
            : { title: k, status: "uncaptured", exitCode: null, result: "(执行窗已关闭但结果未捕获；请主对话外部复核实际落盘产物)" };
        }
      }
    }
    // 收尾兜底：本批窗口按多路 robust 关闭（pidFile 可能已被并发清理任务删除，仍可按 registry pid/launcher 脚本定位关窗）。
    for (const s of allSpawned) { await closeWindowRobust({ pidFile: s.pidf, pid: readPidFile(s.pidf) }); }
    updateWindows((ws) => ws.filter((w) => windowAlive(w)));
    const remaining = loadWindows().filter((w) => windowAlive(w));
    const out = path.join(TMP, "win-summary.json");
    writeFileSync(out, JSON.stringify({ blocks: plan.map((b, i) => ({ key: "B" + (i + 1), title: b.title })), results: summary }, null, 2), "utf8");
    console.log("[orchestrator] summary -> " + out);
    console.log(JSON.stringify(summary, null, 2));
    // 用完即弃：本批临时产物（launcher/prompt/result/log/pid/win-summary）默认清理；ORCH_KEEP_TEMP=1 保留供排查
    if (process.env.ORCH_KEEP_TEMP !== "1") {
      try {
        const stillAlive = new Set(remaining.map((w) => w.title));
        for (const s of allSpawned) {
          for (const f of [s.pf, s.lp, s.pidf + ".self-closed", s.rf + ".self-closed", ...(stillAlive.has(s.title) ? [] : [s.pidf, s.rf])]) {
            if (f && existsSync(f)) rmSync(f, { force: true });
          }
        }
        // 兜底：顺带清掉上一批遗留的 .self-closed / 死 pid 附属文件（活窗 pid 受保护，不会被误删）。
        for (const f of staleTransientFiles()) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
        if (existsSync(out)) { /* 绝不删 win-summary.json：它是给主对话/用户聚合的汇报 */ }
        console.log("[orchestrator] temp artifacts cleaned (win-summary.json preserved)");
      } catch { /* ignore */ }
    }
    return;
  }
  if (mode === "--status") {
    showStatus(process.argv.includes("--readonly"));
    return;
  }
  if (mode === "--run" || mode === "--exec") {
    // Enforcement: headless real execution is hard-disabled by default. The sanctioned engine for
    // REAL work is --run-windows (a real visible TUI window). Opt-in via ORCH_ALLOW_HEADLESS=1 only
    // for pure, windowless automation that the user has explicitly sanctioned.
    if (process.env.ORCH_ALLOW_HEADLESS !== "1") {
      console.error("[orchestrator] REFUSED: headless --run/--exec is disabled by codex-TUI-orchestrator enforcement. Real work must go through --run-windows (a real, visible, interactive TUI window). Set ORCH_ALLOW_HEADLESS=1 only for pure automation you explicitly want windowless.");
      process.exitCode = 1;
      return;
    }
    const request = process.argv.slice(3).join(" ");
    if (!request) throw new Error("--run needs a request");
    console.log("[orchestrator] decomposing...");
    const plan = await decomposeSafely(request);
    console.log("[orchestrator] blocks=" + plan.length);
    const summary = {};
    for (let i = 0; i < plan.length; i++) {
      summary["B" + (i + 1)] = { title: plan[i].title, type: plan[i].type, status: "pending" };
    }
    const runBlock = async (b, idx) => {
      const key = idx;
      const attempt = async (retry) => {
        const body = retry ? "(上一轮执行可能失败，请先检查环境与路径，换一种更稳妥的方式完成。)\n" + blockBody(b) : blockBody(b);
        const res = await runThreadPrompt(body);
        console.log("=== " + key + " " + b.title + (retry ? " (重试)" : "") + " ===");
        console.log(trunc(res.final, 2000));
        if (!res.errored) { summary[key].status = "done"; summary[key].result = res.final; return true; }
        summary[key].status = "failed"; summary[key].result = res.errored;
        return false;
      };
      if (await attempt(false)) return;
      console.log("  !! 失败，自动重试: " + summary[key].result);
      const ok = await attempt(true);
      if (ok) summary[key].status = "done-retried";
    };
    await Promise.all(plan.map((b, i) => runBlock(b, "B" + (i + 1))));
    mkdirSync(TMP, { recursive: true });
    const out = path.join(TMP, "win-summary.json");
    writeFileSync(out, JSON.stringify(summary, null, 2), "utf8");
    console.log("[orchestrator] summary -> " + out);
    console.log(JSON.stringify(summary, null, 2));
    // 用完即删：汇总已打印到 stdout；默认删除本批临时产物，ORCH_KEEP_TEMP=1 可保留供排查
    if (process.env.ORCH_KEEP_TEMP !== "1") {
      try { rmSync(out, { force: true }); console.log("[orchestrator] temp artifacts cleaned (used-and-discarded)"); } catch { /* ignore */ }
    }
    return;
  }
  console.log(
    "Usage:\n" +
      "  node orchestrate-sdk.mjs --plan \"<request>\"\n" +
      "  node orchestrate-sdk.mjs --run  \"<request>\"\n" +
      "  node orchestrate-sdk.mjs --run-windows \"<request>\"\n" +
      "  node orchestrate-sdk.mjs --spawn <title> \"<prompt or .md>\"",
  );
}
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((e) => {
  console.error("[orchestrator] FATAL: " + e.message);
  process.exitCode = 1;
});
export { classifyBlockComplexity, classifyExecutionMode, appendModelEffortArgs, genericProjectSplit, trySingleBlock, conflictByKeys, loadCachedDecompose, buildBlocksFromTasks, resolveHints, extractTasks, classifyPrompt, buildBlockPrompt, levelWaves, decomposeHash, checkDiskSpace, readPidFile, pidAliveCheck, closeWindowByPid, windowGenuinelyPopped, extractResult, extractUsage, readReportFromResult, sessionDir, writeInteractiveLauncher, staleTransientFiles, pidFileOfTransient, tryReserveWindow, commitReservation, cancelReservation, computeMaxWindows, blockKeys, keysOverlap, __setOrchHooks, isOrchestratorSelfMod, resolveCodexHome };
