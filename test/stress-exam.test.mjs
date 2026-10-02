import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalDigest, keysOverlap, levelWaves, requestTasks} from '../scripts/core/contracts.mjs';
import {scheduleReady} from '../scripts/core/recovery.mjs';
import {partitionIndependentBlocks} from '../scripts/core/plan-policy.mjs';
import {genericProjectSplit} from '../scripts/core/orchestrate-sdk.mjs';

// 第二轮压力考试：确定性种子让失败可复现，同时覆盖规模、依赖深度、资源冲突和坏输入。
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function dag(seed, count = 192) {
  const random = rng(seed);
  return Array.from({length: count}, (_, index) => ({
    key: `B${index + 1}`,
    title: `stress-${seed}-${index + 1}`,
    dependsOn: index === 0 ? [] : [...new Set(Array.from({length: Math.min(4, index)}, () => `B${Math.floor(random() * index) + 1}`))],
  }));
}

test('stress exam: 16 seeded DAGs of 192 blocks preserve every dependency wave', () => {
  let total = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const recs = dag(seed);
    const waves = levelWaves(recs);
    const waveOf = new Map(waves.flatMap((wave, index) => wave.map(record => [record.key, index])));
    assert.equal(waveOf.size, recs.length);
    for (const record of recs) for (const dependency of record.dependsOn) {
      assert.ok(waveOf.get(dependency) < waveOf.get(record.key), `${dependency} must precede ${record.key}`);
    }
    total += recs.length;
  }
  assert.equal(total, 16 * 192);
});

test('stress exam: concurrent scheduler executes a 256-block wave graph exactly once', async () => {
  const recs = dag(0x5eed, 256);
  const state = new Map(recs.map(record => [record.key, 'pending']));
  const executed = [];
  await scheduleReady(recs, async record => {
    await new Promise(resolve => setTimeout(resolve, Number(record.key.slice(1)) % 3));
    assert.equal(state.get(record.key), 'pending');
    state.set(record.key, 'verified');
    executed.push(record.key);
  }, key => state.get(key));
  assert.equal(executed.length, recs.length);
  assert.equal(new Set(executed).size, recs.length);
  assert.ok([...state.values()].every(value => value === 'verified'));
});

test('stress exam: 320 resource blocks merge only on explicit overlap and remain conflict safe', () => {
  const blocks = Array.from({length: 320}, (_, index) => ({
    type: 'independent',
    title: `resource-${index}`,
    dependsOn: [],
    conflictKeys: [
      `file:stress/unique-${index}.json`,
      ...(index % 11 === 0 ? [`dir:stress/shared-${index % 22}`] : []),
    ],
    tasks: [{id: `t${index}`, prompt: `write stress/unique-${index}.json`}],
  }));
  const plan = partitionIndependentBlocks(blocks);
  assert.ok(plan.length < blocks.length, 'known shared directories should be serialized');
  const grouped = new Map();
  plan.forEach((block, group) => {
    for (const key of block.conflictKeys) grouped.set(key, group);
  });
  for (const [key, group] of grouped) {
    if (!key.includes('/stress/shared-')) continue;
    const suffix = key.split('/stress/')[1];
    const members = blocks.filter(block => block.conflictKeys.some(raw => raw.endsWith(suffix)));
    assert.ok(members.length >= 2);
    assert.equal(new Set(members.map(block => plan.findIndex(candidate => candidate.tasks.some(task => task.id === block.tasks[0].id)))).size, 1, `${key} must stay in one serial group`);
    assert.equal(group, plan.findIndex(candidate => candidate.conflictKeys.includes(key)));
  }
  assert.equal(keysOverlap(['dir:stress/shared-1'], ['file:stress/shared-1/x.txt']), true);
  assert.equal(keysOverlap(['dir:stress/shared-1'], ['file:stress/shared-10/x.txt']), false);
  assert.equal(keysOverlap(['dir:stress/shared-1'], ['file:stress/shared-1/x.txt'], {canonical: true}), true);
  assert.equal(keysOverlap(['file:a'], ['file:a'], null), true, 'optional comparison mode remains null-safe');
});

test('stress exam: malformed and adversarial inputs fail closed without partial scheduling', () => {
  assert.throws(() => levelWaves([{key: 'A', title: 'a', dependsOn: ['missing']}]), /Unknown dependency/);
  assert.throws(() => levelWaves([{key: 'A', title: 'a', dependsOn: ['A']}]), /Self dependency/);
  assert.throws(() => levelWaves([{key: 'A', title: 'a', dependsOn: ['B']}, {key: 'B', title: 'b', dependsOn: ['A']}]), /Cyclic dependencies/);
  assert.throws(() => levelWaves([{key: 'A', title: 'a', dependsOn: []}, {key: 'A', title: 'b', dependsOn: []}]), /Duplicate block identity/);
  const huge = requestTasks(Array.from({length: 4000}, (_, index) => `任务${index}；` + 'x'.repeat(index % 31)).join(''));
  assert.equal(huge.length, 4000);
  const digests = new Set(Array.from({length: 10000}, (_, index) => canonicalDigest({index, value: `混排-${index % 17}`, flags: [index % 2 === 0, null]})));
  assert.equal(digests.size, 10000);
});

test('stress exam: Chinese paired quotes protect embedded separators in the task inventory', () => {
  for (const [open, close] of [['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']]) {
    const prompts = [`项目-1：处理${open}a,b;c[0]${close}`, `项目-2：处理${open}d,e;f[1]${close}`];
    assert.deepEqual(requestTasks(prompts.join('；')).map(task => task.prompt), prompts);
  }
});

test('stress exam: absolute Windows targets keep their drive identity when prose follows', () => {
  const split = genericProjectSplit('项目-1：写 C:\\shared\\result.json 并验收；项目-2：读 C:\\shared\\result.json 然后汇总');
  assert.ok(split?.blocks?.length === 2, JSON.stringify(split));
  const [first, second] = split.blocks.map(block => block.conflictKeys);
  assert.ok(first.some(key => /file:c:\\/i.test(key)), JSON.stringify(first));
  assert.ok(second.some(key => /file:c:\\/i.test(key)), JSON.stringify(second));
  assert.equal(keysOverlap(first, second), true, `${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
  const spaced = genericProjectSplit('项目-1：写 C:\\dir with space\\result.json 并验收；项目-2：读 C:\\dir with space\\result.json 然后汇总');
  assert.equal(keysOverlap(spaced.blocks[0].conflictKeys, spaced.blocks[1].conflictKeys), true);
});

test('stress exam: one failed prerequisite blocks only its transitive dependents', async () => {
  const recs = [
    {key: 'root-ok', title: 'root-ok', dependsOn: []},
    {key: 'root-fail', title: 'root-fail', dependsOn: []},
    {key: 'child-fail', title: 'child-fail', dependsOn: ['root-fail']},
    {key: 'grandchild-fail', title: 'grandchild-fail', dependsOn: ['child-fail']},
    {key: 'child-ok', title: 'child-ok', dependsOn: ['root-ok']},
  ];
  const state = new Map(recs.map(record => [record.key, 'pending']));
  const executed = [];
  const blocked = [];
  await scheduleReady(recs, async record => {
    executed.push(record.key);
    state.set(record.key, record.key === 'root-fail' ? 'failed' : 'verified');
  }, key => state.get(key), (record, dependencies) => {
    blocked.push([record.key, dependencies]);
    state.set(record.key, 'blocked');
  });
  assert.deepEqual(new Set(executed), new Set(['root-ok', 'root-fail', 'child-ok']));
  assert.deepEqual(blocked.map(([key]) => key).sort(), ['child-fail', 'grandchild-fail']);
});
