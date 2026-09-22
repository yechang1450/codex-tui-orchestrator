#!/usr/bin/env node
/**
 * coverage — 用 Node 自带测试覆盖跑离线套件，并写出 lcov 供评审/静态评估读取。
 *
 * 为什么需要它：本仓库有完整的手写回归套件，但此前没有任何覆盖度产物，
 * 评审者（以及 plugin-eval 的 coverage 检查）看不到套件到底覆盖了哪些核心文件。
 * 这里只做一件事：串行跑套件、收集覆盖、把 lcov 落到一个被 git 忽略、
 * 又不会进入分发包的位置（.plugin-eval/coverage/lcov.info）。
 *
 * 用法：
 *   node scripts/coverage.mjs [--test <路径或通配>]... [--out <lcov 文件>] [--concurrency <n>] [--quiet]
 *
 * 约束：测试必须串行（--test-concurrency=1），与 CI 和文档中的回归命令一致；
 * 覆盖度低不是失败条件，这个脚本的退出码只反映测试套件本身。
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TESTS = 'test/*.test.mjs';
const DEFAULT_OUT = path.join('.plugin-eval', 'coverage', 'lcov.info');

function parseArgs(argv) {
  const out = {tests: [], out: DEFAULT_OUT, concurrency: 1, quiet: false, help: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--test') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--test needs a path or glob');
      out.tests.push(value);
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--out needs a file path');
      out.out = path.resolve(root, value);
    } else if (arg === '--concurrency') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--concurrency needs a positive integer');
      out.concurrency = value;
    } else if (arg === '--quiet') out.quiet = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error('unknown option: ' + arg);
  }
  return out;
}

// Node 自带测试跑器支持通配符参数，但 shell 之前会先吃掉它们；这里自己展开，
// 保证 Windows PowerShell、cmd 和 POSIX shell 下行为一致。
function expandTests(patterns) {
  const files = [];
  for (const pattern of patterns) {
    const absolute = path.resolve(root, pattern);
    if (!/[*?]/.test(pattern)) {
      if (!fs.existsSync(absolute)) throw new Error('test path not found: ' + pattern);
      files.push(absolute);
      continue;
    }
    if (typeof fs.globSync === 'function') {
      const matched = fs.globSync(pattern, {cwd: root}).map((entry) => path.resolve(root, entry));
      if (!matched.length) throw new Error('test glob matched nothing: ' + pattern);
      files.push(...matched);
      continue;
    }
    const dir = path.dirname(absolute);
    const mask = path.basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]');
    const re = new RegExp('^' + mask + '$');
    const matched = fs.readdirSync(dir).filter((name) => re.test(name)).sort().map((name) => path.join(dir, name));
    if (!matched.length) throw new Error('test glob matched nothing: ' + pattern);
    files.push(...matched);
  }
  return [...new Set(files)].sort();
}

// lcov 规范用正斜杠；Node 的 lcov 报告在 Windows 上写的是反斜杠，这里统一。
function normalizeLcov(file) {
  const text = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  const normalized = text.split('\n').map((line) => (line.startsWith('SF:') ? 'SF:' + line.slice(3).replaceAll('\\', '/') : line)).join('\n');
  if (normalized !== text) fs.writeFileSync(file, normalized, 'utf8');
  return normalized;
}

function summarize(text) {
  let found = 0;
  let hit = 0;
  let sources = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) sources++;
    else if (line.startsWith('LF:')) found += Number(line.slice(3));
    else if (line.startsWith('LH:')) hit += Number(line.slice(3));
  }
  const percent = found > 0 ? Number(((hit / found) * 100).toFixed(2)) : 0;
  return {sources, found, hit, percent};
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: node scripts/coverage.mjs [--test <path|glob>]... [--out <lcov file>] [--concurrency <n>] [--quiet]');
    return 0;
  }
  const tests = expandTests(options.tests.length ? options.tests : [DEFAULT_TESTS]);
  fs.mkdirSync(path.dirname(options.out), {recursive: true});
  if (!options.quiet) console.log('[coverage] ' + tests.length + ' test file(s) -> ' + path.relative(root, options.out).replaceAll('\\', '/'));
  // 从 `node --test` 的测试进程里再启动子进程时，宿主会把 NODE_TEST_CONTEXT 传下来，
  // 子进程于是按“测试子进程”协议运行：不写 reporter 产物（实测 lcov 文件失踪）。
  // 跑覆盖必须是一段独立的普通进程，所以这里显式摘掉它。
  const childEnv = {...process.env};
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-concurrency=' + options.concurrency,
    '--experimental-test-coverage',
    '--test-reporter=dot',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=' + options.out,
    ...tests,
  ], {cwd: root, env: childEnv, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit']});
  const written = fs.existsSync(options.out);
  const summary = written ? summarize(normalizeLcov(options.out)) : {sources: 0, found: 0, hit: 0, percent: 0};
  if (!options.quiet) {
    console.log('[coverage] sources ' + summary.sources + ' | lines ' + summary.hit + '/' + summary.found + ' (' + summary.percent + '%)');
    if (!written) console.error('[coverage] no lcov was produced; the suite did not exercise any covered source');
  }
  if (result.status !== 0) {
    console.error('[coverage] the offline suite failed (exit ' + result.status + '); the lcov covers only the files that ran');
    return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error('[coverage] ' + (error?.message || error));
    process.exit(1);
  }
}
