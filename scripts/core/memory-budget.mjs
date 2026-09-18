/**
 * 动态内存预算（memory budget）
 *
 * 目标：不再用"机器内存 / 2000"硬算并发块数上限，而是按运行时的可用内存动态决定：
 *   - 规划期：若"全部块同时运行"的预估成本超过 (可用内存 - 底线)，就合并同一并行层里成本最大的两块，
 *     直到放得下（块内串行，峰值取 max，不求和）。
 *   - 执行期：每次开新块前复检；不够就 deferred（暂缓，不算失败）；有块结束后重检；
 *     若所有其它块都已结束仍不满足，则降级硬跑（degraded=hard-run），保证一轮跑完。
 *
 * 成本口径来自真机标定（2026-09-18，8 窗全绿）：单窗进程峰值中位 120 / 最大 129 MB，
 * 但含宿主、引擎与子进程的边际成本约 193 MB（轻载标定）；2026-09-18 的 7 窗并发实测在竞争下
 * 直接顶到钳制上限，说明轻载标定不能当作并发预算，因此默认每窗预算提高到 400 MB 并滚动修正。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_MIN_AVAILABLE_MB = 512;
export const DEFAULT_WINDOW_COST_MB = 400;
export const COST_MIN_MB = 256;
export const COST_MAX_MB = 800;
export const COST_SAMPLES_FOR_DOWNGRADE = 3;
export const PEAK_OVERHEAD_FACTOR = 1.5;   // 进程峰值 -> 边际成本（含宿主/引擎/子进程）
export const HARD_RUN_GRACE_MS = 2000;     // 无其它块在跑时的防竞态等待

/** 容量模式：dynamic（默认，内存预算）或 formula（旧的机器内存/2000 公式）。 */
export function resolveBudgetMode(env = process.env) {
  const raw = String(env.ORCH_CAPACITY_MODE || '').trim().toLowerCase();
  if (!raw || raw === 'dynamic') return 'dynamic';
  if (raw === 'formula') return 'formula';
  throw new Error('Invalid ORCH_CAPACITY_MODE: ' + raw + '; expected dynamic or formula');
}

export function budgetSettings(env = process.env) {
  const floorRaw = Number(env.ORCH_MIN_AVAILABLE_MB ?? DEFAULT_MIN_AVAILABLE_MB);
  const costRaw = Number(env.ORCH_WINDOW_COST_MB ?? DEFAULT_WINDOW_COST_MB);
  const floorMB = Number.isFinite(floorRaw) && floorRaw >= 0 ? Math.floor(floorRaw) : DEFAULT_MIN_AVAILABLE_MB;
  const windowCostMB = Number.isFinite(costRaw) && costRaw > 0 ? Math.round(costRaw) : DEFAULT_WINDOW_COST_MB;
  return {mode: resolveBudgetMode(env), floorMB, windowCostMB};
}

/** 可用内存：Node 的 os.freemem() 在 Windows 上就是 "Available MBytes"，与系统计数器一致。 */
export function availableMB() {
  return Math.round(os.freemem() / 1024 ** 2);
}

export function clampCost(mb) {
  const value = Number(mb);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WINDOW_COST_MB;
  return Math.max(COST_MIN_MB, Math.min(COST_MAX_MB, Math.round(value)));
}

/** 单块成本 = 一个窗的成本 + 块内各任务声明的附加预算取最大值（串行不叠加）。 */
export function blockCostMB(block, windowCostMB, taskCosts = {}) {
  const ids = (block?.taskIds && block.taskIds.length)
    ? block.taskIds
    : (block?.tasks || []).flatMap(task => task?.id ? [task.id] : (task?.sourceIds || []));
  const declared = ids
    .map(id => Number(taskCosts?.[id]?.memoryMB ?? taskCosts?.[id] ?? 0))
    .filter(value => Number.isFinite(value) && value > 0);
  const extra = declared.length ? Math.max(...declared) : 0;
  return windowCostMB + extra;
}

/** 准入判据：加入本块后，可用内存仍不低于底线。floorMB<=0 表示关闭底线。 */
export function admissionOk({availableMB: available, runningCostMB = 0, blockCostMB: cost, floorMB}) {
  const floor = Number(floorMB) || 0;
  if (floor <= 0) return true;
  return (Number(available) || 0) - (Number(runningCostMB) || 0) - (Number(cost) || 0) >= floor;
}

export function budgetStateFile(stateDir) {
  return path.join(stateDir, 'memory-budget.json');
}

export function loadBudgetState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw === 'object') return {windowCostMB: clampCost(raw.windowCostMB), samples: Number(raw.samples) || 0};
  } catch { /* 首次运行或文件损坏 -> 默认值 */ }
  return {windowCostMB: DEFAULT_WINDOW_COST_MB, samples: 0};
}

export function saveBudgetState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({schema: 1, windowCostMB: clampCost(state.windowCostMB), samples: Number(state.samples) || 0, updatedAt: new Date().toISOString()}, null, 2) + '\n', 'utf8');
  } catch { /* 预算状态是尽力而为的缓存 */ }
}

/**
 * 滚动修正：一次干净窗口样本 -> 新成本。
 * 升得快（一次超了就升），降得慢（至少 COST_SAMPLES_FOR_DOWNGRADE 个样本才允许下调），并钳制在 [160,600]。
 */
export function updateRollingCost(state, sample) {
  const current = clampCost(state?.windowCostMB ?? DEFAULT_WINDOW_COST_MB);
  const samples = (Number(state?.samples) || 0) + 1;
  const observed = Number(sample?.observedMB);
  if (!Number.isFinite(observed) || observed <= 0) return {windowCostMB: current, samples};
  const target = clampCost(observed);
  let next = current;
  if (target > current) next = target;
  else if (target < current && samples >= COST_SAMPLES_FOR_DOWNGRADE) next = Math.max(COST_MIN_MB, Math.floor((current + target) / 2));
  return {windowCostMB: clampCost(next), samples};
}

/** 由窗口进程峰值推算边际成本（进程峰值 × 开销系数，并与"可用内存下降量"交叉校验取较大者）。 */
export function observedCostMB({processPeakMB = 0, availableDeltaMB = 0} = {}) {
  const fromPeak = Number(processPeakMB) > 0 ? Number(processPeakMB) * PEAK_OVERHEAD_FACTOR : 0;
  const fromDelta = Number(availableDeltaMB) > 0 ? Number(availableDeltaMB) : 0;
  const observed = Math.max(fromPeak, fromDelta);
  return observed > 0 ? clampCost(observed) : 0;
}
