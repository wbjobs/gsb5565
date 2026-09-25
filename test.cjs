/* 验收测试：对照 Set 参考模型验证三种策略行为一致、统计准确 */
'use strict';
const { ChainingTable, OpenAddressingTable, HASH_NAMES } = require('./hashtables.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra || ''}`); }
}

// 可复现随机数
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('== 1. 空表查询 ==');
{
  const c = new ChainingTable(16, 'multiply');
  const l = new OpenAddressingTable(16, 'multiply', 'linear');
  const q = new OpenAddressingTable(16, 'multiply', 'quadratic');
  const rc = c.query(123), rl = l.query(123), rq = q.query(123);
  check('空表查询均返回未命中', !rc.found && !rl.found && !rq.found);
  check('空表查询探测路径合法', rc.probes >= 1 && rl.path.length === 1 && rq.path.length === 1);
  const rd = l.delete(123);
  check('空表删除返回未找到', !rd.found);
}

console.log('== 2. 随机混合操作：三表与参考模型一致（含扩容、墓碑） ==');
for (const hashFn of HASH_NAMES) {
  const rand = mulberry32(0xC0FFEE);
  const c = new ChainingTable(16, hashFn);
  const l = new OpenAddressingTable(16, hashFn, 'linear');
  const q = new OpenAddressingTable(16, hashFn, 'quadratic');
  const model = new Set();
  let ok = true, maxCap = 0;
  const N = 60000;
  for (let i = 0; i < N && ok; i++) {
    const r = rand();
    const key = (rand() * 5000) | 0; // 键域小 → 大量冲突、重复、触发多次扩容
    if (r < 0.45) {
      const expect = !model.has(key);
      const rc = c.insert(key), rl = l.insert(key), rq = q.insert(key);
      if (rc.inserted !== expect || rl.inserted !== expect || rq.inserted !== expect) ok = false;
      model.add(key);
    } else if (r < 0.75) {
      const expect = model.has(key);
      const rc = c.query(key), rl = l.query(key), rq = q.query(key);
      if (rc.found !== expect || rl.found !== expect || rq.found !== expect) {
        ok = false;
        console.log(`    不一致: hashFn=${hashFn} i=${i} key=${key} expect=${expect} got=${rc.found}/${rl.found}/${rq.found}`);
      }
    } else {
      const expect = model.has(key);
      const rc = c.delete(key), rl = l.delete(key), rq = q.delete(key);
      if (rc.found !== expect || rl.found !== expect || rq.found !== expect) ok = false;
      model.delete(key);
    }
    maxCap = Math.max(maxCap, l.capacity);
  }
  check(`[${hashFn}] ${N} 次随机操作三表结论与参考模型一致`, ok);
  check(`[${hashFn}] 扩容后数据不丢（size=${l.size}, 参考=${model.size}, 最大容量=${maxCap}）`,
    c.size === model.size && l.size === model.size && q.size === model.size &&
    c.keysSorted().length === model.size && q.keysSorted().length === model.size);
  check(`[${hashFn}] 三表最终键集完全一致`,
    JSON.stringify(c.keysSorted()) === JSON.stringify(l.keysSorted()) &&
    JSON.stringify(l.keysSorted()) === JSON.stringify(q.keysSorted()));
}

console.log('== 3. 统计准确性 ==');
{
  const rand = mulberry32(42);
  const l = new OpenAddressingTable(16, 'multiply', 'linear');
  const c = new ChainingTable(16, 'multiply');
  let expectCollisionsL = 0;
  const placed = new Set();
  // 手工核算线性探测冲突：插入时探测路径上遇到他键占用即冲突
  for (let i = 0; i < 2000; i++) {
    const key = (rand() * 100000) | 0;
    if (placed.has(key)) { l.insert(key); c.insert(key); continue; }
    // 用表自身快照模拟期望冲突（插入前）
    const before = l.snapshot();
    const mask = l.capacity - 1;
    const h = require('./hashtables.js').hashKey('multiply', key) & mask;
    let collided = false;
    for (let j = 0; j < l.capacity; j++) {
      const idx = (h + j) & mask;
      if (before[idx] === 0) break;       // EMPTY
      if (before[idx] === 2) continue;    // 墓碑不算冲突
      collided = true;                    // 占用（且键不同，因为 placed 已排除同键）
    }
    if (collided) expectCollisionsL++;
    l.insert(key); c.insert(key);
    placed.add(key);
  }
  check('线性探测冲突次数统计准确', l.collisions === expectCollisionsL,
    `got=${l.collisions} expect=${expectCollisionsL}`);
  check('装载因子 = size / capacity', Math.abs(l.loadFactor() - l.size / l.capacity) < 1e-12);
  check('平均探测长度可量化（>0 且有限）',
    l.avgProbe() > 0 && Number.isFinite(l.avgProbe()) && c.avgProbe() > 0);
  check('开放寻址装载因子受阈值约束（<=0.7 余量内）',
    (l.size + l.tombstones) / l.capacity <= 0.7 + 1 / l.capacity);
  check('链地址法装载因子受阈值约束（<=0.75 余量内）',
    c.loadFactor() <= 0.75 + 1 / c.bucketCount);
}

console.log('== 4. 墓碑标记正确性 ==');
{
  // 构造必然冲突的键（除留余数法 + 容量 16 → key 间隔 16 必冲突）
  const t = new OpenAddressingTable(16, 'division', 'linear');
  t.insert(1); t.insert(17); t.insert(33); // 同槽链 1→17→33
  const before = t.query(33);
  check('删除前可查到 33', before.found && before.probes === 3);
  t.delete(17);
  check('删除后墓碑数 = 1', t.tombstones === 1);
  const snap = t.snapshot();
  check('墓碑标记写入槽位状态（meta=2）', snap[2] === 2); // 17 经线性探测落在槽位 2
  const after = t.query(33);
  check('删除中间节点后仍可查到 33（探测链不断）', after.found);
  check('查询 17 未命中', !t.query(17).found);
  t.insert(49); // 应复用墓碑槽位
  check('插入复用墓碑槽位（墓碑数归零）', t.tombstones === 0);
  check('复用后 33/49 均可查到', t.query(33).found && t.query(49).found);
  // 二次探测同理
  const tq = new OpenAddressingTable(16, 'division', 'quadratic');
  tq.insert(1); tq.insert(17); tq.insert(33);
  tq.delete(17);
  check('二次探测：删除后仍可查到 33', tq.query(33).found && tq.tombstones === 1);
}

console.log('== 5. 扩容后墓碑清理与数据完整 ==');
{
  const rand = mulberry32(7);
  const t = new OpenAddressingTable(16, 'fnv1a', 'linear');
  const model = new Set();
  for (let i = 0; i < 3000; i++) {
    const k = (rand() * 2000) | 0;
    if (rand() < 0.6) { t.insert(k); model.add(k); }
    else { t.delete(k); model.delete(k); }
  }
  const capBefore = t.capacity;
  // 强制灌满触发扩容
  for (let k = 100000; t.capacity === capBefore; k++) { t.insert(k); model.add(k); }
  check('扩容后墓碑被清理', t.tombstones === 0);
  check('扩容后所有键可查询', [...model].every(k => t.query(k).found));
  check('扩容后 size 与参考一致', t.size === model.size);
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
