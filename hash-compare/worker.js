'use strict';
/*
 * 哈希表对比 Worker
 *  - 链地址法 (chaining):  TypedArray 静态链表 (heads/next/keys)
 *  - 开放寻址法 (open addressing): 线性探测 / 二次探测, TypedArray (state/keys), 墓碑删除
 * 所有插入/查询/删除/扩容/统计均在此线程完成，主线程只负责渲染。
 */

const EMPTY = 0, OCCUPIED = 1, TOMBSTONE = 2;

/* ---------------- 哈希函数 ---------------- */
const HASH_FNS = {
  // 除留余数法
  division(k, m) {
    return ((k % m) + m) % m;
  },
  // 乘法散列 (Knuth, A = (sqrt(5)-1)/2)
  multiply(k, m) {
    const A = 0.6180339887498949;
    const frac = (Math.abs(k) * A) % 1;
    return Math.floor(m * frac);
  },
  // 平方取中法
  midsquare(k, m) {
    const s = String(k * k);
    const take = Math.max(1, Math.floor(s.length / 2));
    const start = Math.floor((s.length - take) / 2);
    return Number(s.slice(start, start + take)) % m;
  },
};

function nextPrime(n) {
  const isPrime = (x) => {
    if (x < 2) return false;
    if (x % 2 === 0) return x === 2;
    for (let i = 3; i * i <= x; i += 2) if (x % i === 0) return false;
    return true;
  };
  let c = Math.max(2, Math.floor(n));
  while (!isPrime(c)) c++;
  return c;
}

function freshStats(cap) {
  return {
    capacity: cap, size: 0,
    collisions: 0,              // 插入时首槽/首桶被占的累计次数
    insertProbes: 0, insertCount: 0,
    hitProbes: 0, hitCount: 0,  // 成功查询
    missProbes: 0, missCount: 0,// 失败查询
    tombstones: 0, resizes: 0,
  };
}

/* ================= 链地址法 ================= */
function makeChain(cap) {
  const nodeCap = cap * 2;
  return {
    cap, nodeCap,
    heads: new Int32Array(cap).fill(-1),
    keys: new Int32Array(nodeCap),
    next: new Int32Array(nodeCap),
    nodeCount: 0,
    free: [],
    stats: freshStats(cap),
  };
}

function chainAlloc(t) {
  if (t.free.length > 0) return t.free.pop();
  if (t.nodeCount >= t.nodeCap) {
    const nc = t.nodeCap * 2;
    const nk = new Int32Array(nc); nk.set(t.keys);
    const nn = new Int32Array(nc); nn.set(t.next);
    t.keys = nk; t.next = nn; t.nodeCap = nc;
  }
  return t.nodeCount++;
}

function chainResize(t, newCap) {
  const nt = makeChain(newCap);
  for (let b = 0; b < t.cap; b++) {
    let idx = t.heads[b];
    while (idx !== -1) {
      const key = t.keys[idx];
      const h = hashWith(cfg.hashFn, key, newCap);
      const ni = chainAlloc(nt);
      nt.keys[ni] = key;
      nt.next[ni] = nt.heads[h];
      nt.heads[h] = ni;
      idx = t.next[idx];
    }
  }
  nt.stats = t.stats; // 保留累计统计
  nt.stats.capacity = newCap;
  nt.stats.resizes++;
  return nt;
}

function chainInsert(t, key) {
  const h = hashWith(cfg.hashFn, key, t.cap);
  const path = [{ bucket: h }];
  let idx = t.heads[h];
  let compared = 0;
  while (idx !== -1) {
    compared++;
    path.push({ node: idx, key: t.keys[idx] });
    if (t.keys[idx] === key) {
      return { ok: true, dup: true, probes: compared, path };
    }
    idx = t.next[idx];
  }
  if (t.heads[h] !== -1) t.stats.collisions++;
  const ni = chainAlloc(t);
  t.keys[ni] = key;
  t.next[ni] = t.heads[h];
  t.heads[h] = ni;
  t.stats.size++;
  t.stats.insertProbes += Math.max(1, compared);
  t.stats.insertCount++;
  return { ok: true, dup: false, probes: Math.max(1, compared), path };
}

function chainSearch(t, key) {
  const h = hashWith(cfg.hashFn, key, t.cap);
  const path = [{ bucket: h }];
  let idx = t.heads[h];
  let compared = 0;
  while (idx !== -1) {
    compared++;
    path.push({ node: idx, key: t.keys[idx] });
    if (t.keys[idx] === key) {
      t.stats.hitProbes += compared; t.stats.hitCount++;
      return { found: true, probes: compared, path };
    }
    idx = t.next[idx];
  }
  t.stats.missProbes += compared; t.stats.missCount++;
  return { found: false, probes: compared, path };
}

function chainDelete(t, key) {
  const h = hashWith(cfg.hashFn, key, t.cap);
  const path = [{ bucket: h }];
  let idx = t.heads[h];
  let prev = -1;
  let compared = 0;
  while (idx !== -1) {
    compared++;
    path.push({ node: idx, key: t.keys[idx] });
    if (t.keys[idx] === key) {
      if (prev === -1) t.heads[h] = t.next[idx];
      else t.next[prev] = t.next[idx];
      t.free.push(idx);
      t.stats.size--;
      return { ok: true, probes: compared, path };
    }
    prev = idx;
    idx = t.next[idx];
  }
  return { ok: false, probes: compared, path };
}

/* ================= 开放寻址法 ================= */
function makeOA(cap) {
  return {
    cap,
    state: new Uint8Array(cap),   // EMPTY / OCCUPIED / TOMBSTONE
    keys: new Int32Array(cap),
    stats: freshStats(cap),
  };
}

function probeSlot(h0, i, m) {
  if (cfg.probeMode === 'quadratic') {
    return (h0 + i * i) % m;      // 二次探测
  }
  return (h0 + i) % m;            // 线性探测
}

function oaResize(t, newCap) {
  const nt = makeOA(newCap);
  for (let s = 0; s < t.cap; s++) {
    if (t.state[s] === OCCUPIED) {
      const key = t.keys[s];
      const h0 = hashWith(cfg.hashFn, key, newCap);
      for (let i = 0; i < newCap; i++) {
        const slot = probeSlot(h0, i, newCap);
        if (nt.state[slot] !== OCCUPIED) {
          nt.state[slot] = OCCUPIED;
          nt.keys[slot] = key;
          break;
        }
      }
    }
  }
  nt.stats = t.stats; // 保留累计统计，墓碑随重建清零
  nt.stats.capacity = newCap;
  nt.stats.tombstones = 0;
  nt.stats.resizes++;
  return nt;
}

// 返回结果对象，或字符串 'REHASH' 表示二次探测走不到空槽需立即扩容重试
function oaInsertTry(t, key) {
  const h0 = hashWith(cfg.hashFn, key, t.cap);
  const path = [];
  let firstTomb = -1;
  const homeOccupied = t.state[h0] !== EMPTY;
  for (let i = 0; i <= t.cap; i++) {
    const slot = probeSlot(h0, i, t.cap);
    path.push(slot);
    const st = t.state[slot];
    if (st === OCCUPIED) {
      if (t.keys[slot] === key) {
        return { ok: true, dup: true, probes: i + 1, path };
      }
    } else if (st === TOMBSTONE) {
      if (firstTomb === -1) firstTomb = slot;
    } else { // EMPTY
      const target = firstTomb !== -1 ? firstTomb : slot;
      if (homeOccupied) t.stats.collisions++;
      t.state[target] = OCCUPIED;
      t.keys[target] = key;
      t.stats.size++;
      if (firstTomb !== -1) t.stats.tombstones--;
      t.stats.insertProbes += i + 1;
      t.stats.insertCount++;
      return { ok: true, dup: false, probes: i + 1, path };
    }
  }
  return 'REHASH';
}

function oaInsert(t, key) {
  for (;;) {
    const r = oaInsertTry(t, key);
    if (r !== 'REHASH') return r;
    oa = oaResize(oa, nextPrime(oa.cap * 2)); // 二次探测无法找到空槽的兜底
  }
}

function oaSearch(t, key) {
  const h0 = hashWith(cfg.hashFn, key, t.cap);
  const path = [];
  for (let i = 0; i <= t.cap; i++) {
    const slot = probeSlot(h0, i, t.cap);
    path.push(slot);
    const st = t.state[slot];
    if (st === EMPTY) {
      t.stats.missProbes += i + 1; t.stats.missCount++;
      return { found: false, probes: i + 1, path };
    }
    if (st === OCCUPIED && t.keys[slot] === key) {
      t.stats.hitProbes += i + 1; t.stats.hitCount++;
      return { found: true, probes: i + 1, path };
    }
    // TOMBSTONE 或他人占用: 继续探测
  }
  t.stats.missProbes += t.cap; t.stats.missCount++;
  return { found: false, probes: t.cap, path };
}

function oaDelete(t, key) {
  const h0 = hashWith(cfg.hashFn, key, t.cap);
  const path = [];
  for (let i = 0; i <= t.cap; i++) {
    const slot = probeSlot(h0, i, t.cap);
    path.push(slot);
    const st = t.state[slot];
    if (st === EMPTY) return { ok: false, probes: i + 1, path };
    if (st === OCCUPIED && t.keys[slot] === key) {
      t.state[slot] = TOMBSTONE;   // 墓碑标记，保证探测链不断
      t.stats.size--;
      t.stats.tombstones++;
      return { ok: true, probes: i + 1, path };
    }
  }
  return { ok: false, probes: t.cap, path };
}

/* ================= 全局状态与操作分发 ================= */
let cfg = {
  capacity: 53,
  hashFn: 'division',
  probeMode: 'linear',
  maxLoadOA: 0.75,
  maxLoadChain: 2.0,
};
let chain = makeChain(cfg.capacity);
let oa = makeOA(cfg.capacity);

function hashWith(name, key, m) {
  return (HASH_FNS[name] || HASH_FNS.division)(key, m);
}

function maybeGrow() {
  if (chain.stats.size / chain.cap > cfg.maxLoadChain) {
    chain = chainResize(chain, nextPrime(chain.cap * 2));
  }
  const s = oa.stats;
  if ((s.size + s.tombstones) / oa.cap > cfg.maxLoadOA) {
    oa = oaResize(oa, nextPrime(oa.cap * 2));
  } else if (s.tombstones > s.size && s.tombstones >= 8) {
    oa = oaResize(oa, oa.cap); // 墓碑过多时同容量重建，清除墓碑
  }
}

function doInsert(key) {
  const rc = chainInsert(chain, key);
  const ro = oaInsert(oa, key);
  const caps = { chain: chain.cap, oa: oa.cap }; // 探测路径对应的表容量
  maybeGrow();
  return { chain: rc, oa: ro, caps, capsAfter: { chain: chain.cap, oa: oa.cap } };
}

function doSearch(key) {
  const r = { chain: chainSearch(chain, key), oa: oaSearch(oa, key) };
  r.caps = { chain: chain.cap, oa: oa.cap };
  r.capsAfter = r.caps;
  return r;
}

function doDelete(key) {
  const rc = chainDelete(chain, key);
  const ro = oaDelete(oa, key);
  const caps = { chain: chain.cap, oa: oa.cap }; // 探测路径对应的表容量
  maybeGrow();
  return { chain: rc, oa: ro, caps, capsAfter: { chain: chain.cap, oa: oa.cap } };
}

/* ---------------- 快照与统计 ---------------- */
function statView(t, isOA) {
  const s = t.stats;
  const avg = (a, b) => (b === 0 ? 0 : a / b);
  return {
    capacity: t.cap,
    size: s.size,
    loadFactor: s.size / t.cap,
    collisions: s.collisions,
    avgInsertProbe: avg(s.insertProbes, s.insertCount),
    avgHitProbe: avg(s.hitProbes, s.hitCount),
    avgMissProbe: avg(s.missProbes, s.missCount),
    hitCount: s.hitCount,
    missCount: s.missCount,
    tombstones: isOA ? s.tombstones : 0,
    resizes: s.resizes,
  };
}

function snapshot() {
  const heads = chain.heads.slice();
  const keys = chain.keys.slice(0, chain.nodeCount);
  const next = chain.next.slice(0, chain.nodeCount);
  const oaState = oa.state.slice();
  const oaKeys = oa.keys.slice();
  const buf = [heads.buffer, keys.buffer, next.buffer, oaState.buffer, oaKeys.buffer];
  postMessage({
    type: 'snapshot',
    chain: { cap: chain.cap, heads, keys, next },
    oa: { cap: oa.cap, state: oaState, keys: oaKeys },
    stats: { chain: statView(chain, false), oa: statView(oa, true) },
    cfg,
  }, buf);
}

function opResult(op, key, r) {
  postMessage({
    type: 'opResult', op, key,
    chain: r.chain, oa: r.oa, caps: r.caps, capsAfter: r.capsAfter,
    consistent: (r.chain.found === undefined || r.chain.found === r.oa.found) &&
                (r.chain.ok === undefined || r.chain.ok === r.oa.ok),
  });
  snapshot();
}

/* ---------------- 随机一致性测试 ---------------- */
function randomTest(ops, keySpace) {
  chain = makeChain(cfg.capacity);
  oa = makeOA(cfg.capacity);
  const live = new Set();
  let mismatches = 0;
  let checked = 0;
  for (let i = 0; i < ops; i++) {
    const key = Math.floor(Math.random() * keySpace);
    const r = Math.random();
    if (r < 0.45) {
      doInsert(key);
      live.add(key);
    } else if (r < 0.7) {
      doDelete(key);
      live.delete(key);
    } else {
      const res = doSearch(key);
      checked++;
      const expect = live.has(key);
      if (res.chain.found !== expect || res.oa.found !== expect) {
        mismatches++;
      }
    }
  }
  // 全量校验: 对键空间抽样逐一比对两表与 Set
  for (let k = 0; k < Math.min(keySpace, 2000); k++) {
    const res = doSearch(k);
    checked++;
    if (res.chain.found !== live.has(k) || res.oa.found !== live.has(k)) mismatches++;
  }
  const sizeConsistent = chain.stats.size === oa.stats.size && oa.stats.size === live.size;
  postMessage({
    type: 'testResult',
    ops, checked, mismatches, sizeConsistent,
    finalSize: live.size,
  });
  snapshot();
}

/* ---------------- 消息入口 ---------------- */
onmessage = function (e) {
  const msg = e.data;
  switch (msg.type) {
    case 'config':
      cfg = Object.assign(cfg, msg.cfg);
      chain = makeChain(cfg.capacity);
      oa = makeOA(cfg.capacity);
      snapshot();
      break;
    case 'reset':
      chain = makeChain(cfg.capacity);
      oa = makeOA(cfg.capacity);
      snapshot();
      break;
    case 'insert':
      opResult('insert', msg.key, doInsert(msg.key));
      break;
    case 'search':
      opResult('search', msg.key, doSearch(msg.key));
      break;
    case 'delete':
      opResult('delete', msg.key, doDelete(msg.key));
      break;
    case 'batchInsert': {
      const n = msg.count;
      const keySpace = msg.keySpace;
      let inserted = 0;
      for (let i = 0; i < n; i++) {
        const key = Math.floor(Math.random() * keySpace);
        const r = doInsert(key);
        if (!r.chain.dup) inserted++;
      }
      postMessage({ type: 'batchDone', requested: n, inserted });
      snapshot();
      break;
    }
    case 'randomTest':
      randomTest(msg.ops, msg.keySpace);
      break;
  }
};
