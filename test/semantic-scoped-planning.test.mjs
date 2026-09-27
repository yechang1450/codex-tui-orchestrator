import {test} from 'node:test';
import assert from 'node:assert/strict';

process.env.ORCH_AGENT = 'codex';
const {buildBlocksFromTasks, keysOverlap} = await import('../scripts/orchestrate-sdk.mjs');

test('unnumbered project tasks with grounded paths retain independent work and dependencies', () => {
  const blocks = buildBlocksFromTasks([
    {id:'T001', kind:'project', project:null, summary:'在 README.md 中新增插件安装命令', conflict_hints:['file:README.md'], depends_on:[]},
    {id:'T002', kind:'project', project:null, summary:'在 docs/quickstart.md 中改写步骤，需要引用 README.md 的命令', conflict_hints:['file:docs/quickstart.md','file:README.md'], depends_on:['T001']},
    {id:'T003', kind:'project', project:null, summary:'整理 test/fixtures 下的独立示例数据', conflict_hints:['dir:test/fixtures'], depends_on:[]},
  ]);
  assert.equal(blocks.length, 3, 'grounded file and directory scopes must not collapse into linked-ambiguous');
  const blockFor = text => blocks.find(block => block.tasks.some(task => task.prompt.includes(text)));
  const readme = blockFor('README.md 中新增');
  const quickstart = blockFor('docs/quickstart.md 中改写');
  const fixtures = blockFor('test/fixtures 下');
  assert.ok(readme && quickstart && fixtures);
  assert.deepEqual(readme.dependsOn, []);
  assert.deepEqual(fixtures.dependsOn, []);
  assert.deepEqual(quickstart.dependsOn, [readme.title]);
  assert.equal(keysOverlap(readme.conflictKeys, fixtures.conflictKeys), false);
  assert.equal(keysOverlap(readme.conflictKeys, quickstart.conflictKeys), true);
});

test('invented or incomplete model path hints cannot unlock parallel execution', () => {
  for (const first of [
    {id:'T001', kind:'project', summary:'更新 README.md', conflict_hints:['file:invented.md']},
    {id:'T001', kind:'project', summary:'更新 README.md 和 package.json', conflict_hints:['file:README.md']},
  ]) {
    const blocks = buildBlocksFromTasks([first,
      {id:'T002', kind:'project', summary:'更新 docs/setup.md', conflict_hints:['file:docs/setup.md']}]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'linked');
    assert.equal(blocks[0].tasks.length, 2);
  }
});

test('module fold rules still resolve an otherwise unknown task before serial fallback', () => {
  const blocks = buildBlocksFromTasks([
    {id:'T001', kind:'project', summary:'清理缓存'},
    {id:'T002', kind:'project', summary:'更新 README.md', conflict_hints:['file:README.md']},
  ], {foldRules:{'清理':['81']}});
  assert.equal(blocks.length, 2);
  assert.ok(blocks.some(block => block.title === 'proj-81'));
  assert.ok(blocks.some(block => block.title.startsWith('scoped-')));
});

test('wildcards and loosely named directories cannot masquerade as a single-file scope', () => {
  for (const first of [
    {summary:'更新 README.md 和 docs/ 下的示例', conflict_hints:['file:README.md']},
    {summary:'更新 README.md 和 docs 目录里的示例', conflict_hints:['file:README.md']},
    {summary:'更新 README.md 和 *.md 文件', conflict_hints:['file:README.md','file:.md']},
  ]) {
    const blocks = buildBlocksFromTasks([
      {id:'T001', kind:'project', ...first},
      {id:'T002', kind:'project', summary:'整理 test/fixtures 数据', conflict_hints:['dir:test/fixtures']},
    ]);
    assert.equal(blocks.length, 1, first.summary);
    assert.equal(blocks[0].type, 'linked');
  }
});
