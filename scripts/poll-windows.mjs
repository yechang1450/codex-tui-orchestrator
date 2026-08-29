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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 用脚本自身目录定位 SDK，避免写死本技能安装绝对路径（工作区迁移/复制到 kit 后依然成立）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SDK = path.join(ROOT, "orchestrate-sdk.mjs");
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
const intervalMs = arg("--intervalMs", 5000);
const deadline = Date.now() + timeoutMs;

function loadSummary() {
  try { return JSON.parse(readFileSync(SUMMARY, "utf8")); } catch { return null; }
}
function aliveCount() {
  try {
    const out = execFileSync(process.execPath, [SDK, "--status"], { encoding: "utf8", timeout: 20000 });
    // count lines like "  [B1:..." under the "alive codex TUI windows" section
    const lines = out.split(/\r?\n/);
    let inAlive = false, n = 0;
    for (const l of lines) {
      if (/=== alive codex TUI windows ===/.test(l)) { inAlive = true; continue; }
      if (/=== pending locks/.test(l)) break;
      if (inAlive && /^\s*\[[A-Za-z0-9]+:/.test(l)) n++;
    }
    return n;
  } catch { return -1; }
}

function summaryComplete(sum) {
  if (!sum || !sum.results) return false;
  const statuses = Object.values(sum.results).map((r) => String(r.status || ""));
  return statuses.length > 0 && statuses.every((s) => s !== "pending" && s !== "timeout");
}

let lastBeat = 0;
console.log("[poll-windows] started (timeout " + Math.round(timeoutMs / 1000) + "s, interval " + Math.round(intervalMs / 1000) + "s)");
while (Date.now() < deadline) {
  const alive = aliveCount();
  const sum = loadSummary();
  const complete = summaryComplete(sum);
  const allClosed = alive === 0;
  if ((allClosed && complete) || (complete && alive === 0)) {
    console.log("[poll-windows] ALL WINDOWS DONE + SUMMARY COMPLETE -> stopping poll.");
    if (sum) {
      console.log("[poll-windows] win-summary.json:");
      process.stdout.write(JSON.stringify(sum.results, null, 2) + "\n");
    }
    process.exit(0);
  }
  const now = Date.now();
  if (now - lastBeat >= 5000) {
    lastBeat = now;
    console.log("[poll-windows] heartbeat: aliveWindows=" + (alive < 0 ? "?" : alive) + " summary=" + (sum ? "present(" + Object.keys(sum.results || {}).length + ")" : "absent") + "  elapsed=" + Math.round((now - (Date.now() - timeoutMs)) / 1000) + "s");
  }
  const wait = new Promise((r) => setTimeout(r, intervalMs));
  await wait;
}

console.log("[poll-windows] TIMED OUT after " + Math.round(timeoutMs / 1000) + "s; some windows may still be running. Partial summary follows:");
const s = loadSummary();
if (s) process.stdout.write(JSON.stringify(s.results, null, 2) + "\n");
else console.log("[poll-windows] no win-summary.json found yet.");
process.exit(1);
