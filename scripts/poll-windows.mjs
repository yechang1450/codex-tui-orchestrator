#!/usr/bin/env node
// poll-windows.mjs — 持续轮询（硬约束·规则2）：发起方在 `--run-windows` 之后、结束本轮分析之前，
// 调用本脚本，它会一直轮询，直到「全部 TUI 窗已执行完毕并自动关闭」且「temp\win-summary.json 已写出全部块结果」，
// 才返回 0；否则持续打印心跳直到超时返回 1。发起方不得在此脚本返回前结束本轮。
//
// 用法:
//   node poll-windows.mjs [--timeoutMs <毫秒>] [--intervalMs <毫秒>]
// 例:
//   node poll-windows.mjs --timeoutMs 1800000 --intervalMs 5000

import { readFileSync, existsSync } from "node:fs";
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
const TERMINAL = new Set(["done", "ok", "completed", "timeout", "unfinished", "uncaptured", "preflight-failed", "locked", "done-and-close"]);

function loadSummary() {
  try { return JSON.parse(readFileSync(SUMMARY, "utf8")); } catch { return null; }
}
// 异步（不阻塞 event loop）：查询 SDK --status 统计存活窗。失败返回 -1（表示“未知”，不得当作全关）。
async function aliveCount() {
  try {
    // --readonly：只读查询，不释放/改写锁，避免与运行中的编排器竞态。
    const { stdout } = await execFileP(process.execPath, [SDK, "--status", "--readonly"], { encoding: "utf8", timeout: 15000 });
    // count lines like "  [B1:..." under the "alive codex TUI windows" section
    const lines = String(stdout || "").split(/\r?\n/);
    let inAlive = false, n = 0;
    for (const l of lines) {
      if (/=== alive codex TUI windows ===/.test(l)) { inAlive = true; continue; }
      if (/=== pending locks/.test(l)) break;
      if (inAlive && /^\s*\[/.test(l)) n++;
    }
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
    return TERMINAL.has(String(r.status || ""));
  });
}

let lastBeat = 0;
let stable = 0;
console.log("[poll-windows] started (timeout " + Math.round(timeoutMs / 1000) + "s, interval " + Math.round(intervalMs / 1000) + "s)");
while (Date.now() < deadline) {
  const alive = await aliveCount();
  const sum = loadSummary();
  const complete = summaryComplete(sum);
  const allClosed = alive === 0;
  if (allClosed && complete) {
    stable++;
    if (stable >= STABLE_CYCLES) {
      console.log("[poll-windows] ALL WINDOWS DONE + SUMMARY COMPLETE (stable) -> stopping poll.");
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

console.log("[poll-windows] TIMED OUT after " + Math.round(timeoutMs / 1000) + "s; some windows may still be running. Partial summary follows:");
const s = loadSummary();
if (s) process.stdout.write(JSON.stringify(s.results, null, 2) + "\n");
else console.log("[poll-windows] no win-summary.json found yet.");
process.exit(1);
