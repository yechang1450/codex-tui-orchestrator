#!/usr/bin/env node
/**
 * agent-tui-orchestrator-force — technical enforcement gate for agent-tui-orchestrator.
 *
 * The ONLY sanctioned path for REAL execution (write / build / install / test / restart / any
 * command that changes state) is a real, visible, interactive agent TUI window launched by
 * `--run-windows`. This guard makes that a *checkable invariant*:
 *
 *   - `--enable`  : arm enforcement (write the marker). Once armed, real-execution kinds are
 *                   refused from any NON-window context.
 *   - `--disable` : disarm.
 *   - `--status`  : report armed state + currently alive execution windows.
 *   - `--assert <kind>` : returns 0 (ok) / 1 (refused). A sanctioned window sets
 *                   $env:ORCH_WINDOW=1 (its launcher does), so it passes. A non-window
 *                   context that tries a real-execution kind gets refused with a route hint.
 *   - `--verify <file>` : best-effort check whether a changed file was written inside a live
 *                   sanctioned window. Reliably PASS (in a window), reliably VIOLATION (no live
 *                   window / not in a window), or INDETERMINATE (live window exists but this is
 *                   not that context) — never fabricates a verdict it cannot support.
 *
 * A window is counted as ALIVE only if it is registered in `orchestrator-windows.json` AND its
 * pid file still exists AND `process.kill(pid, 0)` (in try/catch) confirms the process is really
 * running. A record whose pid file exists but whose process has already exited is treated as NOT
 * alive and dropped from results — the old "pid file exists == alive" check is gone.
 *
 * Combined with the hard gate on headless `--run`/`--exec` inside orchestrate-sdk.mjs
 * (ORCH_ALLOW_HEADLESS must be `1`, verboten for real work), this is the "once the skill is
 * enabled, real executions must go through the TUI window" enforcement.
 *
 * Usage (from scripts dir):  node agent-tui-orchestrator-force.mjs --status | --assert <kind> | --verify <file> | --enable | --disable
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, lstatSync, renameSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------- 工作区动态探测（不写死工作区绝对路径）----------
// 优先级：env WORKSPACE_DIR → process.cwd()（不再依赖外部通道配置）
function resolveWorkspace() {
  if (process.env.WORKSPACE_DIR && process.env.WORKSPACE_DIR.trim()) return process.env.WORKSPACE_DIR.trim();
  // Fail-closed: refusing to enforce against an unknown workspace prevents a cwd-based bypass.
  console.error("[force] FATAL: WORKSPACE_DIR not set; refusing to enforce against an unknown workspace (fail-closed). Set WORKSPACE_DIR to the orchestrator workspace.");
  process.exit(2);
}

const WORKSPACE = resolveWorkspace();
const TMP = path.join(WORKSPACE, "temp");
// plugin-owned runtime state lives in a stable family home, not workspace temp (override via ORCH_STATE_DIR).
const STATE_DIR = process.env.ORCH_STATE_DIR || path.join(os.homedir(), ".codex", "orchestrator");
const FLAG = path.join(STATE_DIR, ".orchestrator-enabled");
const WINDOWS_REG = path.join(STATE_DIR, "orchestrator-windows.json");

// 拒绝符号链接/非常规文件，防止伪造/篡改 registry 或 marker（安全网）。
function isRegularFile(p) { try { return lstatSync(p).isFile(); } catch { return false; } }
function armed() {
  if (!existsSync(FLAG) || !isRegularFile(FLAG)) return false;
  try { return /^\d+$/.test(readFileSync(FLAG, "utf8").trim()); } catch { return false; }
}
function loadJson(f, d) {
  try {
    if (!existsSync(f)) return d;
    if (!isRegularFile(f)) { console.error("[force] refusing non-regular/symlinked registry: " + f); return d; }
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.error("[force] registry read/parse failed: " + f + " :: " + e.message);
    return d;
  }
}

// Read the PID stored in a window's pid file. Returns 0 if the record has no pidFile, the pidFile
// is unreadable, or the stored value is not a positive integer.
function pidOf(w) {
  try {
    if (!w || !w.pidFile) return 0;
    if (!isRegularFile(w.pidFile)) return 0; // 拒绝符号链接 pidFile
    const p = Number(String(readFileSync(w.pidFile, "utf8")).trim());
    return Number.isFinite(p) && p >= 1 && p <= 4194304 ? p : 0; // 合理 PID 范围
  } catch { return 0; }
}
// process.kill(pid, 0) inside try/catch: true only if the process is actually alive (ESRCH/throw = dead).
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  if (process.platform === "win32") {
    // 防伪造：仅识别“编排器工作窗”的真实进程，而非任意 powershell/codex 像。
    try {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      const out = String(r.stdout || "");
      if (!/"\S+","\d+"/.test(out)) return false; // 该 PID 无对应行
      const img = String(out.split(/\r?\n/)[0] || "").split(",")[0].replace(/"/g, "");
      const codexish = /codex|powershell/i.test(img);
      if (!codexish) return false;
      // 命令行动态核对：编排器工作窗的 launcher 命令行是 `powershell -File ...\win-launch-*.ps1`
      // （其 agent 子进程命令行不含编排器字样），故需命中 win-launch-*.ps1；同时保留 orchestrate-sdk.mjs / --run-windows 以兼容旧判定。
      // 其它任意 powershell/codex 一律视作伪造，不得过门禁（fail-closed）。
      // pid 已在 pidOf() 校验为 1..4194304 的合法整数，直接内联进 -Filter 安全；用 `$args[0]` 传参会
      // 触发 PowerShell 的 -Command 解析异常（UnexpectedToken），导致 CommandLine 查询返回空，故改为内联。
      const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`], { encoding: "utf8", windowsHide: true });
      const cl = String(ps.stdout || "");
      return /win-launch-.*\.ps1/i.test(cl) || /orchestrate-sdk\.mjs/i.test(cl) || /--run-windows/i.test(cl);
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e && (e.code === "EPERM" || e.code === "EACCES") ? true : false; } // EPERM/EACCES = 存在但无权限, 不视为 dead
}
// Only windows whose process is really alive are returned. A record whose pidFile exists but whose
// process has already exited is treated as NOT alive and dropped from the result.
function liveWindows() {
  const reg = loadJson(WINDOWS_REG, []);
  if (!Array.isArray(reg)) { console.error("[force] refusing: orchestrator-windows.json is not an array (fail-closed)."); return []; }
  return reg.filter((w) => {
    if (!w.pidFile) return false;
    return pidAlive(pidOf(w));
  });
}

const mode = process.argv[2];

function runCli() {
  if (mode === "--enable") {
    mkdirSync(STATE_DIR, { recursive: true });
    // 小标记直接用 writeFileSync 覆盖写，避免 tmp+rename→rm→rename 间隙内标记缺失的竞态。
    writeFileSync(FLAG, String(Date.now()), "utf8");
    console.log("enforcement ARMED: real executions must go through --run-windows (visible interactive TUI).");
  } else if (mode === "--disable") {
    try { rmSync(FLAG, { force: true }); } catch { /* ignore */ }
    console.log("enforcement disarmed.");
  } else if (mode === "--status") {
    const wins = liveWindows();
    console.log("enforcement: " + (armed() ? "ARMED" : "disarmed"));
    console.log("alive execution windows: " + wins.length);
    for (const w of wins) console.log("  [" + w.title + "]");
  } else if (mode === "--assert") {
    const kind = String(process.argv[3] || "exec").toLowerCase();
    const realKinds = new Set(["exec", "write", "build", "install", "test", "restart", "start", "stop", "real", "all", "run"]);
    const readKinds = new Set(["read", "analyze", "plan", "view", "query", "search", "status", "list", "preview", "ls", "show", "check", "validate", "dry-run", "help"]);
    if (!armed()) { console.log("ok: orchestrator not armed."); process.exit(0); }
    if (process.env.ORCH_WINDOW === "1") {
      const wins = liveWindows();
      if (wins.length > 0) {
        console.log("ok: sanctioned orchestration window (" + wins.length + " live registered window(s)).");
        process.exit(0);
      }
      console.log(
        "REFUSED: ORCH_WINDOW=1 but no live registered orchestration window (orchestrator-windows.json). " +
          "The env var alone is not accepted — it may be forged. Route through  node orchestrate-sdk.mjs --run-windows \"<request>\"  (a real, visible, interactive agent TUI window)."
      );
      process.exit(1);
    }
    if (realKinds.has(kind)) {
      console.log(
        "REFUSED: real execution ('" + kind + "') from a NON-orchestrator context. " +
          "Route it through  node orchestrate-sdk.mjs --run-windows \"<request>\"  (a real, visible, interactive agent TUI window)."
      );
      process.exit(1);
    }
    // Unknown kind = fail-closed by default (a typo / future real kind must NOT silently pass).
    if (!readKinds.has(kind)) {
      console.log(
        "REFUSED: unknown execution kind ('" + kind + "'); refusing by default (fail-closed). " +
          "'read/analyze/plan/view/query/search/status/list/preview/ls/show/check/validate/dry-run/help' are read-only kinds."
      );
      process.exit(1);
    }
    console.log("ok: read-only kind.");
  } else if (mode === "--verify") {
    const file = process.argv[3];
    if (!file) { console.log("Usage: agent-tui-orchestrator-force.mjs --verify <file>"); process.exit(2); }
    if (!armed()) { console.log("verify: orchestrator not armed; in-window verification not applicable."); process.exit(0); }
    if (!existsSync(file)) { console.log("verify: file not found: " + file); process.exit(2); }
    // 归因精化：不再「任一活窗+文件在工作区内=放行」，而是按 conflictKeys 确定归因——
    //   仅 1 个活窗且其 conflictKeys 命中该文件 → PASS；
    //   多个活窗 → INDETERMINATE（无法唯一归因到某个窗）；
    //   无活窗 / 无命中 → VIOLATION（不能确认是窗内受权写入）。
    let realFile, ws;
    try {
      realFile = realpathSync(file);
      ws = realpathSync(WORKSPACE);
    } catch (e) {
      // fail-closed：路径解析失败无法确认归属，不得放行。
      console.log("VIOLATION: could not resolve the file/workspace path for in-window attribution (" + (e && e.message ? e.message : "unknown") + ").");
      process.exit(1);
    }
    if (realFile !== ws && !realFile.startsWith(ws + path.sep)) {
      console.log("VIOLATION: file is outside the orchestration workspace (" + WORKSPACE + "); cannot attribute to a sanctioned in-window write.");
      process.exit(1);
    }
    const wins = liveWindows();
    const lower = realFile.toLowerCase().replace(/\\/g, "/");
    const covering = wins.filter((w) => {
      const rawKeys = Array.isArray(w.keys) ? w.keys.map(String) : [];
      const keys = rawKeys.length ? rawKeys : ["__" + (w.title || "block")];
      return keys.some((kk) => {
        let raw = String(kk).trim().replace(/^__\s*/, "");
        if (!raw) return false;
        // 去掉 SDK 归约键的资源前缀（file:/dir:/port:/service:），再做路径感知匹配，不做裸子串匹配。
        raw = raw.replace(/^(file|dir|port|service):/i, "").trim();
        if (!raw) return false;
        const norm = raw.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
        if (!norm) return false;
        // 路径感知：精确 / 目录前缀(带分隔符) / 文件名；裸目录名(无分隔符)按路径段匹配。
        if (norm === lower) return true;
        if (lower.startsWith(norm + "/")) return true;
        if (norm === lower.split("/").pop()) return true;
        if (!norm.includes("/") && lower.includes("/" + norm + "/")) return true;
        return false;
      });
    });
    if (wins.length === 0) {
      console.log("VIOLATION: no live registered orchestration window exists; this change cannot be confirmed as an in-window write. Verify/re-run inside a window (node orchestrate-sdk.mjs --run-windows \"<request>\").");
      process.exit(1);
    }
    if (wins.length > 1) {
      console.log("INDETERMINATE: " + wins.length + " live orchestration window(s) exist; the change cannot be uniquely attributed to one window. Confirm per-window attribution for [" + wins.map((w) => w.title).join(", ") + "].");
      process.exit(2);
    }
    // 恰好一个活窗：按其 conflictKeys 归因。
    if (covering.length === 1) {
      console.log("PASS: change attributed to live sanctioned orchestration window [" + (wins[0].title || "?") + "] (conflictKeys hit).");
      process.exit(0);
    }
    console.log("VIOLATION: the only live orchestration window [" + (wins[0].title || "?") + "] does not cover this file's conflictKeys; cannot attribute to a sanctioned in-window write.");
    process.exit(1);
  } else {
    console.log("Usage: agent-tui-orchestrator-force.mjs --enable | --disable | --status | --assert <kind> | --verify <file>");
  }
}

// Only run the CLI when this module is the main entrypoint, so agent-tui-orchestrator-preflight.mjs can reuse armed()/liveWindows().
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) runCli();

export { armed, liveWindows, pidAlive, pidOf, WINDOWS_REG, TMP, FLAG, STATE_DIR };
