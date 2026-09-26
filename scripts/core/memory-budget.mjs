/**
 * 动态内存预算（memory budget）
 *
 * 目标：不再用固定的机器内存公式改写并发计划，而是按运行时的可用内存动态准入：
 *   - 规划期只确认依赖、冲突和资源边界，独立块保持独立；
 *   - 执行期每次开新块前原子复检，预测成本放不下就排队；
 *   - 窗口结束释放预留并重新检查队列，永不使用 hard-run 绕过 4000 MB 底线。
 *
 * 成本口径来自真机标定（2026-09-18，8 窗全绿）：单窗进程峰值中位 120 / 最大 129 MB，
 * 但含宿主、引擎与子进程的边际成本约 193 MB（轻载标定）；2026-09-18 的 7 窗并发实测在竞争下
 * 直接顶到钳制上限，说明轻载标定不能当作并发预算，因此默认每窗预算提高到 400 MB 并滚动修正。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_MIN_AVAILABLE_MB = 4000;
export const DEFAULT_WINDOW_COST_MB = 400;
export const COST_MIN_MB = 256;
export const COST_MAX_MB = Number.MAX_SAFE_INTEGER;
export const COST_SAMPLES_FOR_DOWNGRADE = 3;
export const PEAK_OVERHEAD_FACTOR = 1.5;   // 进程峰值 -> 边际成本（含宿主/引擎/子进程）
// 首次运行（还没有足够的干净样本）时额外留出的余量：2026-09-18 的 7 窗实测显示，
// 没有历史时的默认成本偏乐观，会把并发块挤到 starvation。样本够了就自动取消余量。
export const DEFAULT_FIRST_RUN_HEADROOM = 1.25;
export const HEADROOM_SAMPLES = 3;

/** 当前唯一容量模式是 dynamic（运行时内存准入队列）。 */
export function resolveBudgetMode(env = process.env) {
  const raw = String(env.ORCH_CAPACITY_MODE || '').trim().toLowerCase();
  if (!raw || raw === 'dynamic') return 'dynamic';
  throw new Error('Invalid ORCH_CAPACITY_MODE: ' + raw + '; expected dynamic');
}

export function budgetSettings(env = process.env) {
  const floorRaw = Number(env.ORCH_MIN_AVAILABLE_MB ?? DEFAULT_MIN_AVAILABLE_MB);
  const costRaw = Number(env.ORCH_WINDOW_COST_MB ?? DEFAULT_WINDOW_COST_MB);
  const headroomRaw = Number(env.ORCH_FIRST_RUN_HEADROOM ?? DEFAULT_FIRST_RUN_HEADROOM);
  const floorMB = Number.isFinite(floorRaw) ? Math.max(DEFAULT_MIN_AVAILABLE_MB,Math.floor(floorRaw)) : DEFAULT_MIN_AVAILABLE_MB;
  const windowCostMB = Number.isFinite(costRaw) && costRaw > 0 ? Math.round(costRaw) : DEFAULT_WINDOW_COST_MB;
  const headroom = Number.isFinite(headroomRaw) && headroomRaw >= 1 && headroomRaw <= 3 ? headroomRaw : DEFAULT_FIRST_RUN_HEADROOM;
  return {mode: resolveBudgetMode(env), floorMB, windowCostMB, headroom};
}

/** 样本不足时套用首轮余量；样本达到 HEADROOM_SAMPLES 后自动回到 1。 */
export function firstRunHeadroom(samples, headroom = DEFAULT_FIRST_RUN_HEADROOM) {
  const value = Number(headroom);
  if (!Number.isFinite(value) || value <= 1) return 1;
  return (Number(samples) || 0) >= HEADROOM_SAMPLES ? 1 : Math.min(3, value);
}

/** 可用内存：Node 的 os.freemem() 在 Windows 上就是 "Available MBytes"，与系统计数器一致。 */
export function availableMB() {
  return Math.floor(os.freemem() / 1024 ** 2);
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

/** 准入判据：加入本块后的预测峰值必须低于可用内存减去底线。底线不可关闭。 */
export function admissionOk({availableMB: available, runningCostMB = 0, blockCostMB: cost, floorMB}) {
  const floor = Math.max(DEFAULT_MIN_AVAILABLE_MB,Number(floorMB)||DEFAULT_MIN_AVAILABLE_MB);
  if(![available,runningCostMB,cost,floor].every(Number.isFinite)||available<0||runningCostMB<0||cost<=0)return false;
  return available - runningCostMB - cost > floor;
}

/** OS available memory already excludes current working sets. Reserve only
 * future growth; missing or reused process identities retain their full peak. */
export function unconsumedReservationMB(leases, snapshot = new Map()) {
  const children = new Map();
  for (const proc of snapshot.values()) {
    const parent = Number(proc.ParentProcessId);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(Number(proc.ProcessId));
  }
  return leases.reduce((total, lease) => {
    const peak = Number(lease.memoryCostMB ?? DEFAULT_WINDOW_COST_MB);
    if (!Number.isFinite(peak) || peak < 0) return Infinity;
    const expected = lease.launcher, actual = snapshot.get(Number(expected?.ProcessId));
    let consumed = 0;
    if (expected && actual && ['ProcessId','Started','Name','CommandLine'].every(key => expected[key] === actual[key])) {
      const queue = [Number(actual.ProcessId)], seen = new Set();
      for (let i = 0; i < queue.length; i++) {
        const pid = queue[i];
        if (seen.has(pid)) continue;
        seen.add(pid);
        const bytes = Number(snapshot.get(pid)?.WorkingSet64);
        if (Number.isFinite(bytes) && bytes > 0) consumed += bytes / 1024 ** 2;
        queue.push(...(children.get(pid) || []));
      }
    }
    return total + Math.max(0, peak - consumed);
  }, 0);
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
 * 升得快（一次超了就升），降得慢（至少 COST_SAMPLES_FOR_DOWNGRADE 个样本才允许下调），最低 256 MB，实测高峰不设人为上限。
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
