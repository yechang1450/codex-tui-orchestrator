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
// 关键：按需读取（调用时读 env），与 orchestrate-sdk 的 resolveCodexHome 一致——跨用户/跨宿主下
// 即使 env 在 import 之后才被外部注入，也能取到正确路径，绝不固化于模块加载。
function cacheDir() {
  return process.env.ORCH_STATE_DIR
    || (process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'orchestrator') : path.join(os.homedir(), '.codex', 'orchestrator'));
}
function cacheFile() { return path.join(cacheDir(), '.agent-cache.json'); }

// agent 描述表：native=true 走内置（codex 用 @openai/codex-sdk）；其余为**占位**（探测/回退级别），
// 未安装对应 CLI 时 detect 返回 false -> 不可用，编排器自动回退 codex（不报错）。
// 甄别后的**市面主流编码终端 agent**：codex/claude/cursor/qwen/pi/zcode/aider/opencode。
// （已移除易混的 gemini(与 google LLM 同名、2026 有迁移 Antigravity) 与 aichat(仅终端聊天工具、非编码 agent)。
//  workbudy/codebuddy=腾讯、openclaw=agent gateway 等非纯 CLI 编码 agent，暂不作为可检测项。）
export const AGENTS = {
  codex: { id: 'codex', label: 'Codex CLI', detectBin: ['codex'], modelEnv: 'ORCH_MODEL', effortEnv: 'ORCH_EFFORT', completionMarker: '__ORCH_DONE__', native: true, verified: true },
  claude: { id: 'claude', label: 'Claude Code', detectBin: ['claude'], modelEnv: 'ANTHROPIC_MODEL', effortEnv: 'ORCH_CLAUD_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  opencode: { id: 'opencode', label: 'OpenCode', detectBin: ['opencode'], modelEnv: 'OPENCODE_MODEL', effortEnv: 'ORCH_OPENCODE_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  cursor: { id: 'cursor', label: 'Cursor CLI', detectBin: ['cursor-agent', 'cursor'], modelEnv: 'CURSOR_MODEL', effortEnv: 'ORCH_CURSOR_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  qwen: { id: 'qwen', label: 'Qwen Code', detectBin: ['qwen'], modelEnv: 'QWEN_MODEL', effortEnv: 'ORCH_QWEN_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  pi: { id: 'pi', label: 'Pi (pi-coding-agent)', detectBin: ['pi'], modelEnv: 'PI_MODEL', effortEnv: 'ORCH_PI_EFFORT', completionMarker: '__ORCH_DONE__', native: false, verified: true },
  zcode: { id: 'zcode', label: 'ZCode CLI', detectBin: ['zcode-cli', 'zcode'], modelEnv: 'ZCODE_MODEL', effortEnv: 'ORCH_ZCODE_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  aider: { id: 'aider', label: 'Aider', detectBin: ['aider'], modelEnv: 'AIDER_MODEL', effortEnv: 'ORCH_AIDER_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  codebuddy: { id: 'codebuddy', label: 'CodeBuddy (WorkBuddy)', detectBin: ['codebuddy'], modelEnv: 'CODEBUDDY_MODEL', effortEnv: 'ORCH_CODEBUDDY_EFFORT', completionMarker: '__ORCH_DONE__', native: false },
  openclaw: { id: 'openclaw', label: 'OpenClaw (gateway)', detectBin: ['openclaw'], modelEnv: 'OPENCLAW_MODEL', effortEnv: 'ORCH_OPENCLAW_EFFORT', completionMarker: '__ORCH_DONE__', native: false, verified: true },
};

function readCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return {}; }
}
function writeCache(c) {
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(c, null, 2) + '\n', 'utf8'); } catch {}
}

function binAvailable(bin) {
  if (!bin) return false;
  // 探测 agent CLI 是否可用：Windows 上 .ps1/.cmd shim（如 pi、openclaw）需经 shell 才能执行。
  // 先 shell:false（原始可执行/直调），失败后按平台回退 shell:true（仅 win32），不破坏非 Windows 通用性。
  try {
    const attempt = (shell) => spawnSync(bin, ['--version'], { shell, encoding: 'utf8', timeout: 8000, windowsHide: true });
    const r0 = attempt(false);
    if (!r0.error && r0.status === 0) return true;
    if (process.platform === 'win32') {
      const r1 = attempt(true);
      if (!r1.error && r1.status === 0) return true;
    }
    return false;
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

export function agentCacheFile() { return cacheFile(); }
// 主流 agent 通用启动参数（按 agent 各自 CLI 拼装；codex 保持原样）。
// 注意：pi/codebuddy 无 --cwd，工作目录由 launcher 先行 Set-Location 控制；这里只放 agent 自身的 CLI 参数。
export function launchArgs(agentConfig, o = {}) {
  const cwd = o.cwd || "";
  const approval = o.approval || "never";
  const sandbox = o.sandbox || "danger-full-access";
  switch (String(agentConfig.id || "")) {
    case "claude": return ["--cwd", cwd];
    case "cursor": return ["--cwd", cwd];
    case "qwen": return ["--cwd", cwd];
    case "pi": return [];
    case "zcode": return ["--cwd", cwd];
    case "aider": return ["--cwd", cwd];
    case "opencode": return ["--cwd", cwd];
    case "codebuddy": return [];
    case "openclaw": return ["agent", "--local"];
    case "codex":
    default: return ["--cd", cwd, "-a", approval, "--sandbox", sandbox];
  }
}
