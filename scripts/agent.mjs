// agent.mjs —— Agent 抽象 + 本地 cache（v0.0.1 通用化骨架）
// 说明：Codex 专属内容完整保留在 codex 适配器（orchestrate-sdk 内）；本模块只负责
//      识别当前 agent（默认 codex）、探测其 CLI 是否可用，并把解析到的 agent 专属
//      配置缓存到本地 `scripts/.agent-cache.json`（越用越快，避免重复探测）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 通用化：agent 配置缓存放到稳定家目录（ORCH_STATE_DIR / CODEX_HOME），绝不落到插件脚本目录
// （插件目录会被 cachebuster 升级/重装整体清掉，且多用户/多设备下插件目录可能只读）。
// 优先 ORCH_STATE_DIR，其次 CODEX_HOME/orchestrator，最后回退 ~/.codex/orchestrator。
const CACHE_DIR = process.env.ORCH_STATE_DIR
  || (process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'orchestrator') : path.join(os.homedir(), '.codex', 'orchestrator'));
const CACHE_FILE = path.join(CACHE_DIR, '.agent-cache.json');

// agent 描述表：native=true 走内置（codex 用 @openai/codex-sdk）；其余为占位，
// 未安装对应 CLI 时 detect 返回 false -> 不可用，编排器自动只用可用项（不报错）。
export const AGENTS = {
  codex: { id: 'codex', label: 'Codex CLI', detectBin: ['codex'], modelEnv: 'ORCH_MODEL', effortEnv: 'ORCH_EFFORT', completionMarker: '__ORCH_DONE__', native: true },
  claude: { id: 'claude', label: 'Claude Code', detectBin: ['claude'], modelEnv: 'ANTHROPIC_MODEL', effortEnv: 'ORCH_CLAUD_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  gemini: { id: 'gemini', label: 'Gemini CLI', detectBin: ['gemini'], modelEnv: 'GEMINI_MODEL', effortEnv: 'ORCH_GEMINI_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  opencode: { id: 'opencode', label: 'OpenCode', detectBin: ['opencode'], modelEnv: 'OPENCODE_MODEL', effortEnv: 'ORCH_OPENCODE_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  aichat: { id: 'aichat', label: 'aichat', detectBin: ['aichat'], modelEnv: 'AICHAT_MODEL', effortEnv: 'ORCH_AICHAT_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
};

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeCache(c) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2) + '\n', 'utf8'); } catch {}
}

function binAvailable(bin) {
  if (!bin) return false;
  try {
    const r = spawnSync(bin, ['--version'], { shell: false, encoding: 'utf8', timeout: 8000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch { return false; }
}

/** 解析生效的 agent：默认 codex；ORCH_AGENT 指定；检测 CLI 可用性并把结果缓存。 */
export function resolveAgent() {
  const requested = String(process.env.ORCH_AGENT || 'codex').trim().toLowerCase();
  let id = AGENTS[requested] ? requested : 'codex';
  const cache = readCache();
  const key = 'agent:' + id;
  const prev = cache[key] || {};
  const desc = AGENTS[id];
  let bin = prev.bin && binAvailable(prev.bin) ? prev.bin : desc.detectBin.find(binAvailable) || (id === 'codex' ? 'codex' : null);
  // 请求的 agent CLI 不可用 -> 完整回退到 codex（bin 与 args 保持一致，否则会拿 codex 跑别的 agent 的参数）。
  if (!bin && id !== 'codex') {
    id = 'codex';
    const ck = 'agent:codex';
    const cprev = cache[ck] || {};
    const cdesc = AGENTS[ck] ? AGENTS[ck] : AGENTS.codex;
    const cbin = cprev.bin && binAvailable(cprev.bin) ? cprev.bin : cdesc.detectBin.find(binAvailable) || 'codex';
    const cres = { ...cdesc, bin: cbin, available: !!cbin, resolvedAt: cprev.resolvedAt || new Date().toISOString() };
    cache[ck] = cres;
    writeCache(cache);
    return { agent: 'codex', config: cres };
  }
  const resolved = { ...desc, bin, available: !!bin, resolvedAt: prev.resolvedAt || new Date().toISOString() };
  cache[key] = resolved;
  writeCache(cache);
  return { agent: id, config: resolved };
}

export function agentCacheFile() { return CACHE_FILE; }
// 主流 agent 通用启动参数（按 agent 各自 CLI 拼装；codex 保持原样）
export function launchArgs(agentConfig, o = {}) {
  const cwd = o.cwd || "";
  const approval = o.approval || "never";
  const sandbox = o.sandbox || "danger-full-access";
  switch (String(agentConfig.id || "")) {
    case "claude": return ["--cwd", cwd];
    case "gemini": return ["-c", cwd];
    case "opencode": return ["--cwd", cwd];
    case "aichat": return ["-c", cwd, "-s"];
    case "codex":
    default: return ["--cd", cwd, "-a", approval, "--sandbox", sandbox];
  }
}
