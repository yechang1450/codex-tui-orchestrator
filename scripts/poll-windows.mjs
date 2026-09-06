#!/usr/bin/env node
// poll-windows.mjs — 持续轮询（硬约束·规则2）：发起方在 `--run-windows` 之后、结束本轮分析之前，
// 调用本脚本，它会一直轮询，直到「全部 TUI 窗已执行完毕并自动关闭」且「temp\win-summary.json 已写出全部块结果」，
// 才返回 0；否则持续打印心跳直到超时返回 1。发起方不得在此脚本返回前结束本轮。
//
// 用法:
//   node poll-windows.mjs [--timeoutMs <毫秒>] [--intervalMs <毫秒>]
// 例:
//   node poll-windows.mjs --timeoutMs 1800000 --intervalMs 5000

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// 用脚本自身目录定位 SDK，避免写死本技能安装绝对路径（工作区迁移/复制到 kit 后依然成立）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SDK = path.join(ROOT, "orchestrate-sdk.mjs");
const execFileP = promisify(execFile);
// 工作区动态探测（不写死工作区绝对路径）：env WORKSPACE_DIR → process.cwd()
const WORKSPACE = process.env.WORKSPACE_DIR && process.env.WORKSPACE_DIR.trim() ? process.env.WORKSPACE_DIR.trim() : process.cwd();
const TMP = path.join(WORKSPACE, "temp");
const SUMMARY = path.join(TMP, "win-summary.json");

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return dflt;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}
const timeoutMs = arg("--timeoutMs", 30 * 60 * 1000);
const intervalMs = Math.max(500, arg("--intervalMs", 5000));
const start = Date.now();
const deadline = start + timeoutMs;
// 全关+summary 完整需连续 2 个 cycle 稳定才退出，避免“窗刚关但 summary 未刷新”竞态。
const STABLE_CYCLES = 2;
// 终态集合：只有这些 status 才算“已定案”，错误/未知状态不得当作 complete 提前退出。
const TERMINAL = new Set(["done", "ok", "completed", "done-retried", "done-on-disk", "failed", "timeout", "unfinished", "uncaptured", "preflight-failed", "locked", "unlocked", "done-and-close", "popup-failed"]);
// --require-all-success 的"可收尾"集合：真正成功 {done,ok,completed} + 被正确跳过/锁定 {preflight-failed, locked, unlocked}。
// uncaptured / timeout / unfinished / failed 视为失败阻塞 -> poll 继续等，超时返回 1（不装成功）。
const SUCCESS = new Set(["done", "ok", "completed", "done-retried", "done-on-disk", "preflight-failed", "locked", "unlocked"]);
const requireAllSuccess = process.argv.includes("--require-all-success");

function loadSummary() {
  try { return JSON.parse(readFileSync(SUMMARY, "utf8")); } catch { return null; }
}
// 本轮新鲜度：记录 poll 启动时 summary 的 mtime。若 summary 是上一轮残留（未在本轮被更新），不得当作已 complete。
const summaryStartMtime = existsSync(SUMMARY) ? statSync(SUMMARY).mtimeMs : 0;
function summaryFresh() {
  try { return existsSync(SUMMARY) && statSync(SUMMARY).mtimeMs > summaryStartMtime; }
  catch { return false; }
}
// 异步（不阻塞 event loop）：查询 SDK --status 统计存活窗。失败返回 -1（表示“未知”，不得当作全关）。
async function aliveCount() {
  try {
    // --readonly：只读查询，不释放/改写锁，避免与运行中的编排器竞态。
    const { stdout } = await execFileP(process.execPath, [SDK, "--status", "--readonly"], { encoding: "utf8", timeout: 15000 });
    // count lines like "  [B1:..." under the "alive agent TUI windows" section
    const lines = String(stdout || "").split(/\r?\n/);
    let inAlive = false, n = 0, sawHeader = false;
    for (const l of lines) {
      if (/=== alive agent TUI windows ===/.test(l)) { inAlive = true; sawHeader = true; continue; }
      if (/=== pending locks/.test(l)) break;
      if (inAlive && /^\s*\[/.test(l)) n++;
    }
    if (!sawHeader) return -1; // header 没匹配到 = 解析失败（非“全关”），不得当作 0
    return n;
  } catch { return -1; }
}

function summaryComplete(sum) {
  if (!sum || !sum.results || typeof sum.results !== "object") return false;
  const entries = Object.entries(sum.results);
  if (entries.length === 0) return false;
  return entries.every(([k, r]) => {
    if (!k) return false;
    if (!r || typeof r !== "object") return false;
    const st = String(r.status || "");
    // 全部成功模式：非 success 状态即视为未完成（继续等）。
    if (requireAllSuccess) return SUCCESS.has(st);
    return TERMINAL.has(st);
  });
}
function summaryTerminal(sum) {
  if (!sum || !sum.results || typeof sum.results !== "object") return false;
  const entries = Object.entries(sum.results);
  if (entries.length === 0) return false;
  return entries.every(([k, r]) => {
    if (!k || !r || typeof r !== "object") return false;
    return TERMINAL.has(String(r.status || ""));
  });
}

function failures(sum) {
  const out = [];
  if (sum && sum.results && typeof sum.results === "object") {
    for (const [k, r] of Object.entries(sum.results)) {
      const st = r && String(r.status || "");
      if (!SUCCESS.has(st)) out.push(k + ":" + (st || "(no status)"));
    }
  }
  return out;
}

let lastBeat = 0;
let stable = 0;
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
console.log("[poll-windows] started (timeout " + Math.round(timeoutMs / 1000) + "s, interval " + Math.round(intervalMs / 1000) + "s)");
while (Date.now() < deadline) {
  const alive = await aliveCount();
  const sum = loadSummary();
  const complete = summaryFresh() && summaryComplete(sum);
  const allClosed = alive === 0;
  // 已定案但含失败（require-all-success 下）：所有窗已关 + summary 终态非全成功 -> 立即返回 1，
  // 不再等到超时才暴露（此前 popup-failed/failed 会让 poll 空等到超时）。
  if (requireAllSuccess && allClosed && summaryFresh() && summaryTerminal(sum) && !complete) {
    const f = failures(sum);
    console.log("[poll-windows] ALL WINDOWS CLOSED but not all blocks succeeded -> non-success blocks: " + (f.length ? f.join(", ") : "(none)"));
    process.exit(1);
  }
  // When zero windows are alive, a complete summary is authoritative even if it was written
  // just before poll started (no-window / fast run): do not hang on the mtime race.
  const done = complete || (allClosed && summaryComplete(sum));
  if (allClosed && done) {
    stable++;
    if (stable >= STABLE_CYCLES) {
      console.log("[poll-windows] ALL WINDOWS DONE + SUMMARY COMPLETE (stable) -> stopping poll.");
      if (requireAllSuccess) console.log("[poll-windows] all blocks returned SUCCESS -> GUI may end turn.");
      else console.log("[poll-windows] all blocks terminal (may include failures) -> aggregation ready.");
      if (sum) {
        console.log("[poll-windows] win-summary.json:");
        process.stdout.write(JSON.stringify(sum.results, null, 2) + "\n");
      }
      process.exit(0);
    }
    console.log("[poll-windows] ready-to-exit cycle observed, confirming stability...");
  } else {
    stable = 0;
  }
  const now = Date.now();
  if (now - lastBeat >= 5000) {
    lastBeat = now;
    console.log("[poll-windows] heartbeat: aliveWindows=" + (alive < 0 ? "?" : alive) + " summary=" + (sum ? "present(" + Object.keys(sum.results || {}).length + ")" : "absent") + "  elapsed=" + Math.round((now - start) / 1000) + "s");
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}

console.log("[poll-windows] TIMED OUT after " + Math.round(timeoutMs / 1000) + "s" + (requireAllSuccess ? "; NOT all blocks succeeded" : "; some windows may still be running") + ". Partial summary follows:");
if (requireAllSuccess) { const f = failures(loadSummary()); console.log("[poll-windows] non-success blocks: " + (f.length ? f.join(", ") : "(none yet)")); }
const s = loadSummary();
if (s) process.stdout.write(JSON.stringify(s.results, null, 2) + "\n");
else console.log("[poll-windows] no win-summary.json found yet.");
process.exit(1);
}

export { TERMINAL, SUCCESS, loadSummary, summaryFresh, summaryComplete, summaryTerminal, failures };


