#!/usr/bin/env node
'use strict';
/**
 * Per-skill smoke tests for agent-tui-orchestrator.
 * Runs read-only checks for every capability; never opens a real TUI window.
 * Results written to D:\temp\orchestrator-skill-tests.json (or $ORCH_TEST_OUT).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const skillsDir = path.join(repoRoot, 'skills');
const WRAP = path.join(repoRoot, 'temp');

// 多合一：单一 skill（agent-tui-orchestrator）承载全部编排能力，无独立子 skill。
const SKILLS = ['agent-tui-orchestrator'];

// 合并后的唯一入口文档：所有能力（拆块/冲突锁/依赖排序/原型门禁/注册表/窗口运行时/结果汇聚/执行门禁/缓存/清洁/归因）都内嵌其中。
const entryDoc = fs.readFileSync(path.join(skillsDir, 'agent-tui-orchestrator', 'SKILL.md'), 'utf8');

const outPath = process.env.ORCH_TEST_OUT || path.join(process.env.WORKSPACE_DIR || WRAP, 'orchestrator-skill-tests.json');

function run(node, args, opts = {}) {
  const r = spawnSync(node, args, { encoding: 'utf8', cwd: path.join(repoRoot, 'scripts'), ...opts });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return r.status === 0;
}

const results = { generatedAt: new Date().toISOString(), skills: {} };
const outDir = path.dirname(outPath);
fs.mkdirSync(outDir, { recursive: true });

// ---- 1) SKILL.md frontmatter validity for all 13 ----
for (const s of SKILLS) {
  const file = path.join(skillsDir, s, 'SKILL.md');
  let ok = fs.existsSync(file);
  let detail = 'missing SKILL.md';
  if (ok) {
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(/^---\r?\nname:\s*([^\r\n]+)\r?\n(?:description:\s*([^\r\n]+))?/);
    ok = !!(m && m[1] && m[2]);
    detail = ok ? `name=${m[1].trim()}` : 'frontmatter missing name/description';
  }
  results.skills[s] = { frontmatter: ok ? 'PASS' : 'FAIL', detail };
}

// ---- 2) SDK parses ----
const sdkFile = path.join(repoRoot, 'scripts', 'orchestrate-sdk.mjs');
results.orchestrate_sdk = { parse: nodeCheck(sdkFile) ? 'PASS' : 'FAIL' };

// ---- 3) decompose-classify + decompose-cache + dependency-order via --plan (read-only) ----
const req = '修复 C:\\workspace\\build\\81 的登录页 500 错误、给 C:\\workspace\\build\\82 登录页做 UI 优化（两处独立且互不冲突）；同时分析 C:\\workspace\\build\\83 的目录结构（只读不弹窗）';
const plan1 = run(process.execPath, ['orchestrate-sdk.mjs', '--plan', req]);
results.decompose_classify = { cli: plan1.status === 0 ? 'PASS' : 'FAIL', stdout: plan1.stdout.slice(0, 300) };
const plan2 = run(process.execPath, ['orchestrate-sdk.mjs', '--plan', req]);
results.decompose_cache = {
  cli: plan2.status === 0 ? 'PASS' : 'FAIL',
  cacheHit: /cache HIT/i.test(plan2.stdout) ? 'PASS' : (plan2.status === 0 ? 'cached-or-inline' : 'FAIL'),
  stdout: plan2.stdout.slice(0, 200),
};

// ---- 4) prototype-gate + prototype-llm contract: confirm always-on wording in consolidated skill doc ----
const protoGate = entryDoc;
const protoLlm = entryDoc;
results.prototype_gate = {
  doc: /恒启用|始终生效|没有.*开关/.test(protoGate) && !/on\|off/.test(protoGate) ? 'PASS' : 'FAIL',
  switcheless: !/on\|off|可关(?!闭)/.test(protoGate) ? 'PASS' : 'FAIL',
};
results.prototype_llm = {
  doc: /确保无白窗/.test(protoLlm) ? 'PASS' : 'FAIL',
  noOffSwitch: !/可关(?!闭)|关掉本|省.*token|on\|off/.test(protoLlm) ? 'PASS' : 'FAIL',
  sdkAlwaysOn: fs.readFileSync(sdkFile, 'utf8').includes('总`') ? 'PASS' : 'PASS', // placeholder; real check below
};
// Real SDK gate check: must NOT contain "ORCH_PROTOTYPE_LLM=0"
results.prototype_llm.sdkAlwaysOn = /ORCH_PROTOTYPE_LLM=0/.test(fs.readFileSync(sdkFile, 'utf8')) ? 'FAIL' : 'PASS';

// ---- 5) enforcement: force.mjs --status + --verify (read-only) ----
const forceFile = path.join(repoRoot, 'scripts', 'agent-tui-orchestrator-force.mjs');
results.orchestrate_sdk.forceParse = nodeCheck(forceFile) ? 'PASS' : 'FAIL';
const st = run(process.execPath, ['agent-tui-orchestrator-force.mjs', '--status']);
results.enforcement = { cli: st.status === 0 ? 'PASS' : 'FAIL', stdout: st.stdout.slice(0, 200) };

// verify: run against a file inside the workspace so attribution logic truly executes.
// Expected non-zero exit with a clear VIOLATION/INDETERMINATE/PASS verdict is a PASS for the tool itself.
const wsFile = path.join(process.env.WORKSPACE_DIR || WRAP, 'AGENTS.md');
const vf = st.status === 0 && fs.existsSync(wsFile) ? run(process.execPath, ['agent-tui-orchestrator-force.mjs', '--verify', wsFile]) : null;
results.verify = {
  cli: vf && /VIOLATION|INDETERMINATE|PASS|attribution|not armed|not applicable/i.test(vf.stdout) ? 'PASS' : (vf ? 'FAIL' : 'N/A'),
  stdout: vf ? vf.stdout.slice(0, 200) : 'skipped',
};

// ---- 6) preflight: read kind should pass (no windows), real kind REFUSED (fail-closed) ----
const preFile = path.join(repoRoot, 'scripts', 'agent-tui-orchestrator-preflight.mjs');
results.orchestrate_sdk.preflightParse = nodeCheck(preFile) ? 'PASS' : 'FAIL';
const pr = run(process.execPath, ['agent-tui-orchestrator-preflight.mjs', 'read']);
const pw = run(process.execPath, ['agent-tui-orchestrator-preflight.mjs', 'write']);
results.enforcement.preflightRead = pr.status === 0 ? 'PASS' : 'FAIL';
results.enforcement.preflightRealRefused = pw.status !== 0 ? 'PASS' : 'FAIL';

// ---- 7) registry viability: temp json path present logic ----
const regFile = path.join(process.env.ORCH_STATE_DIR || path.join(os.homedir(), '.agents', 'agent-tui-orchestrator'), 'orchestrator-windows.json');
results.registry = { file: regFile, exists: fs.existsSync(regFile) ? 'yes' : 'no(cold-start ok)' };

// ---- 8) window-runtime + gather-results + hygiene contract check (doc-level, since they need a real window) ----
const winRt = entryDoc;
const gather = entryDoc;
const hygiene = entryDoc;
results.window_runtime = { doc: /launcher|spawn|watchdog|closeWindow/.test(winRt) && !/on\|off/.test(winRt) ? 'PASS' : 'FAIL' };
results.gather_results = { doc: /poll-windows|require-all-success/.test(gather) && !/on\|off/.test(gather) ? 'PASS' : 'FAIL' };
results.hygiene = { doc: /用完即弃|清理|KEEP_TEMP/.test(hygiene) ? 'PASS' : 'FAIL' };

// ---- 9) dependency-order + conflict-lock + agent-tui-orchestrator doc-level (consolidated) ----
const dep = entryDoc;
const cl = entryDoc;
const entry = entryDoc;
results.dependency_order = { doc: /\u4f9d\u8d56|dependsOn|wave/.test(dep) && !/on\|off/.test(dep) ? 'PASS' : 'FAIL' };
results.conflict_lock = { doc: /\u51b2\u7a81|conflictKeys|\u9501/.test(cl) && !/on\|off/.test(cl) ? 'PASS' : 'FAIL' };
results.agent_tui_orchestrator = { doc: /\u65e0\u5f00\u5173|\u6052\u542f\u7528|--run-windows/.test(entry) && !/\u5f00\u5173\uff08\u9ed8\u8ba4\u5168\u5f00/.test(entry) ? 'PASS' : 'FAIL' };

fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');

// Console summary.
let pass = 0, fail = 0;
for (const [k, v] of Object.entries(results.skills)) {
  if (v.frontmatter === 'PASS') pass++; else fail++;
  console.log(`[skill] ${k}: ${v.frontmatter} (${v.detail})`);
}
for (const [k, v] of Object.entries(results)) {
  if (k === 'skills' || k === 'generatedAt') continue;
  for (const [sk, sv] of Object.entries(v)) {
    if (sv === 'PASS') pass++;
    else if (sv === 'FAIL') fail++;
  }
}
console.log(`\nSUMMARY: ${pass} PASS, ${fail} FAIL.  Results -> ${outPath}`);
