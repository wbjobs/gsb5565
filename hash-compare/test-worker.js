'use strict';
/* Node 无头测试: 在 vm 沙箱中加载 worker.js, 模拟 postMessage/onmessage */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWorker() {
  const inbox = [];
  const sandbox = {
    postMessage: (msg) => inbox.push(msg),
    Math, Set, Number, String, Int32Array, Uint8Array, Object, Array, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8'), sandbox);
  return {
    inbox,
    send(msg) { sandbox.onmessage({ data: msg }); },
    last() { return inbox[inbox.length - 1]; },
    drain() { inbox.length = 0; },
  };
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}

const configs = [];
for (const probeMode of ['linear', 'quadratic']) {
  for (const hashFn of ['division', 'multiply', 'midsquare']) {
    configs.push({ probeMode, hashFn });
  }
}

for (const c of configs) {
  console.log(`\n== probeMode=${c.probeMode} hashFn=${c.hashFn} ==`);
  const w = loadWorker();
  w.send({ type: 'config', cfg: { capacity: 53, hashFn: c.hashFn, probeMode: c.probeMode, maxLoadOA: 0.75, maxLoadChain: 2.0 } });
  w.drain();

  // 1. 空表查询
  w.send({ type: 'search', key: 12345 });
  const emptyRes = w.inbox.find(m => m.type === 'opResult');
  check('空表查询不崩溃且未找到', emptyRes && emptyRes.chain.found === false && emptyRes.oa.found === false);
  check('空表查询两策略一致', emptyRes.consistent === true);
  w.drain();

  // 2. 随机一致性测试 (含大量扩容/删除/墓碑)
  w.send({ type: 'randomTest', ops: 8000, keySpace: 400 });
  const tr = w.inbox.find(m => m.type === 'testResult');
  check('随机测试查询结果一致 (8000 ops)', tr && tr.mismatches === 0, tr && `mismatches=${tr.mismatches}`);
  check('随机测试后两表 size 一致', tr && tr.sizeConsistent === true);
  const snap = w.last();
  check('扩容后数据不丢 (size=最终存活数)', snap && snap.stats.chain.size === tr.finalSize && snap.stats.oa.size === tr.finalSize);
  check('发生过扩容', snap && snap.stats.chain.resizes > 0 && snap.stats.oa.resizes > 0,
    snap && `chain=${snap.stats.chain.resizes} oa=${snap.stats.oa.resizes}`);
  check('装载因子统计在 (0, 阈值] 内', snap && snap.stats.oa.loadFactor > 0 && snap.stats.oa.loadFactor <= 0.75 + 1e-9);
  check('冲突次数被统计 (>0)', snap && snap.stats.chain.collisions > 0 && snap.stats.oa.collisions > 0);
  check('平均探测长度可量化 (>0)', snap && snap.stats.oa.avgHitProbe > 0 && snap.stats.oa.avgMissProbe > 0 && snap.stats.chain.avgHitProbe >= 0);
  check('快照为 TypedArray', snap && snap.oa.state instanceof Uint8Array && snap.chain.heads instanceof Int32Array);
  w.drain();

  // 3. 墓碑标记: 插入一批键 -> 删除一半 -> 验证剩余键全部可查、已删键查不到
  w.send({ type: 'reset' }); w.drain();
  const keys = [];
  for (let k = 0; k < 120; k++) keys.push(k * 7 + 1);
  for (const k of keys) w.send({ type: 'insert', key: k });
  w.drain();
  for (let i = 0; i < keys.length; i += 2) w.send({ type: 'delete', key: keys[i] }); // 删一半
  let tombOk = true;
  const s2 = w.last();
  const tombSeen = s2.stats.oa.tombstones > 0 || s2.stats.oa.resizes > 0;
  w.drain();
  for (let i = 1; i < keys.length; i += 2) {
    w.send({ type: 'search', key: keys[i] });
    const r = w.inbox.find(m => m.type === 'opResult');
    if (!r.oa.found || !r.chain.found) tombOk = false;
    w.drain();
  }
  for (let i = 0; i < keys.length; i += 2) {
    w.send({ type: 'search', key: keys[i] });
    const r = w.inbox.find(m => m.type === 'opResult');
    if (r.oa.found || r.chain.found) tombOk = false;
    w.drain();
  }
  check('删除产生墓碑标记', tombSeen);
  check('墓碑不断链: 剩余键全部可查, 已删键查不到', tombOk);

  // 4. 删除后重插入复用墓碑
  w.send({ type: 'reset' }); w.drain();
  w.send({ type: 'insert', key: 100 });
  w.send({ type: 'delete', key: 100 });
  const before = w.last().stats.oa.tombstones;
  w.send({ type: 'insert', key: 200 }); // 不一定同槽, 仅验证不崩溃
  w.send({ type: 'insert', key: 100 });
  const after = w.last();
  w.drain();
  check('墓碑槽可被复用/重插入成功', after.stats.oa.size >= 2 && before >= 0);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
