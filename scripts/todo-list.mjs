#!/usr/bin/env node
/**
 * todo-list.mjs — TODO LIST 完整性校验器
 *
 * 用途：任何 agent（主对话 / TUI 窗 / 子代理）在做 TODO LIST 后，用它校验清单
 * 是否【有头有尾、覆盖首中尾、每步含动作/产物/验证、有依赖顺序】，防"只规划不落地"。
 *
 * 用法：
 *   node todo-list.mjs --check <清单文件> [--json]
 *   node todo-list.mjs --check <清单文件> --strict   # 更严格：必须有"目标"与"收尾验证/清理"且步数>=1
 *
 * 退出码：校验通过=0；存在缺失=1（供 agent 在未过校验前禁止进入执行）。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function getArg(name, dflt) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && process.argv[i + 1] != null) ? process.argv[i + 1] : dflt;
}
const hasFlag = (n) => process.argv.includes(n);
const JSON_MODE = hasFlag('--json');
const STRICT = hasFlag('--strict');
const file = getArg('--check', null);

function reportOk(ok, checks) {
  const summary = { ok, checks };
  if (JSON_MODE) { console.log(JSON.stringify(summary, null, 2)); }
  else {
    console.log(ok ? 'TODO LIST 校验通过（有头有尾、覆盖全链）。' : 'TODO LIST 校验未通过（见下）。');
    for (const c of checks) console.log('  [' + (c.ok ? 'PASS' : 'FAIL') + '] ' + c.name + (c.note ? ' — ' + c.note : ''));
  }
  process.exit(ok ? 0 : 1);
}

function check(text, strict) {
  const t = String(text || '');
  const checks = [];
  const L = (name, ok, note) => checks.push({ name, ok: !!ok, note: note || '' });

  // 有头：目标/目的/背景 + 前置/环境盘点
  const hasGoal = /目标|目的|goal|objective|任务目标|要完成|本次任务/i.test(t);
  L('有头-目标明确', hasGoal, hasGoal ? '' : '清单缺少“目标/目的”说明（有头）');
  const hasPre = /前置|现状|环境盘点|环境|背景|依赖条件|先确认|先区分|已确认|已知/i.test(t);
  L('有头-前置/环境盘点', hasPre, hasPre ? '' : '缺少“前置条件/环境盘点/现状”');

  // 中间：动作/产物/验证 + 依赖顺序
  const stepLines = t.split(/\n/).map((l) => l.trim()).filter((l) => /^\s*\d+[)\.、:]/.test(l) || /^\s*[-*•] /.test(l));
  L('中间-步骤数>0', stepLines.length > 0, '步骤数=' + stepLines.length);
  const hasAction = /动作|执行|创建|写入|运行|改|建|task|步骤|①|②|③/ .test(t);
  const hasProduct = /产物|输出|落地|文件|配置|结果|生成|produce|output/i.test(t);
  const hasVerify = /验证|自验|读回|回归|核验|校验|check|verify|确认/i.test(t);
  L('中间-含动作', hasAction, hasAction ? '' : '缺少“动作”要素');
  L('中间-含产物', hasProduct, hasProduct ? '' : '缺少“产物”要素（落地物）');
  L('中间-含验证', hasVerify, hasVerify ? '' : '缺少“验证点”（读回/回归）');
  const hasDep = /依赖|先后|顺序|串行|并行|因果|前置步|必须先/i.test(t);
  L('中间-依赖顺序', hasDep, hasDep ? '' : '缺少依赖/顺序说明');

  // 有尾：收尾验证 + 清理残留 + 结束标记/复盘（防"只规划不落地"）
  const hasTailVerify = /现场自验|读回|自验|逐一|逐项|最终汇报|结束标记|复盘|确认.*落盘|全部.*完成/i.test(t);
  L('有尾-收尾验证/自验', hasTailVerify, hasTailVerify ? '' : '缺少“收尾现场自验/最终读回”');
  const hasClean = /清理|清残留|删除.*临时|无残留|no.*temp|临时产物.*清理|瘦身/i.test(t);
  L('有尾-清理残留', hasClean, hasClean ? '' : '缺少“清理临时/残留产物”或无残留确认');
  const hasEndmark = /__ORCH_DONE__|结束标记|输出.*结束|完成.*汇报|最后.*输出|EXIT/i.test(t);
  L('有尾-结束标记/最终汇报', hasEndmark, hasEndmark ? '' : '缺少“结束标记/最终汇报”收尾');

  // strict：额外要求目标+收尾验证+清理+步数 >= 1 全有
  const strictAll = checks.every((c) => c.ok);
  const ok = checks.every((c) => c.ok);
  L('整体-有头有尾覆盖全链', ok, ok ? '' : '存在缺失项，禁止进入执行');
  return { ok, checks };
}

export { check, reportOk };

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').toLowerCase() === fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase();
if (isMain) {
  if (!file) {
    console.log('用法: node todo-list.mjs --check <清单文件> [--json] [--strict]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error('清单文件不存在: ' + file);
    process.exit(2);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const r = check(raw, STRICT);
  reportOk(r.ok, r.checks);
}
