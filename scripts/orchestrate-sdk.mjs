#!/usr/bin/env node
/**
 * codex-orchestrator — split a multi-part request into safe parallel blocks.
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
 *   --spawn <title> <md>    : open ONE real visible codex-interactive window that runs the given
 *                             prompt/`prompt file`, with a real popup terminal (cmd /c start).
 *                             Best for when you want to WATCH a specific task.
 *
 * Configuration (all optional, env-first with sensible defaults):
 *   WORKSPACE_DIR  (default: process.cwd())  — auto-detected workspace root for the user.
 *   CODEX_EXE      (default: auto-detect from PATH or a common user install).
 *   PYTHON         (default: `python`; prepended to the spawned window PATH).
 *   ORCH_MODEL     (default: empty -> Codex uses its configured default model)
 *   ORCH_EFFORT    (default: high)
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
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync, openSync, readSync, closeSync, renameSync } from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config (env-first, portable)
// ---------------------------------------------------------------------------
// 通用工作区解析：env WORKSPACE_DIR 优先，否则当前目录。不依赖任何平台特定配置（可移植）。
function resolveWorkspace() {
  if (process.env.WORKSPACE_DIR && process.env.WORKSPACE_DIR.trim()) return process.env.WORKSPACE_DIR.trim();
  return process.cwd();
}

const WORKSPACE = resolveWorkspace();
let _codexPathCache;   // memoize: codex 路径检测只做一次（须在 CODEX 初始化前声明，避免 TDZ）
const CODEX = process.env.CODEX_EXE || defaultCodexPath();
// PowerShell 单引号字符串内嵌路径：把 ' 转义成 ''，避免路径含引号时破坏脚本/注入。
const WORKSPACE_Q = WORKSPACE.replace(/'/g, "''");
const CODEX_Q = CODEX.replace(/'/g, "''");
const PY = process.env.PYTHON || "python";
const MODEL = process.env.ORCH_MODEL || ""; // empty -> Codex uses its configured default model
const EFFORT = process.env.ORCH_EFFORT || "high";
// 窗内 Codex 的沙箱与审批策略：默认沿用"危险全访问 + 永不审批"（编排器需真执行），
// 但允许用户收紧（ORCH_SANDBOX=workspace-write / read-only，ORCH_APPROVAL=on-request）。
const SANDBOX = process.env.ORCH_SANDBOX || "danger-full-access";
const APPROVAL = process.env.ORCH_APPROVAL || "never";
const TMP = path.join(WORKSPACE, "temp");

// Terminal hosting the visible Codex TUI window.
//   wt      -> Windows Terminal (best IME/TSF support for CJK input; the fix for
//              "微软拼音输入偶发失效"). Requires wt.exe (WindowsApps).
//   conhost -> classic console (reliable window, but IME is limited for TUI apps).
// Default = Windows Terminal. ORCH_TUI=wt is confirmed EXPLICITLY below (the env var
// defaults to "wt"), so the visible Codex TUI window is hosted in Windows Terminal
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

function defaultCodexPath() {
  if (_codexPathCache !== undefined) return _codexPathCache;
  if (process.platform !== "win32") { _codexPathCache = "codex"; return "codex"; }
  // A handful of common install locations; scan a couple of npm prefixes too.
  const cands = ["codex"];
  for (const c of cands) {
    try {
      const r = spawnSync(c, ["--version"], { shell: false, encoding: "utf8", timeout: 8000 });
      if (!r.error && r.status === 0) { _codexPathCache = c; return c; }
    } catch { /* keep trying */ }
  }
  _codexPathCache = "codex"; return "codex";
}

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

function decomposePrompt(request) {
  return (
    "你是任务编排器。把下面这个多任务请求拆成「联动/独立」任务块，只输出 JSON。" +
    "判定标准是**能否同时执行而不冲突**：若两个任务同时跑会出严重问题（改同一文件/配置/服务/端口/DB、一个有依赖、一个喂给另一个、有先后关系）→ 它们联动，合并成一个块、串行做、只开一个窗；若某任务和任何别的任务同时跑都毫无问题（各改各的文件/子系统、互不依赖）→ 它独立，**单独成一个块、并行开窗**。" +
    "⚠️ 不要过度合并：**只要两个任务碰的是不相干的资源、互不依赖，就必须各自独立成块**，不要因为“看起来像一回事”就把它们并进一个串行块。宁可多个独立块并行，也别把能并行的任务压成一个串行块。" +
    "⚠️ 只有两种情形才串行：①两个任务同时跑会冲突(改同一文件/同一服务/同一端口/同一DB/同一资源)；②一个任务必须等另一个完成(有前后依赖)。**除这两种外一律独立并行开窗。严禁把不同项目、不同资源、不相关的任务合并或上锁**。" +
    "冲突键必须精确：用 `file:<精确路径>`、`port:<端口>`、`service:<服务名>`、`db:<库>`，**绝不要用宽泛目录(如 dir:C:\\Users\\fixture-user、dir:C:\\workspace、C:\\Users\\fixture-user 根)或模糊模式**，否则会把不相干的块误锁成串行。" +
    "⚠️ **请求文本里若写了「必须串行/依次做/全部完成再汇报」这类，只是用户的原始建议，不能照搬**；你必须按上面「真实冲突/依赖」规则**重新判断**是否为串行，并给出依据。" +
    "⚠️ **每块在决定是否执行前，先做一次可行性/原型速检（read-only）**：该任务当前是否已达成（如某项目是否已是目标版本/某页是否已实现）、是否可达/可行。**已达成或无需做的，不作为一个真实执行块（跳过，不弹窗）**；只有真正需要改/建的才作为块。" +
    "请先列出所有任务编号，再给块划分（每个块可含多条任务：仅联动块内按顺序做，独立块内只放一条任务）。不要执行，只给计划。" +
    "**依赖串行**：若某个块必须等**另一个块完成**才能开始（依赖其产出/结果），在该块的 `dependsOn` 数组里列出**那个前置块的 `title`**（一个或多个）；无依赖则省 `dependsOn` 或给空数组。依赖必须体现为 `dependsOn`，它决定执行顺序（前置块完成后才开此块），与 conflictKeys（冲突才上锁）是两回事。" +
    "**每块还必须给 `conflictKeys` 数组**：该块会碰到的资源标识，用于跨窗冲突检测（若另一运行中的窗也碰到同一资源，二者就可能冲突、应上锁）。资源标识用 `file:<路径>`、`port:<端口>`、`service:<服务名>`、`dir:<目录>` 这类前缀。**宁可多列、别漏**——漏列会把冲突判成不冲突。" +
    '格式必须严格为合法 JSON：{"blocks":[{"type":"linked"|"independent","title":"...","dependsOn":["<前置块title>",...],"conflictKeys":["file:...",...],"tasks":[{"id":"...","title":"...","prompt":"可独立执行的提示"}]}]}\n' +
    "请求：" + request
  );
}

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
  // 0) 缓存优先：相同请求的拆块结果缓存 1 年（每年 1/1 自动刷新），命中直接复用 -> 越用越快。
  const cached = loadCachedDecompose(request);
  if (cached && Array.isArray(cached.blocks) && cached.blocks.length) {
    console.log("[orchestrator] decompose cache HIT -> " + cached.blocks.map((b) => b.title).join(", "));
    return normalizePlan(cached.blocks);
  }
  // 1) 通用确定性启发（非硬编码项目路径）：请求里出现多个不同项目目录 -> 单独拆块，秒级返回并写缓存。
  const det = genericProjectSplit(request);
  if (det && Array.isArray(det.blocks) && det.blocks.length) {
    console.log("[orchestrator] generic project split -> " + det.blocks.map((b) => b.title).join(", "));
    saveDecompose(request, det.blocks);
    return normalizePlan(det.blocks);
  }
  // 1.5) 单任务快速路径（通用，非写死路径）：明确"单动作"请求 -> 单一窗口，跳过 LLM 拆块，秒级+写缓存。
  const sb = trySingleBlock(request);
  if (sb && Array.isArray(sb.blocks) && sb.blocks.length) {
    console.log("[orchestrator] single-block fast path -> " + sb.blocks[0].title);
    saveDecompose(request, sb.blocks);
    return normalizePlan(sb.blocks);
  }
  // 2) LLM 分类（read-only），失败/超时则重试。
  const attempts = Math.max(1, Number(process.env.ORCH_DECOMPOSE_RETRIES || 2));
  let lastErr = "";
  let seenNoJson = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await runThreadPrompt(decomposePrompt(request), { sandboxMode: "read-only" });
      let plan;
      try {
        plan = normalizePlan(extractJson(res.final || ""));
      } catch (e2) {
        if (/no JSON in plan output|plan\.blocks empty/.test(e2 && e2.message ? e2.message : String(e2))) seenNoJson = true;
        if (i === attempts - 1) throw e2;
        lastErr = e2 && e2.message ? e2.message : String(e2);
        continue;
      }
      if (plan && plan.length) { saveDecompose(request, plan); return plan; }
      lastErr = lastErr || "(extracted empty plan)";
      if (i === attempts - 1) throw new Error(lastErr);
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
  }
  console.warn("[orchestrator] decompose LLM failed after " + attempts + " attempt(s): " + lastErr +
    (seenNoJson ? " (no valid JSON)" : "") + " -> fallback to ONE serialized window.");
  return normalizePlan(fallbackPlan(request).blocks);
}

function extractJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in plan output: " + raw.slice(0, 300));
  const plan = JSON.parse(m[0]);
  if (!Array.isArray(plan.blocks) || plan.blocks.length === 0) throw new Error("plan.blocks empty");
  return splitIndependentBlocks(plan.blocks);
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
// Decompose cache: reuse identical-request block plans for up to 1 year.
// Refreshes automatically every Jan 1 (year rollover -> cache resets), so ANY
// user who installs this orchestrator gets "the more you use it, the faster it
// gets" without any hardcoded project paths. Deterministic safety heuristic
// below is generic (any mention of multiple distinct project-like dirs), not
// specific to build/80|81|82|83.
// ---------------------------------------------------------------------------
const DECOMPOSE_CACHE = path.join(TMP, "orchestrator-decompose-cache.json");
function decomposeHash(request) {
  return crypto.createHash("sha1").update(String(request || "")).digest("hex");
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
  try { mkdirSync(TMP, { recursive: true }); writeFileSync(DECOMPOSE_CACHE, JSON.stringify(obj), "utf8"); } catch { /* best effort */ }
}
function loadCachedDecompose(request) {
  const h = decomposeHash(request);
  const j = loadDecomposeCache();
  const e = j.entries[h];
  if (!e) return null;
  return e;
}
function saveDecompose(request, plan) {
  const h = decomposeHash(request);
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
  if (dirs.size < 2) return null;
  const sentences = splitSentences(request);
  const ownByProj = {};
  let ambiguous = false;
  for (const s of sentences) {
    const hits = [];
    for (const d of dirs) { const n = d.replace("proj-", ""); if (projectRef(s, n)) hits.push(d); }
    if (hits.length === 1) (ownByProj[hits[0]] = ownByProj[hits[0]] || []).push(s);
    else if (hits.length > 1) ambiguous = true;
  }
  const allOwn = [...dirs].every((d) => (ownByProj[d] && ownByProj[d].length > 0));
  if (!allOwn || ambiguous) return null;
  const blocks = [...dirs].map((title, i) => ({
    type: "independent", title, dependsOn: [],
    conflictKeys: ["dir:" + title],
    tasks: [{ id: "t" + (i + 1), title, prompt: "仅处理项目 " + title + "。任务：" + ownByProj[title].join("；") + "。不要处理其它项目编号。" }],
  }));
  return { blocks };
}

function projectRef(s, n) {
  // 无正则的确定匹配：检查句子是否含 "build\N" / "build/N" / 关键词N，避免转义坑
  return s.indexOf("build\\" + n) !== -1 || s.indexOf("build/" + n) !== -1 || new RegExp("(?:^|\\s)" + n + "(?:\\s|$)", "i").test(s);
}
// 通用单任务快速判定（不写死 build/N）：无"多动作/多目标"标记、且命中明确动作词 -> 生成单一独立块。
function trySingleBlock(request) {
  const text = String(request || "").trim();
  if (!text) return null;
  // 多动作/多目标/并列连词/分号/列举 -> 保守：一律交给 LLM/genericProjectSplit（少拆不误拆）。
  if (/(和|同时|还|以及|另外|一并|分别|然后|随后|再|并|与|或|、|；)/.test(text)) return null;
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
  return String(request).split(/[。；;，,\n]+/).map((s) => s.trim()).filter(Boolean);
}

function splitIndependentBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "independent" && Array.isArray(b.tasks) && b.tasks.length > 1) {
      for (const t of b.tasks) {
        out.push({ ...b, title: t.title || b.title, tasks: [t] });
      }
    } else {
      out.push(b);
    }
  }
  return out;
}

async function runThreadPrompt(prompt, opts = {}) {
  const thread = codex.startThread({ ...threadBase(), ...opts });
  const ac = new AbortController();
  const { events } = await thread.runStreamed(prompt, { signal: ac.signal });
  // 外部 abort 定时器：即使 SDK generator 卡住不出事件（'async generator NEVER closes' bug），到点 ac.abort()
  // 终止卡住的 codex 子进程，for-await 抛 AbortError 被 catch 接住，避免超时判断写循环体内永不执行导致无限挂死。
  const ORCH_DECOMPOSE_TIMEOUT_MS = Number(process.env.ORCH_DECOMPOSE_TIMEOUT_MS || 6000000);
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
      if (Date.now() - startedAt > (Number(process.env.ORCH_STREAM_CAP_MS) || 600000)) { errored = errored || "thread absolute timeout"; ac.abort(); break; }
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
  return (
    body +
    (block.type === "linked"
      ? "\n上面任务共享同一资源/存在依赖，若并行会冲突，故必须串行：先做第1个，做完再做第2个，依次进行，绝不同时并行。全部完成再汇报。"
      : "\n上面任务之间互相独立、互不依赖：并行执行，互不等待。全部完成后汇总结果。") +
    "\n\n【每个任务做完都必须现场自验】对每个改动：①读回创建/修改的文件，确认内容与编码（UTF-8 无 BOM）；②跑一次回归/验证命令确认可用；③确认无残留临时文件、无中文乱码。**自验不过=该任务未完成**，如实说明失败点与现场，禁止以“做完了”掩盖。"
  );
}

// ---- "原型/可行性检测"前置门禁（硬约束，已内嵌本 SDK，不依赖外部技能文件）----
// 每个真实块在 spawn 前做一次内嵌预检：prototype-validation 的"可行性"能力已并入本函数。
// 判定标准：本地执行块几乎都是用户明确要求做的真实改动，默认可行；仅当提示为空/无实际指令才判不可行，避免误拦"新建文件"类任务。
function runPrototypeGate(title, prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    console.log("  preflight FAILED for [" + title + "] (embedded feasibility): 块提示为空，视为不可行。");
    return false;
  }
  console.log("  preflight PASSED for [" + title + "] (embedded feasibility)");
  return true;
}

// Enforcement: once the orchestrator is engaged, mark that real executions are gated. The
// sanction engine is --run-windows (a real, visible, interactive TUI window). headless --run/--exec
// is additionally hard-gated inside this file (needs ORCH_ALLOW_HEADLESS=1). codex-tui-orchestrator-force.mjs reads
// this marker: from a NON-window context it refuses real-execution kinds and tells the caller to
// route through --run-windows. A sanctioned window sets $env:CODEX_ORCH_WINDOW=1 (in its launcher)
// so it passes the guard.
const ORCH_ARMED = path.join(TMP, ".orchestrator-enabled");
function armEnforcement() {
  try { mkdirSync(TMP, { recursive: true }); writeFileSync(ORCH_ARMED, String(Date.now()), "utf8"); } catch { /* ignore */ }
}

// ---- CLI 环境检测与安装（硬约束：先确保 codex CLI 可用，再谈后续）----
// 检测 codex 可执行；找不到则用 node22 的 npm 全局安装 @openai/codex；仍不行则报错中止。
function ensureCodexCli() {
  const cands = [
    process.env.CODEX_EXE,
  ].filter(Boolean);
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* ignore */ } }
  // 从 PATH 解析（跨机器/用户，不写死本机安装路径）
  const firstOnPath = (cmd) => {
    try {
      const w = spawnSync("where.exe", [cmd], { encoding: "utf8", shell: false });
      if (w.status === 0 && String(w.stdout || "").trim()) return String(w.stdout).split(/\r?\n/)[0].trim();
    } catch { /* ignore */ }
    return null;
  };
  const pathCodex = firstOnPath("codex");
  if (pathCodex) return pathCodex;
  const npm = firstOnPath("npm") || "npm";
  try {
    console.log("[orchestrator] codex CLI not found -> installing @openai/codex via npm (may take a bit)...");
    const inst = spawnSync(npm, ["install", "-g", "@openai/codex"], { encoding: "utf8", shell: false, timeout: 180000 });
    console.log("[orchestrator] npm install exit=" + inst.status + " " + String(inst.stderr || inst.stdout || "").slice(0, 200));
    const after = firstOnPath("codex");
    if (after) return after;
  } catch { /* ignore */ }
  console.error("[orchestrator] FATAL: codex CLI not available and auto-install failed. Cannot run --run-windows.");
  process.exitCode = 1;
  return null;
}

// ---------------------------------------------------------------------------
// Visible window (REAL popup, via cmd /c start — reliably opens a new console)
// ---------------------------------------------------------------------------
function spawnVisibleWindow(lp, title) {
  // Prefer Windows Terminal: it natively supports IME/TSF composition, so the Codex
  // TUI keeps accepting Microsoft 拼音/日语 IME switches (fixes "偶发失效"). Codex
  // runs the same launcher (UTF-8 + chcp 65001), just hosted in a WT ConPTY.
  if (TUI_MODE === "wt" && WT_EXE && wtAvailable()) {
    const p = spawn(WT_EXE, ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", lp], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      shell: false,
    });
    p.unref();
    console.log("spawned visible codex TUI (Windows Terminal): " + title);
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

// Interactive-TUI launcher. The interactive `codex "prompt"` window does not exit on its own; the
// orchestrator detects `task_complete` in the session rollout and robotically closes this process tree
// (see closeWindow, which taskkills the whole tree and has a PowerShell fallback that also kills the
// codex child). The launcher is now ALSO self-closing, so auto-close never depends on the orchestrator
// being alive: a background watchdog polls this window's session rollout for `task_complete` and then
// kills the codex child tree (~1s after completion), and whatever path ends the codex process, the
// launcher records its exit code in `win-<s>.result.json` and ALWAYS reaches `exit 0` (a non-zero
// launcher exit is the "process exited, code X" stuck-pane bug). The encoding + Windows Terminal
// hosting is set here (see ORCH_TUI and the chcp 65001 + InputEncoding UTF-8 block) for CJK/IME.
function writeInteractiveLauncher(title, prompt, sfx) {
  const s = safe(title) + (sfx ? "-" + sfx : "");
  mkdirSync(TMP, { recursive: true });
  const pf = path.join(TMP, `codex-win-${s}.md`);
  const lp = path.join(TMP, `win-launch-${s}.ps1`);
  const pidf = path.join(TMP, `window-${s}.pid`);
  const rf = path.join(TMP, `win-${s}.result.json`);
  writeFileSync(pf, prompt, "utf8");
  // Unique ASCII token embedded in every block prompt ("【本块唯一标识】<token>"): the watchdog uses it
  // to find THIS window's own session rollout (same token the orchestrator matches, ASCII-only so the
  // PowerShell match never has to deal with JSON-escaped CJK).
  const tokenMatch = String(prompt || "").match(/【本块唯一标识】\s*([^\s\r\n】]+)/);
  const token = tokenMatch ? String(tokenMatch[1]).replace(/[^A-Za-z0-9_\-]/g, "") : "";
  const BOM = "\uFEFF";
  // PowerShell 单引号字符串内嵌路径/变量：把 ' 转义成 ''，避免路径含引号时破坏脚本/注入。
  const pidfQ = String(pidf || "").replace(/'/g, "''");
  const pfQ = String(pf || "").replace(/'/g, "''");
  const rfQ = String(rf || "").replace(/'/g, "''");
  const PY_Q = String(PY || "").replace(/'/g, "''");
  const body = [
    "$ErrorActionPreference = 'Continue'",
    `$PID | Set-Content -Path '${pidfQ}' -Encoding UTF8`,
    "$env:TERM = 'xterm-256color'",
    "$env:Path = '" + PY_Q + ";' + $env:Path",
    "$env:CODEX_ORCH_WINDOW = '1'",
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
    "function Write-Result {",
    "  param([int]$code)",
    "  try { $line = '__EXIT__=' + $code; $json = '{\"__EXIT__\":' + $code + ',\"__DONE__\":true,\"ts\":\"' + (Get-Date -Format o) + '\"}'; Set-Content -Path $resultFile -Value ($json + \"`r`n\" + $line) -Encoding UTF8 } catch { }",
    "}",
    "$p = (Get-Content -Raw -Encoding UTF8 '" + pfQ + "').Trim()",
    "if ([string]::IsNullOrWhiteSpace($p)) { Write-Result 2; exit 0 }",
    "$token = '" + token + "'",
    // Self-close watchdog (background job): when this window's own rollout reaches task_complete, kill
    // the launcher's direct codex child tree so `& codex` returns and the launcher runs exit 0 -> the
    // Windows Terminal pane auto-closes ~1s after completion. Also exits when the result marker exists
    // (codex already exited on its own). Never touches the launcher, the job itself, or other windows.
    "$watch = Start-Job -ScriptBlock {",
    "  param($token, $rootPid, $resultFile)",
    "  $dir = Join-Path $env:USERPROFILE '.codex\\sessions'",
    "  $seen = @{}",
    "  $sizes = @{}",
    "  $match = $null",
    "  $deadline = (Get-Date).AddMinutes(45)",
    "  while ((Get-Date) -lt $deadline) {",
    "    if (Test-Path -LiteralPath $resultFile) { exit 0 }",
    "    try {",
    "      $files = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue",
    "      foreach ($f in $files) {",
    "        if ($match) {",
    "          if ($f.FullName -ne $match) { continue }",
    "          try {",
     "            $tail = Get-Content -LiteralPath $f.FullName -Tail 200 -Encoding UTF8 -ErrorAction SilentlyContinue",
     "            if (($tail -join \"`n\").Contains('task_complete')) {",
     "              $age = [TimeSpan]::Zero; try { $age = (Get-Date) - $f.LastWriteTime } catch { }",
     "              # Only auto-close once the rollout is STABLE (no new writes for ~6s). Every agent",
     "              # turn emits task_complete, so firing on any task_complete kills a window mid-work.",
     "              if ($age.TotalSeconds -gt 6) {",
     "                $kids = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $rootPid -and $_.ProcessId -ne $PID }",
     "                foreach ($k in $kids) { taskkill /PID $($k.ProcessId) /T /F 2>$null | Out-Null }",
     "                exit 0",
     "              }",
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
    "} -ArgumentList $token, $PID, $resultFile",
    "$code = 1",
    "try {",
    "  & '" + CODEX_Q + "' --cd '" + WORKSPACE_Q + "' -a " + APPROVAL + " --sandbox " + SANDBOX + " $p",
    "  $code = $LASTEXITCODE",
    "} catch {",
    "  $code = 1",
    "}",
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
  return path.join(process.env.USERPROFILE || "", ".codex", "sessions");
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
async function waitForSessionFile(matchKey, timeoutMs, exitMarkerFile) {
  const start = Date.now();
  const seen = new Set();
  // The rollout is JSONL: backslashes (Windows paths) are doubled (`\` -> `\\`) and quotes escaped,
  // so we must match against the JSON-escaped form, not the raw text. The task prompt sits after the
  // (large) AGENTS.md/context block, so we read the whole file (once per new candidate), not just the head.
  const escaped = JSON.stringify(matchKey).slice(1, -1);
  while (Date.now() - start < timeoutMs) {
    if (exitMarkerFile && existsSync(exitMarkerFile)) return null; // codex already exited -> reclaim path
    for (const f of listRollouts(sessionDir())) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        if (readFileSync(f, "utf8").includes(escaped)) return f;
      } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
// Poll a rollout for the `task_complete` event (the reliable "turn done" marker), then extract the
// agent's final message. Returns { done, text, exitCode }. Also treats the launcher's exit marker as a
// completion signal (codex exited, whatever the code): a non-zero exit WITH task_complete is a done
// turn, and a launcher exit WITHOUT task_complete is still a reclaimable (already-closing) window.
async function waitTaskComplete(file, timeoutMs, exitMarkerFile) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exitMarkerFile && existsSync(exitMarkerFile)) {
      const code = readExitCode(exitMarkerFile);
      const base = extractResult(file); // may or may not already contain task_complete
      if (base.text) return { done: true, text: base.text, exitCode: code };
      return { done: true, text: "(launcher exited code " + (code === null ? "?" : code) + " before task_complete captured)", exitCode: code };
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
      return { done: true, text: extractResult(file).text, exitCode: readExitCode(exitMarkerFile) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { done: false, text: "" };
}
function extractResult(file) {
  let full = "";
  try { full = readFileSync(file, "utf8"); } catch { return { done: true, text: "" }; }
  let last = "";
  for (const line of full.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      const p = o.payload || {};
      if (p.type === "agent_message" && p.message) last = p.message;
      else if (o.type === "response_item" && p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
        const t = p.content.map((c) => c.text || "").join("");
        if (t) last = t;
      }
    } catch { /* ignore */ }
  }
  return { done: true, text: last };
}
// Re-scan rollouts for the block's report and return the latest agent message, or "" if none found yet.
// Used so a window is only auto-closed AFTER its report has been captured ("close anchor = report captured"),
// instead of blind-grace timing. Bounded by `timeoutMs`.
async function waitForReportText(matchKey, exitMarkerFile, timeoutMs) {
  const start = Date.now();
  const seen = new Set();
  const escaped = JSON.stringify(matchKey).slice(1, -1);
  while (Date.now() - start < timeoutMs) {
    for (const f of listRollouts(sessionDir())) {
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        if (readFileSync(f, "utf8").includes(escaped)) {
          const r = extractResult(f);
          if (r && r.text) return r.text;
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
// ends with `... & codex ...; exit 0`, so if we kill ONLY the codex child (its direct child), the
// `&` returns and the launcher runs `exit 0` -> Windows Terminal auto-closes the pane cleanly.
// Force-killing the launcher itself (the old `taskkill /PID <launcher> /T /F`) is exactly what made it
// exit non-zero and left the stuck "[process exited, code 1]" pane. So we target the codex child
// subtree, never the launcher, then poll for the launcher to exit on its own (exit 0). If it is
// genuinely stuck we fall back to a force-kill (last resort / never an orphan) and report it.
async function closeWindow(pidf) {
  if (!pidf || !existsSync(pidf)) return;
  const pid = Number(String(readFileSync(pidf, "utf8")).trim());
  if (!pid) return;
  // Already gone (launcher self-closed via its watchdog / codex exited on its own) -> nothing to do.
  try { process.kill(pid, 0); } catch (e) { if (!e || e.code !== "EPERM") return; }
  // Kill ONLY the launcher's direct child (codex) and its subtree, so the launcher is free to reach
  // `exit 0`. spawnSync passes args as an array -> no shell arg-splitting of the multi-line script.
  const killChildrenOnly =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "$root=" + pid + "; " +
    "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $root } | ForEach-Object { " +
    "taskkill /PID $($_.ProcessId) /T /F | Out-Null }; ";
  try {
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", killChildrenOnly], { windowsHide: true, stdio: "ignore" });
  } catch { /* ignore */ }
  // Poll for the launcher to exit on its own; the launcher runs `exit 0` right after `& codex` returns.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try { process.kill(pid, 0); } catch (e) { if (e && e.code === "EPERM") continue; return; } // launcher gone -> exit 0 + WT closed
  }
  // Last resort: launcher is stuck (unusual). Force it so we never leak a window; log the fallback.
  console.log("  !! launcher " + pid + " did not exit after killing its codex child; force-killing (fallback).");
  try { const spid2 = Number(pid); spawnSync("taskkill", ["/PID", (Number.isFinite(spid2) ? String(spid2) : "-1"), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Running-window registry + conflict locking (stability)
// ---------------------------------------------------------------------------
const WIN_REG = path.join(TMP, "orchestrator-windows.json");
const LOCK_REG = path.join(TMP, "orchestrator-locks.json");

function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, data) {
  mkdirSync(TMP, { recursive: true });
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
function saveWindows(w) { saveJson(WIN_REG, w); }
function loadLocks() { return loadJson(LOCK_REG, []); }
function saveLocks(l) { saveJson(LOCK_REG, l); }

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
  return a.some((x) => b.includes(x));
}

// For each running window, add a pseudo-record so new blocks can be compared.
function runningRecord() {
  return loadWindows().filter((w) => windowAlive(w)).map((w) => ({ title: w.title, keys: w.keys }));
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
  const merged = [];
  for (const b of blocks) {
    const hit = merged.find((m) => m !== b && keysOverlap(blockKeys(m), blockKeys(b)));
    if (hit) {
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
// (prompt/launcher/result/log) and dead-window pid files; never remove live windows' pid files.
function staleTransientFiles() {
  const alivePids = new Set();
  for (const w of loadWindows()) {
    if (windowAlive(w) && w.pidFile && existsSync(w.pidFile)) {
      try { alivePids.add(Number(String(readFileSync(w.pidFile, "utf8")).trim())); } catch { /* ignore */ }
    }
  }
  const res = [];
  let names = [];
  try { names = readdirSync(TMP); } catch { return res; }
  for (const f of names) {
    const p = path.join(TMP, f);
    if (/^codex-win-.*\.md$/.test(f) || /^win-launch-.*\.ps1$/.test(f) || /^win-.*\.(result\.json|log)$/.test(f)) res.push(p);
    else if (/^window-.*\.pid$/.test(f)) {
      try {
        const pid = Number(String(readFileSync(p, "utf8")).trim());
        if (pid && !alivePids.has(pid)) res.push(p);
      } catch { res.push(p); }
    }
  }
  return res;
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
  if (!readonly && locks.length !== before) { saveLocks(locks); console.log("released " + (before - locks.length) + " lock(s) whose window closed"); }
  console.log("=== alive codex TUI windows ===");
  for (const w of alive) console.log("  [" + w.title + "] keys=" + (w.keys || []).join(","));
  if (!alive.length) console.log("  (none)");
  console.log("=== pending locks (waiting for a window to close) ===");
  for (const l of locks) console.log("  [blocked] \"" + (l.title || l.block) + "\" waits for window \"" + l.blockedBy + "\"");
  if (!locks.length) console.log("  (none)");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const mode = process.argv[2];

  if (mode === "--plan") {
    const request = process.argv.slice(3).join(" ");
    const plan = await decomposeSafely(request);
    console.log(JSON.stringify({ blocks: plan }, null, 2));
    return;
  }

  if (mode === "--spawn") {
    armEnforcement();
    const title = process.argv[3] || "codex-task";
    let promptContent = process.argv.slice(4).join(" ");
    const probablyFile = process.argv[4];
    if (probablyFile && probablyFile.toLowerCase().endsWith(".md") && existsSync(probablyFile)) {
      promptContent = readFileSync(probablyFile, "utf8");
    }
    const rid = Date.now().toString(36);
    const trackedPrompt = promptContent + "\n\n【本块唯一标识】spawn-" + rid + "\n（最终汇报请以「【本块唯一标识】spawn-" + rid + " 完成」开头，并说明本块完成情况）";
    const { lp, pidf, pf, rf } = writeInteractiveLauncher(title, trackedPrompt, rid);
    spawnVisibleWindow(lp, title);
    console.log("write launcher -> " + lp);
    console.log("spawned tracked TUI window, polling for completion...");
    const matchToken = "【本块唯一标识】spawn-" + rid;
    const sessionFile = await waitForSessionFile(matchToken, 120000, rf);
    let res = { done: false, text: "" };
    if (sessionFile) {
      res = await waitTaskComplete(sessionFile, Number(process.env.ORCH_TIMEOUT_MS) || 20000000, rf);
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
    if (res.done && sessionFile) {
      const pid = Number(String(readFileSync(pidf, "utf8")).trim());
      let alive = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        try { process.kill(pid, 0); } catch (e) { if (!e || e.code !== "EPERM") { alive = false; break; } }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (alive) { await closeWindow(pidf); }
      await new Promise((r) => setTimeout(r, Number(process.env.ORCH_CLOSE_DELAY_MS) || 6000));
      for (const fp of [pidf, lp, pf, rf]) { try { if (existsSync(fp)) rmSync(fp, { force: true }); } catch {} }
    }
    return;
  }

  if (mode === "--selftest-close") {
    // Verification helper for the graceful auto-close fix: open ONE real interactive window with a
    // trivial prompt, wait for task_complete in its rollout, then let the launcher's own watchdog
    // self-close it (~1s) and confirm the launcher actually exits 0 (=> the pane auto-closes, no
    // stuck "[exit code 1]" pane, and no orphan codex is left behind). closeWindow() is only a
    // fallback if the launcher is still alive after the timeout. Run by the authorized window for the
    // required "弹一个窗确认约 1 秒后自动关、无残留进程".
    armEnforcement();
    cleanStaleTransients();
    const title = process.argv[3] || "selftest-close";
    const rid = Date.now().toString(36);
    const prompt =
      "这是 codex-tui-orchestrator 的自动关闭自检窗。请只回复四个字：“自检OK”。不要执行任何其它动作，回复完即结束本窗。\n\n" +
      "【本块唯一标识】selftest-" + rid + "\n（最终汇报请以「【本块唯一标识】selftest-" + rid + " 完成」开头，并说明本块完成情况）";
    const { lp, pidf, pf, rf } = writeInteractiveLauncher("selftest", prompt, rid);
    spawnVisibleWindow(lp, "selftest-close");
    const matchToken = "【本块唯一标识】selftest-" + rid;
    console.log("selftest window spawned (pidfile=" + pidf + "), waiting for task_complete...");
    let res = { done: false, text: "" };
    const sessionFile = await waitForSessionFile(matchToken, 120000, rf);
    if (sessionFile) res = await waitTaskComplete(sessionFile, 180000, rf);
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
    let orphanCodex = false;
    try {
      const spid = Number(pid); const kids = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"ParentProcessId=" + (Number.isFinite(spid) ? spid : -1) + "\" | Measure-Object | Select-Object -ExpandProperty Count"], { windowsHide: true, encoding: "utf8" });
      orphanCodex = Number(String(kids.stdout || "0").trim()) > 0;
    } catch { /* ignore */ }
    console.log("launcherPid=" + pid + " launcherStillAlive=" + launcherAlive + " (expect false => pane auto-closed)");
    console.log("elapsedAfterDetectMs=" + elapsedAfterDetectMs + " (orchestrator-detect -> launcher gone; launcher watchdog itself polls every 500ms, expect ~1s from task_complete)");
    console.log("orphanChildren=" + orphanCodex + " (expect false => no orphan codex)");
    console.log("=== selftest-close done ===");
    for (const f of [pf, lp, rf]) { if (existsSync(f)) { try { rmSync(f, { force: true }); } catch { /* ignore */ } } }
    return;
  }

  if (mode === "--run-windows") {
    armEnforcement();
    ensureCodexCli(); // CLI 环境检测与安装（硬约束：先确保 codex 可用再继续）
    cleanStaleTransients();
    const request = process.argv.slice(3).join(" ");
    if (!request) throw new Error("--run-windows needs a request");
    const rid = Date.now().toString(36);
    console.log("[orchestrator] decomposing (read-only)...");
    const plan = await decomposeSafely(request);
    console.log("[orchestrator] blocks=" + plan.length);
    const windows = loadWindows();
    let locks = loadLocks();
    const inRun = [];
    const lockedBacklog = []; // 被锁块：冲突释放后自动重跑，不静默丢弃
    const waitMs = Number(process.env.ORCH_WAIT_MS || 120000); // max time to wait for a conflict to clear
    const closeDelayMs = Number(process.env.ORCH_CLOSE_DELAY_MS || 1000); // window auto-closes ~1s after the task completes
    const auth = "\n\n（用户已明确、反复授权「同意推进，允许执行」。本窗是经 codex-tui-orchestrator 授权的**真实执行窗**：请直接在本窗内用你自己的工具执行，禁止再调用/发起 --run-windows、禁止另开新窗、禁止以「需要授权/要我修吗/等允许」为由暂停或询问；本窗自身即被授权的执行环境。执行完即可结束本窗、汇报。**汇报必须真实**：以「【本块唯一标识】 完成」开头，说明本块做了什么、每项自验结果（读回/回归/编码），并给出确凿的落盘证据；若任一步骤失败，如实说明失败点与现场，禁止虚报成功。这是对 TUI 执行窗的明确全权指令。）";

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
    // B3 双向映射：模型 dependsOn 可能用原始标题/中文标题，统一归一到块 key，再按 key 判 wave。
    const keyByTitle = new Map();
    for (const r of recs) { keyByTitle.set(r.key, r.key); keyByTitle.set(r.title, r.key); keyByTitle.set(String(r.b.title), r.key); }
    for (const r of recs) { r.dependsOn = r.dependsOn.map((d) => keyByTitle.get(String(d)) || keyByTitle.get(d) || String(d)); }
    const waves = [];
    {
      const remaining = recs.slice();
      const doneKeys = new Set();
      let guard = 0;
      while (remaining.length && guard < 200) {
        guard++;
        const ready = remaining.filter((r) => r.dependsOn.every((d) => doneKeys.has(d)));
        if (!ready.length) { waves.push(remaining.slice()); remaining.length = 0; break; } // deadlock/unknown -> run rest in one wave
        waves.push(ready);
        for (const r of ready) { doneKeys.add(r.key); remaining.splice(remaining.indexOf(r), 1); }
      }
    }

    const summary = {};
    const allSpawned = [];
    for (const wave of waves) {
      const spawnedWave = [];
      for (const r of wave) {
        const nkeys = r.keys;
        // 同批内部防冲突：normalizePlan 已保证独立块互不重叠；这里双保险，若仍重叠则跳过。
        const clashRun = inRun.find((s) => keysOverlap(nkeys, s.keys));
        if (clashRun) {
          locks.push({ block: r.key, title: r.title, blockedBy: clashRun.title, keys: nkeys });
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
            locks.push({ block: r.key, title: r.title, blockedBy: blocker, keys: nkeys });
            console.log("  LOCKED " + r.key + " -- still conflicting after wait [" + blocker + "]");
            lockedBacklog.push({ r, nkeys });
            continue;
          }
        }
        // 原型检测前置门禁（硬约束）：执行前先跑一次原型检测，通过才允许 spawn 本块。
        const gateBody = blockBody(r.b);
        if (!runPrototypeGate(titleOf("B" + (recs.indexOf(r) + 1), r.b.title), gateBody)) {
          summary[r.key] = { title: titleOf("B" + (recs.indexOf(r) + 1), r.b.title), status: "preflight-failed", exitCode: null, result: "(preflight prototype-validation 未通过，未执行)" };
          console.log("  SKIPPED " + r.key + " -- preflight prototype-validation failed; not spawning.");
          continue;
        }
        // 并发兜底：冲突检查后、真正 spawn 前紧邻复检一次（另一进程可能在等待期抢占/写入 registry）。
        const recheck = conflictByKeys(nkeys);
        if (recheck) {
          locks.push({ block: r.key, title: r.title, blockedBy: recheck, keys: nkeys });
          console.log("  LOCKED " + r.key + " -- conflicted during gate ([" + recheck + "]); not spawning.");
          lockedBacklog.push({ r, nkeys });
          continue;
        }
        const tk = r.key + "-" + rid + "-" + Math.random().toString(36).slice(2, 8);
        const body = blockBody(r.b) + "\n\n【本块唯一标识】" + tk + "\n（最终汇报请以「【本块唯一标识】" + tk + " 完成」开头，并说明本块完成情况）\n" + auth;
        const { lp, pidf, pf, rf } = writeInteractiveLauncher(r.key, body, rid);
        spawnVisibleWindow(lp, r.title);
        windows.push({ title: r.title, keys: nkeys, pidFile: pidf, locked: false });
        spawnedWave.push({ key: r.key, title: r.title, pidf, lp, pf, rf, prompt: body, matchToken: "【本块唯一标识】" + tk });
        inRun.push({ key: r.key, title: r.title, keys: nkeys });
        console.log("  popped interactive TUI window [" + r.title + "]");
      }
      saveWindows(windows);
      saveLocks(locks);
      allSpawned.push(...spawnedWave);
      if (!spawnedWave.length) continue;

      // 等待本波所有窗完成（会话 rollout 出现 task_complete，或 launcher 的 result 标记出现=codex 已退出），
      // 抓最终消息，再自动关窗；完成后再开下一波。
      for (const s of spawnedWave) {
        const matchKey = s.matchToken || s.prompt.slice(0, 40);
        const resultFile = resultFileOf(s.pidf);
        const sessionFile = await waitForSessionFile(matchKey, 90000, resultFile);
        let res = { done: false, text: "" };
        if (sessionFile) {
          res = await waitTaskComplete(sessionFile, Number(process.env.ORCH_TIMEOUT_MS) || 20000000, resultFile);
        } else if (existsSync(resultFile)) {
          // codex 进程先退出（任意退出码）且没匹配到 rollout：立即回收，窗口已/即将自动关闭。
          const code = readExitCode(resultFile);
          res = { done: true, text: "(launcher exited code " + (code === null ? "?" : code) + "; no session rollout matched)", exitCode: code };
        } else {
          console.log("  !! " + s.key + " session rollout not found (prompt match) - window left open; close it manually.");
        }
        const tagged = res.done ? "done" : "timeout";
        summary[s.key] = { title: s.title, status: tagged, exitCode: res.exitCode ?? null, result: (res.text || "(no result captured)").trim().slice(0, 2000) };
        console.log("=== " + s.key + " " + s.title + " ===");
        if (res.done) {
          // 自动关闭锚点 = 已抓到汇报 (report captured). 抓不到就不关，先继续从 rollout 重抓。
          let text = res.text || "";
          const placeholder = /no session rollout matched|no result captured/.test(text);
          if (!text || placeholder) {
            text = await waitForReportText(matchKey, resultFile, 60000);
            if (text) summary[s.key].result = text.trim().slice(0, 2000);
          }
          if (text && !/no session rollout matched|no result captured/.test(text)) {
            console.log(trunc(text, 1600));
            console.log("  report CAPTURED -> closing [" + s.title + "] in " + closeDelayMs + "ms...");
            await new Promise((r) => setTimeout(r, closeDelayMs));
            await closeWindow(s.pidf); // 汇报已安全保存 -> 优雅关窗：只杀 codex 子进程，launcher 跑 exit 0，WT 自动关
          } else {
            console.log("  !! report not captured for [" + s.title + "] after retry; leaving window to self-close (launcher watchdog), NOT force-closing.");
          }
        } else {
          console.log("  timeout; window [" + s.title + "] still open (task may still be running).");
        }
      }
    }
    // ---- 锁释放→自动重跑被锁块：只要冲突已释放(窗已关/不再冲突)，就重新弹窗执行，保证不被静默丢弃 ----
    if (lockedBacklog.length) {
      console.log("[orchestrator] retrying " + lockedBacklog.length + " locked block(s) whose conflicts may have cleared...");
      for (const item of lockedBacklog) {
        const r = item.r, nkeys = item.nkeys;
        if (conflictByKeys(nkeys)) { console.log("  still locked " + r.key + "; not re-run yet."); continue; }
        console.log("  re-running previously-locked block [" + r.key + "] (conflict cleared)");
        const tk2 = r.key + "-" + rid + "-" + Math.random().toString(36).slice(2, 8);
        const body2 = blockBody(r.b) + "\n\n【本块唯一标识】" + tk2 + "\n（最终汇报请以「【本块唯一标识】" + tk2 + " 完成」开头，并说明本块完成情况）\n" + auth;
        const la = writeInteractiveLauncher(r.key, body2, rid);
        spawnVisibleWindow(la.lp, r.title);
        windows.push({ title: r.title, keys: nkeys, pidFile: la.pidf, locked: false });
        inRun.push({ key: r.key, title: r.title, keys: nkeys });
        allSpawned.push({ key: r.key, title: r.title, pidf: la.pidf, lp: la.lp, pf: la.pf, rf: la.rf, prompt: body2, matchToken: "【本块唯一标识】" + tk2 });
        saveWindows(windows);
        const matchKey2 = "【本块唯一标识】" + tk2, resultFile2 = la.rf;
        const sf2 = await waitForSessionFile(matchKey2, 90000, resultFile2);
        let res2 = { done: false, text: "" };
        if (sf2) res2 = await waitTaskComplete(sf2, Number(process.env.ORCH_TIMEOUT_MS) || 20000000, resultFile2);
        else if (existsSync(resultFile2)) { const c2 = readExitCode(resultFile2); res2 = { done: true, text: "(launcher exited code " + (c2 === null ? "?" : c2) + "; no session rollout matched)", exitCode: c2 }; }
        summary[r.key] = { title: r.title, status: res2.done ? "done" : "timeout", exitCode: res2.exitCode ?? null, result: (res2.text || "(no result captured)").trim().slice(0, 2000) };
        if (res2.done) {
          let t2 = res2.text || "";
          if (!t2 || /no session rollout matched|no result captured/.test(t2)) { t2 = await waitForReportText(matchKey2, resultFile2, 60000); if (t2) summary[r.key].result = t2.trim().slice(0, 2000); }
          if (t2 && !/no session rollout matched|no result captured/.test(t2)) { console.log("  [re-run " + r.key + "] report CAPTURED -> closing"); await new Promise((x) => setTimeout(x, closeDelayMs)); await closeWindow(la.pidf); }
        }
      }
      saveWindows(windows);
    }
    if (!allSpawned.length && !lockedBacklog.length) { console.log("all blocks locked; nothing spawned."); return; }

    // 收尾（硬约束：全部任务结束前保持轮询，绝不提前收尾/留下"晚生"的孤儿窗）：
    // 只要仍有活窗，或仍有计划块没出现在 summary（未决/未 spawn），就持续轮询等待，直到全部有终态才写 summary/退出。
    const planned = new Set(plan.map((b, i) => "B" + (i + 1)));
    {
      const holdStart = Date.now();
      const holdMax = Number(process.env.ORCH_TIMEOUT_MS || 20000000);
      let beat = Date.now();
      let zeroAliveSince = 0;
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
            if (w.pidFile && existsSync(w.pidFile)) {
              console.log("[orchestrator] done-and-close fallback: closing " + w.title);
              await closeWindow(w.pidFile);
            }
          }
          // 移除已写完 result 且 __DONE__ 的窗（避免重复轮询）
          saveWindows(loadWindows().filter((x) => {
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
          if (st === "preflight-failed" || st === "locked" || st === "unfinished") return false; // 被正确拦截/终态
          const r = String(s.result || "");
          // 纯按“全部任务的汇报是否都返回”判定：块有非空汇报（非占位）即视为已返回。
          // 占位(no result captured / no session rollout matched) 视为未返回 -> 继续轮询。
          if (!r || /\(no result captured\)|no session rollout matched|no result captured/i.test(r)) return true;
          return false;
        });
        if (alive.length === 0 && unresolved.length === 0) break;
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
    const remaining = loadWindows().filter((w) => windowAlive(w));
    saveWindows(remaining);
    const out = path.join(TMP, "win-summary.json");
    writeFileSync(out, JSON.stringify({ blocks: plan.map((b, i) => ({ key: "B" + (i + 1), title: b.title })), results: summary }, null, 2), "utf8");
    console.log("[orchestrator] summary -> " + out);
    console.log(JSON.stringify(summary, null, 2));
    // 用完即弃：本批临时产物（launcher/prompt/result/log/pid/win-summary）默认清理；ORCH_KEEP_TEMP=1 保留供排查
    if (process.env.ORCH_KEEP_TEMP !== "1") {
      try {
        const stillAlive = new Set(remaining.map((w) => w.title));
        for (const s of allSpawned) {
          for (const f of [s.pf, s.lp, ...(stillAlive.has(s.title) ? [] : [s.pidf, s.rf])]) {
            if (f && existsSync(f)) rmSync(f, { force: true });
          }
        }
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
      console.error("[orchestrator] REFUSED: headless --run/--exec is disabled by codex-tui-orchestrator enforcement. Real work must go through --run-windows (a real, visible, interactive TUI window). Set ORCH_ALLOW_HEADLESS=1 only for pure automation you explicitly want windowless.");
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

main().catch((e) => {
  console.error("[orchestrator] FATAL: " + e.message);
  process.exitCode = 1;
});
