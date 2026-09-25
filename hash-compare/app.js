'use strict';
/* 主线程: 仅负责 UI、Canvas 渲染与探测动画; 所有哈希计算在 worker.js 中执行 */

const worker = new Worker('worker.js');

const $ = (id) => document.getElementById(id);
const chainCanvas = $('chainCanvas');
const oaCanvas = $('oaCanvas');
const logBox = $('log');

let lastSnap = null;
let animTimer = null;
let chainAnimTimer = null;

/* ---------------- 日志 ---------------- */
function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logBox.prepend(line);
  while (logBox.childNodes.length > 200) logBox.lastChild.remove();
}

/* ---------------- Canvas 工具 ---------------- */
const DPR = window.devicePixelRatio || 1;
function fitCanvas(canvas, cssHeight) {
  const w = canvas.clientWidth || canvas.parentElement.clientWidth - 28;
  canvas.width = Math.round(w * DPR);
  canvas.height = Math.round(cssHeight * DPR);
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  return { ctx, w, h: cssHeight };
}

const COLORS = {
  empty: '#e8eaed', occupied: '#4a90d9', tomb: '#f0a35e',
  probing: '#ffd54a', hit: '#5cb85c', miss: '#d9534f',
};

/* ---------------- 链地址法: 桶分布直方图 ---------------- */
function chainLengths(snap) {
  const { cap, heads, next } = snap.chain;
  const lens = new Array(cap).fill(0);
  for (let b = 0; b < cap; b++) {
    let idx = heads[b];
    while (idx !== -1 && idx < next.length) { lens[b]++; idx = next[idx]; }
  }
  return lens;
}

function renderChain(highlightBucket) {
  if (!lastSnap) return;
  const lens = chainLengths(lastSnap);
  const maxLen = Math.max(1, ...lens);
  const { ctx, w, h } = fitCanvas(chainCanvas, 240);
  const padB = 18, padT = 8;
  const bw = w / lastSnap.chain.cap;
  for (let b = 0; b < lens.length; b++) {
    const bh = (h - padB - padT) * (lens[b] / maxLen);
    const ratio = lens[b] / maxLen;
    ctx.fillStyle = b === highlightBucket
      ? COLORS.probing
      : `hsl(${210 - ratio * 180}, 70%, ${62 - ratio * 18}%)`;
    ctx.fillRect(b * bw, h - padB - bh, Math.max(1, bw - 0.5), bh);
  }
  ctx.fillStyle = '#57606a';
  ctx.font = '11px sans-serif';
  ctx.fillText(`桶数 ${lens.length} · 最大链长 ${maxLen} · 空桶 ${lens.filter(x => x === 0).length}`, 6, h - 5);
  if (highlightBucket !== undefined && highlightBucket !== null) {
    ctx.strokeStyle = '#d4a72c';
    ctx.lineWidth = 2;
    ctx.strokeRect(highlightBucket * bw, padT, Math.max(2, bw), h - padB - padT);
  }
}

/* ---------------- 开放寻址法: 槽位网格 ---------------- */
function renderOA(highlight) {
  if (!lastSnap) return;
  const { cap, state, keys } = lastSnap.oa;
  const cols = Math.ceil(Math.sqrt(cap));
  const rows = Math.ceil(cap / cols);
  const cssW = oaCanvas.clientWidth || oaCanvas.parentElement.clientWidth - 28;
  const cell = Math.max(14, Math.floor(cssW / cols));
  const { ctx, w } = fitCanvas(oaCanvas, rows * cell + 24);
  const hlMap = new Map(); // slot -> 'probing' | 'hit' | 'miss'
  if (highlight) {
    highlight.path.slice(0, highlight.step + 1).forEach((s, i) => {
      hlMap.set(s, i === highlight.step ? highlight.kind : 'probing');
    });
  }
  ctx.font = `${Math.min(11, cell * 0.4)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let s = 0; s < cap; s++) {
    const r = Math.floor(s / cols), c = s % cols;
    const x = c * cell, y = r * cell;
    let color = state[s] === 1 ? COLORS.occupied : state[s] === 2 ? COLORS.tomb : COLORS.empty;
    if (hlMap.has(s)) color = COLORS[hlMap.get(s)];
    ctx.fillStyle = color;
    ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
    if (state[s] === 1 && cell >= 22) {
      ctx.fillStyle = hlMap.has(s) ? '#24292f' : '#fff';
      ctx.fillText(String(keys[s]), x + cell / 2, y + cell / 2);
    } else if (state[s] === 2 && cell >= 22) {
      ctx.fillStyle = '#7d4e00';
      ctx.fillText('✕', x + cell / 2, y + cell / 2);
    }
  }
  ctx.fillStyle = '#57606a';
  ctx.textAlign = 'left';
  ctx.font = '11px sans-serif';
  const used = state.reduce((a, v) => a + (v === 1 ? 1 : 0), 0);
  const tombs = state.reduce((a, v) => a + (v === 2 ? 1 : 0), 0);
  ctx.fillText(`容量 ${cap} · 占用 ${used} · 墓碑 ${tombs} · 空槽 ${cap - used - tombs}`, 6, rows * cell + 15);
}

function renderAll() {
  renderChain();
  renderOA();
  renderStats();
}

/* ---------------- 统计面板 ---------------- */
function statRows(s, isOA) {
  const f = (x) => (Math.round(x * 1000) / 1000).toFixed(3);
  const rows = [
    ['容量', s.capacity],
    ['元素个数', s.size],
    ['装载因子 α', f(s.loadFactor)],
    ['冲突次数(累计)', s.collisions],
    ['平均插入探测长度', f(s.avgInsertProbe)],
    ['平均成功查询探测长度', f(s.avgHitProbe)],
    ['平均失败查询探测长度', f(s.avgMissProbe)],
    ['查询次数 (成功/失败)', `${s.hitCount} / ${s.missCount}`],
    ['扩容次数', s.resizes],
  ];
  if (isOA) rows.push(['墓碑数量', s.tombstones]);
  return rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

function renderStats() {
  if (!lastSnap) return;
  $('statsChain').querySelector('table').innerHTML = statRows(lastSnap.stats.chain, false);
  $('statsOA').querySelector('table').innerHTML = statRows(lastSnap.stats.oa, true);
  $('oaMode').textContent = lastSnap.cfg.probeMode === 'linear' ? '线性探测' : '二次探测';
}

/* ---------------- 探测过程动画 ---------------- */
function cancelAnim() {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  if (chainAnimTimer) { clearInterval(chainAnimTimer); chainAnimTimer = null; }
}

function describeOp(op, key, r, probes) {
  const name = { insert: '插入', search: '查询', delete: '删除' }[op];
  if (op === 'insert') return r.dup ? `${name} ${key}: 键已存在` : `${name} ${key}: 成功, 探测 ${probes} 次`;
  if (op === 'search') return r.found ? `${name} ${key}: 命中, 探测 ${probes} 次` : `${name} ${key}: 未找到, 探测 ${probes} 次`;
  return r.ok ? `${name} ${key}: 成功(标记墓碑), 探测 ${probes} 次` : `${name} ${key}: 键不存在`;
}

function animateOp(msg) {
  cancelAnim();
  const { op, key, chain: rc, oa: ro } = msg;

  // 日志 + 一致性
  log(`[链地址] ${describeOp(op, key, rc, rc.probes)}`);
  log(`[开放寻址] ${describeOp(op, key, ro, ro.probes)}`);
  const badge = $('consistentBadge');
  if (op === 'search') {
    const same = rc.found === ro.found;
    badge.textContent = same ? '✓ 两策略结果一致' : '✗ 结果不一致!';
    badge.className = 'badge ' + (same ? 'ok' : 'bad');
    if (!same) log('一致性校验失败!', 'err');
    if (lastSnap && lastSnap.stats.chain.size === 0) log('注意: 当前为空表查询', 'warn');
  } else {
    badge.className = 'badge hidden';
  }

  // 若本次操作触发了扩容, 探测路径基于旧表几何, 直接展示扩容后结果
  const resized = msg.capsAfter &&
    (msg.caps.oa !== msg.capsAfter.oa || msg.caps.chain !== msg.capsAfter.chain);
  if (resized) {
    log(`装载因子超阈值, 已扩容: 链地址 ${msg.caps.chain}→${msg.capsAfter.chain}, 开放寻址 ${msg.caps.oa}→${msg.capsAfter.oa}（全部数据已 rehash，无丢失）`, 'warn');
    renderAll();
    return;
  }

  // 开放寻址: 逐槽高亮探测路径
  const oaPath = ro.path || [];
  const finalKind = (op === 'search' && !ro.found) || (op === 'delete' && !ro.ok) ? 'miss' : 'hit';
  let step = 0;
  // 链地址: DOM 展示链遍历
  animateChainDetail(rc, op);

  if (oaPath.length === 0) { renderOA(); return; }
  const interval = Math.max(60, Math.min(300, 3000 / oaPath.length));
  animTimer = setInterval(() => {
    const kind = step === oaPath.length - 1 ? finalKind : 'probing';
    renderOA({ path: oaPath, step, kind });
    step++;
    if (step >= oaPath.length) {
      cancelAnim();
      setTimeout(() => renderOA(), 1200); // 动画结束后恢复常态视图
    }
  }, interval);
}

function animateChainDetail(rc, op) {
  const box = $('chainDetail');
  box.innerHTML = '';
  if (!rc.path || rc.path.length === 0) { box.textContent = '（空路径）'; return; }
  const bucket = rc.path[0].bucket;
  const nodes = rc.path.slice(1);
  const found = (op === 'search' && rc.found) || (op === 'delete' && rc.ok) || (op === 'insert' && rc.dup);
  const label = document.createElement('span');
  label.textContent = `桶 ${bucket} →`;
  box.appendChild(label);
  if (nodes.length === 0) {
    const em = document.createElement('span');
    em.textContent = '（空桶，直接' + (op === 'insert' ? '插入' : '判定未找到') + '）';
    box.appendChild(em);
    return;
  }
  const els = nodes.map((n) => {
    const el = document.createElement('span');
    el.className = 'node';
    el.textContent = n.key;
    box.appendChild(el);
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    box.appendChild(arrow);
    return el;
  });
  const end = document.createElement('span');
  end.textContent = found ? '' : '∅';
  box.appendChild(end);
  let i = 0;
  chainAnimTimer = setInterval(() => {
    if (i > 0) els[i - 1].classList.remove('cur');
    if (i >= els.length) {
      clearInterval(chainAnimTimer);
      chainAnimTimer = null;
      if (found) els[els.length - 1].classList.add('found');
      renderChain();
      return;
    }
    els[i].classList.add('cur');
    renderChain(bucket);
    i++;
  }, 350);
}

/* ---------------- Worker 消息 ---------------- */
worker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'snapshot':
      lastSnap = msg;
      if (!animTimer) renderAll();
      else renderStats();
      break;
    case 'opResult':
      animateOp(msg);
      break;
    case 'batchDone':
      log(`批量插入完成: 请求 ${msg.requested}, 实际新增 ${msg.inserted}（其余为重复键）`, 'ok');
      break;
    case 'testResult': {
      const okAll = msg.mismatches === 0 && msg.sizeConsistent;
      $('testResult').textContent =
        `随机操作 ${msg.ops} 次（插入/删除/查询混合）\n` +
        `查询比对 ${msg.checked} 次，不一致 ${msg.mismatches} 次\n` +
        `两表最终元素数一致: ${msg.sizeConsistent ? '是' : '否'}（${msg.finalSize} 个）\n` +
        (okAll ? '✓ 验收通过：两策略查询结果完全一致' : '✗ 存在不一致，请检查实现');
      $('testResult').className = okAll ? 'ok' : 'err';
      log(`随机一致性测试: ${msg.ops} ops, 比对 ${msg.checked} 次, 不一致 ${msg.mismatches}`, okAll ? 'ok' : 'err');
      break;
    }
  }
};

worker.onerror = (e) => log(`Worker 错误: ${e.message}`, 'err');

/* ---------------- 控件 ---------------- */
function readKey() {
  const v = parseInt($('keyInput').value, 10);
  if (Number.isNaN(v) || v < 0 || v > 999999) {
    log('请输入 0~999999 的整数键', 'err');
    return null;
  }
  return v;
}

$('btnInsert').onclick = () => { const k = readKey(); if (k !== null) worker.postMessage({ type: 'insert', key: k }); };
$('btnSearch').onclick = () => { const k = readKey(); if (k !== null) worker.postMessage({ type: 'search', key: k }); };
$('btnDelete').onclick = () => { const k = readKey(); if (k !== null) worker.postMessage({ type: 'delete', key: k }); };
$('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSearch').click(); });

$('btnBatch').onclick = () => {
  const n = Math.max(1, Math.min(20000, parseInt($('batchCount').value, 10) || 100));
  cancelAnim();
  worker.postMessage({ type: 'batchInsert', count: n, keySpace: 1000000 });
  log(`批量随机插入 ${n} 个键（Worker 后台执行，主线程不阻塞）...`);
};

$('btnRandomTest').onclick = () => {
  const n = Math.max(100, Math.min(100000, parseInt($('testOps').value, 10) || 3000));
  cancelAnim();
  worker.postMessage({ type: 'randomTest', ops: n, keySpace: Math.max(100, n >> 2) });
  log(`随机一致性测试启动: ${n} 次混合操作...`);
};

$('btnReset').onclick = () => {
  cancelAnim();
  worker.postMessage({ type: 'reset' });
  $('testResult').textContent = '尚未运行。';
  log('已重置两张哈希表', 'warn');
};

function applyConfig() {
  cancelAnim();
  const cfg = {
    hashFn: $('hashFn').value,
    probeMode: $('probeMode').value,
    capacity: parseInt($('capacity').value, 10) || 53,
    maxLoadOA: parseFloat($('maxLoadOA').value) || 0.75,
    maxLoadChain: parseFloat($('maxLoadChain').value) || 2.0,
  };
  worker.postMessage({ type: 'config', cfg });
  log(`配置更新: 哈希函数=${$('hashFn').selectedOptions[0].text}, 探测=${cfg.probeMode === 'linear' ? '线性' : '二次'}, 容量=${cfg.capacity}, 阈值 OA=${cfg.maxLoadOA}/链=${cfg.maxLoadChain}（表已重置）`, 'warn');
}
['hashFn', 'probeMode', 'capacity', 'maxLoadOA', 'maxLoadChain'].forEach((id) => $(id).addEventListener('change', applyConfig));

window.addEventListener('resize', () => { if (!animTimer) renderAll(); });

// 启动
worker.postMessage({ type: 'reset' });
log('工具已就绪：所有计算在 Web Worker 中执行，主线程仅负责渲染。');
