#!/usr/bin/env node
/**
 * codex-tui-orchestrator-preflight — read-only gate that decides whether a requested kind may be executed now.
 *
 *   node codex-tui-orchestrator-preflight.mjs <write|build|install|test|restart|run|all>
 *
 * Reuses codex-tui-orchestrator-force.mjs's armed()/liveWindows() (the same enforcement state the guard uses):
 *   - orchestrator not armed        -> prints 未启用 and exits 0.
 *   - current context IS a sanctioned
 *     execution window              -> prints ok, exits 0.
 *   - real-execution kind but NOT a
 *     sanctioned window             -> prints REFUSED + route hint, exits 1.
 *   - read-only kind                -> prints ok, exits 0.
 *
 * This only makes a before-you-run decision; it does NOT touch the orchestrator's
 * block/dependency/result-recycling logic.
 */
import { armed, liveWindows } from "./codex-tui-orchestrator-force.mjs";

const kind = String(process.argv[2] || "").toLowerCase();
const realKinds = new Set(["exec", "write", "build", "install", "test", "restart", "start", "stop", "real", "all", "run"]);
const readKinds = new Set(["read", "analyze", "plan", "view", "query", "search", "status", "list", "preview", "ls", "show", "check", "validate", "dry-run", "help"]);

// 统一校验：空/未知 kind 一律报错退出 1（不因窗口状态放宽），决策输出统一走 stdout 供下游捕获。
if (!kind) {
  console.log("[preflight] error: missing kind argument (real: " + [...realKinds].join("/") + " | read-only: " + [...readKinds].join("/") + ").");
  process.exit(1);
}
if (!realKinds.has(kind) && !readKinds.has(kind)) {
  console.log("[preflight] invalid/unknown kind: '" + kind + "' (allowed real: " + [...realKinds].join("/") + " | read-only: " + [...readKinds].join("/") + ").");
  process.exit(1);
}

if (!armed()) {
  console.log("preflight: 未启用 (orchestrator not armed; enforcement disabled).");
  process.exit(0);
}

// liveWindows() 为跨进程快照（存在竞态），此处是 before-you-run 的近似判定；如需严格应在执行前紧邻复验。
const envWindow = process.env.CODEX_ORCH_WINDOW === "1";
const alive = liveWindows().length;
// 与 force --assert 保持一致：CODEX_ORCH_WINDOW=1 但无活窗 → env 单独不可采信，一律 REFUSED（含只读 kind）。
if (envWindow && alive === 0) {
  console.log(
    "REFUSED: CODEX_ORCH_WINDOW=1 but no live registered orchestration window (env var alone is not accepted; may be forged). " +
      "Route through  node orchestrate-sdk.mjs --run-windows \"<request>\"  (a real, visible, interactive Codex TUI window)."
  );
  process.exit(1);
}
if (alive > 0) {
  console.log("ok: sanctioned orchestration window; '" + kind + "' may proceed.");
  process.exit(0);
}

if (realKinds.has(kind)) {
  console.log(
    "REFUSED: preflight '" + kind + "' is a real-execution kind but this is NOT a sanctioned orchestration window. " +
      "Route through  node orchestrate-sdk.mjs --run-windows \"<request>\"  (a real, visible, interactive Codex TUI window)."
  );
  process.exit(1);
}

console.log("ok: read-only kind (" + kind + ").");
process.exit(0);
