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

if (!armed()) {
  console.log("preflight: 未启用 (orchestrator not armed; enforcement disabled).");
  process.exit(0);
}

const inWindow = process.env.CODEX_ORCH_WINDOW === "1" && liveWindows().length > 0;
if (inWindow) {
  console.log("ok: sanctioned orchestration window; '" + (kind || "?") + "' may proceed.");
  process.exit(0);
}

if (realKinds.has(kind)) {
  console.log(
    "REFUSED: preflight '" + kind + "' is a real-execution kind but this is NOT a sanctioned orchestration window. " +
      "Route through  node orchestrate-sdk.mjs --run-windows \"<request>\"  (a real, visible, interactive Codex TUI window)."
  );
  process.exit(1);
}

console.log("ok: read-only kind (" + (kind || "none") + ").");
process.exit(0);
