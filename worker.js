/*
 * Web Worker：在后台线程维护三张哈希表（链地址 / 线性探测 / 二次探测），
 * 主线程只负责渲染，保证大批量操作下 UI 不卡。
 */
importScripts('hashtables.js');

const { ChainingTable, OpenAddressingTable } = HashTables;

let tables = null;
let config = { capacity: 64, hashFn: 'multiply' };

function buildTables(capacity, hashFn) {
  config = { capacity, hashFn };
  tables = {
    chain: new ChainingTable(capacity, hashFn),
    linear: new OpenAddressingTable(capacity, hashFn, 'linear'),
    quadratic: new OpenAddressingTable(capacity, hashFn, 'quadratic'),
  };
}

function snapshots() {
  const chainSnap = tables.chain.snapshot();
  const linearSnap = tables.linear.snapshot();
  const quadSnap = tables.quadratic.snapshot();
  return {
    chain: chainSnap.buffer,
    chainCapacity: tables.chain.bucketCount,
    linear: linearSnap.buffer,
    linearCapacity: tables.linear.capacity,
    quadratic: quadSnap.buffer,
    quadraticCapacity: tables.quadratic.capacity,
  };
}

function postState(extra, transfers) {
  const snap = snapshots();
  const msg = Object.assign({
    type: 'state',
    stats: [tables.chain.stats(), tables.linear.stats(), tables.quadratic.stats()],
    snapshots: snap,
  }, extra || {});
  const bufs = [snap.chain, snap.linear, snap.quadratic];
  postMessage(msg, transfers ? bufs.concat(transfers) : bufs);
}

function runOp(op, key) {
  let r;
  switch (op) {
    case 'insert':
      r = {
        chain: tables.chain.insert(key),
        linear: tables.linear.insert(key),
        quadratic: tables.quadratic.insert(key),
      };
      break;
    case 'query':
      r = {
        chain: tables.chain.query(key),
        linear: tables.linear.query(key),
        quadratic: tables.quadratic.query(key),
      };
      break;
    case 'delete':
      r = {
        chain: tables.chain.delete(key),
        linear: tables.linear.delete(key),
        quadratic: tables.quadratic.delete(key),
      };
      break;
  }
  // 一致性校验：三表对同一操作的结论必须一致（new/dup 或 hit/miss）
  const verdict = (x) => (op === 'insert' ? (x.inserted ? 'new' : 'dup') : (x.found ? 'hit' : 'miss'));
  const v = [verdict(r.chain), verdict(r.linear), verdict(r.quadratic)];
  const consistent = v[0] === v[1] && v[1] === v[2];
  return { results: r, consistent };
}

function verifyAll() {
  const a = tables.chain.keysSorted();
  const b = tables.linear.keysSorted();
  const c = tables.quadratic.keysSorted();
  const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  return {
    consistent: eq(a, b) && eq(b, c),
    sizes: [a.length, b.length, c.length],
  };
}

self.onmessage = function (e) {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
    case 'reset':
      buildTables(msg.capacity, msg.hashFn);
      postState({ type: 'state', reset: true });
      break;

    case 'op': {
      const out = runOp(msg.op, msg.key);
      postState({ type: 'state', lastOp: { op: msg.op, key: msg.key, results: out.results, consistent: out.consistent } });
      break;
    }

    case 'batch': {
      // 大批量随机操作：不逐条回传，定期报进度，结束做全量一致性校验
      const ops = msg.ops;
      const total = ops.length;
      const step = Math.max(1, Math.floor(total / 50));
      let allConsistent = true;
      for (let i = 0; i < total; i++) {
        const out = runOp(ops[i][0], ops[i][1]);
        if (!out.consistent) allConsistent = false;
        if (i % step === 0) {
          postMessage({ type: 'progress', done: i, total });
        }
      }
      const verify = verifyAll();
      postState({ type: 'state', batchDone: { total, allConsistent, verify } });
      break;
    }

    case 'verify':
      postMessage({ type: 'verify', result: verifyAll() });
      break;
  }
};

// 启动即建表
buildTables(config.capacity, config.hashFn);
