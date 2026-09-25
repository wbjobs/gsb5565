'use strict';
/* UI 冒烟测试: 用最小 DOM 桩加载 app.js, 连接真实 worker.js, 模拟完整用户操作流 */
const fs = require('fs');
const vm = require('vm');

const errors = [];
const realSetInterval = setInterval;
const realSetTimeout = setTimeout;

function makeCtx2d() {
  return new Proxy({}, {
    get: (t, p) => {
      if (p === 'measureText') return () => ({ width: 10 });
      return typeof p === 'string' ? (t[p] || (t[p] = (...a) => {})) : undefined;
    },
    set: () => true,
  });
}

function makeEl(id) {
  const el = {
    id, children: [], value: '', textContent: '', className: '', innerHTML: '',
    style: {}, clientWidth: 900, width: 900, height: 300,
    classList: { add() {}, remove() {} },
    parentElement: { clientWidth: 928 },
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    appendChild(c) { this.children.push(c); },
    prepend(c) { this.children.unshift(c); },
    querySelector() { return makeEl(id + '>q'); },
    getContext() { return makeCtx2d(); },
    click() { if (this.onclick) this.onclick(); },
    get childNodes() { return this.children; },
    get lastChild() { const c = this.children[this.children.length - 1]; return c ? Object.assign(c, { remove: () => this.children.pop() }) : null; },
    selectedOptions: [{ text: 'x' }],
  };
  return el;
}

const els = {};
const ids = ['chainCanvas','oaCanvas','log','consistentBadge','chainDetail','testResult','oaMode',
  'statsChain','statsOA','keyInput','batchCount','testOps','hashFn','probeMode','capacity',
  'maxLoadOA','maxLoadChain','btnInsert','btnSearch','btnDelete','btnBatch','btnRandomTest','btnReset'];
ids.forEach(i => els[i] = makeEl(i));
// 模拟浏览器默认选中值
Object.assign(els.hashFn, { value: 'division' });
Object.assign(els.probeMode, { value: 'linear' });
Object.assign(els.capacity, { value: '53' });
Object.assign(els.maxLoadOA, { value: '0.75' });
Object.assign(els.maxLoadChain, { value: '2' });

// 真实 worker.js 运行在 vm 中, 与 app.js 双向通信
let appOnMessage = null;
const workerSandbox = {
  Math, Set, Number, String, Object, Array, Int32Array, Uint8Array, console,
  postMessage: (msg) => { if (appOnMessage) appOnMessage({ data: msg }); },
};
vm.createContext(workerSandbox);
vm.runInContext(fs.readFileSync('worker.js', 'utf8'), workerSandbox);

const sandbox = {
  console,
  document: {
    getElementById: (id) => els[id] || (els[id] = makeEl(id)),
    createElement: () => makeEl('dyn'),
  },
  window: { devicePixelRatio: 2, addEventListener() {} },
  Worker: class {
    constructor() { this.onmessage = null; this.onerror = null; appOnMessage = (e) => this.onmessage && this.onmessage(e); }
    postMessage(msg) { workerSandbox.onmessage({ data: msg }); }
  },
  setInterval: (fn, ms) => realSetInterval(() => { try { fn(); } catch (e) { errors.push('interval: ' + e.stack); } }, ms),
  setTimeout: (fn, ms) => realSetTimeout(() => { try { fn(); } catch (e) { errors.push('timeout: ' + e.stack); } }, ms),
  clearInterval, clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('app.js', 'utf8'), sandbox);

const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));

(async () => {
  await sleep(50);
  // 单键操作流
  els.keyInput.value = '42';
  els.btnInsert.click(); await sleep(50);
  els.btnSearch.click(); await sleep(2500);   // 等动画跑完
  els.btnDelete.click(); await sleep(2500);
  els.btnSearch.click(); await sleep(300);
  // 空表查询
  els.keyInput.value = '7';
  els.btnSearch.click(); await sleep(300);
  // 批量插入(触发扩容路径)
  els.batchCount.value = '500';
  els.btnBatch.click(); await sleep(500);
  // 单键动画(大表)
  els.keyInput.value = '123456';
  els.btnInsert.click(); await sleep(3500);
  els.btnSearch.click(); await sleep(3500);
  // 随机一致性测试
  els.testOps.value = '2000';
  els.btnRandomTest.click(); await sleep(1500);
  const testText = els.testResult.textContent; // 在后续重置前捕获
  // 配置变更
  els.probeMode.value = 'quadratic';
  els.probeMode.listeners.change.forEach(f => f()); await sleep(200);
  els.hashFn.value = 'multiply';
  els.hashFn.listeners.change.forEach(f => f()); await sleep(200);
  // 重置
  els.btnReset.click(); await sleep(200);

  console.log('--- 一致性测试面板 ---');
  console.log(testText);
  console.log('--- 日志前 5 条 ---');
  els.log.children.slice(0, 5).forEach(c => console.log(c.textContent));
  if (errors.length) {
    console.log('\nUI ERRORS:'); errors.forEach(e => console.log(e));
    process.exit(1);
  }
  if (!testText.includes('不一致 0 次')) { console.log('\nFAIL: 一致性测试未通过'); process.exit(1); }
  console.log('\nUI SMOKE TEST PASSED');
  process.exit(0);
})();
