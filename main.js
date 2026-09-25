/* 主线程：UI 交互 + Canvas 渲染。所有哈希表计算都在 Web Worker 中执行。 */
'use strict';

const worker = new Worker('worker.js');

const els = {
  keyInput: document.getElementById('keyInput'),
  hashFn: document.getElementById('hashFn'),
  capacity: document.getElementById('capacity'),
  consistency: document.getElementById('consistency'),
  lastOp: document.getElementById('lastOp'),
  statsBody: document.querySelector('#statsTable tbody'),
  progress: document.getElementById('progress'),
  log: document.getElementById('log'),
  chainCanvas: document.getElementById('chainCanvas'),
  linearCanvas: document.getElementById('linearCanvas'),
  quadCanvas: document.getElementById('quadCanvas'),
};

const EMPTY = 0, OCCUPIED = 1, TOMBSTONE = 2;
const COLORS = {
  empty: '#1e293b', occ: '#2563eb', tomb: '#d97706',
  probeStroke: '#facc15', probeText: '#fde68a',
  bar: '#3b82f6', barProbe: '#facc15', grid: '#0f172a',
};

let latestState = null;   // 最近一次 Worker 回传的完整状态
let lastOpInfo = null;    // 最近一次单步操作（含探测路径）
let needsRender = true;

/* ---------------- 日志 ---------------- */
function logLine(html, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.innerHTML = html;
  els.log.prepend(div);
  while (els.log.children.length > 200) els.log.lastChild.remove();
}

/* ---------------- Worker 通信 ---------------- */
function sendOp(op) {
  const key = parseInt(els.keyInput.value, 10);
  if (!Number.isFinite(key)) { logLine('请输入合法整数键', 'err'); return; }
  worker.postMessage({ type: 'op', op, key: key | 0 });
}

function resetTables() {
  worker.postMessage({
    type: 'reset',
    capacity: parseInt(els.capacity.value, 10),
    hashFn: els.hashFn.value,
  });
  logLine(`重置表：容量 ${els.capacity.value}，哈希函数 ${els.hashFn.selectedOptions[0].text}`, 'dim');
}

function makeBatch(kind, n) {
  // 在 Worker 线程外生成操作序列，避免主线程被计算占用（仅生成数组，O(n) 很快）
  const ops = new Array(n);
  const live = [];
  for (let i = 0; i < n; i++) {
    if (kind === 'insert') {
      ops[i] = ['insert', (Math.random() * 0x7fffffff) | 0];
    } else {
      const r = Math.random();
      if (r < 0.45 || live.length === 0) {
        const k = (Math.random() * 0x7fffffff) | 0;
        live.push(k);
        ops[i] = ['insert', k];
      } else if (r < 0.75) {
        const k = live[(Math.random() * live.length) | 0];
        ops[i] = ['query', k];
      } else {
        const idx = (Math.random() * live.length) | 0;
        ops[i] = ['delete', live[idx]];
        live[idx] = live[live.length - 1];
        live.pop();
      }
    }
  }
  return ops;
}

function runBatch(kind) {
  const n = parseInt(document.getElementById('batchSize').value, 10);
  els.progress.textContent = '生成操作序列…';
  // 让出一帧再发，保证进度文字先渲染
  requestAnimationFrame(() => {
    worker.postMessage({ type: 'batch', ops: makeBatch(kind, n) });
    els.progress.textContent = '压测运行中（Worker 线程）…';
    logLine(`开始${kind === 'insert' ? '批量插入' : '混合压测'}：${n.toLocaleString()} 次操作`, 'dim');
  });
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'progress') {
    els.progress.textContent = `压测中 ${msg.done.toLocaleString()} / ${msg.total.toLocaleString()}`;
    return;
  }
  if (msg.type === 'verify') {
    reportVerify(msg.result);
    return;
  }
  // type === 'state'
  latestState = msg;
  if (msg.lastOp) {
    lastOpInfo = msg.lastOp;
    reportOp(msg.lastOp);
  }
  if (msg.batchDone) {
    const b = msg.batchDone;
    els.progress.textContent = `完成 ${b.total.toLocaleString()} 次操作`;
    logLine(
      `压测完成：${b.total.toLocaleString()} 次操作，单步一致性 ${b.allConsistent ? '<span class="ok">通过</span>' : '<span class="err">失败</span>'}，` +
      `全量键集校验 ${b.verify.consistent ? '<span class="ok">通过</span>' : '<span class="err">失败</span>'}（sizes: ${b.verify.sizes.join('/')}）`,
      b.allConsistent && b.verify.consistent ? 'ok' : 'err'
    );
    updateConsistencyBadge(b.allConsistent && b.verify.consistent);
  }
  updateStats(msg.stats);
  needsRender = true;
};

function reportOp(op) {
  const names = { insert: '插入', query: '查询', delete: '删除' };
  const r = op.results;
  const desc = (x, isChain) => {
    if (isChain) return `桶${x.bucket} 链上探测${x.probes}次`;
    return `探测${x.probes}次`;
  };
  const verdictOf = (x) => ('inserted' in x) ? (x.inserted ? '新插入' : '已存在') : ('found' in x ? (x.found ? '命中' : '未命中') : '');
  els.lastOp.textContent =
    `${names[op.op]} ${op.key} → 链地址[${verdictOf(r.chain)}] 线性[${verdictOf(r.linear)}] 二次[${verdictOf(r.quadratic)}]`;
  logLine(
    `${names[op.op]} <b>${op.key}</b>：` +
    `链地址 ${verdictOf(r.chain)}（${desc(r.chain, true)}）；` +
    `线性 ${verdictOf(r.linear)}（${desc(r.linear)}）；` +
    `二次 ${verdictOf(r.quadratic)}（${desc(r.quadratic)}）` +
    (op.consistent ? '' : ' <span class="err">⚠ 三表结论不一致！</span>'),
    op.consistent ? '' : 'err'
  );
  updateConsistencyBadge(op.consistent);
}

function reportVerify(v) {
  logLine(
    `全量校验：三表键集${v.consistent ? '<span class="ok">完全一致</span>' : '<span class="err">不一致</span>'}（sizes: ${v.sizes.join('/')}）`,
    v.consistent ? 'ok' : 'err'
  );
  updateConsistencyBadge(v.consistent);
}

function updateConsistencyBadge(ok) {
  els.consistency.textContent = ok ? '一致性：✓ 三表结果一致' : '一致性：✗ 结果不一致';
  els.consistency.className = 'badge ' + (ok ? 'ok' : 'bad');
}

/* ---------------- 统计表 ---------------- */
function updateStats(stats) {
  els.statsBody.innerHTML = stats.map(s => `
    <tr>
      <td>${s.name}</td>
      <td>${s.size}</td>
      <td>${s.capacity}</td>
      <td>${s.loadFactor.toFixed(3)}</td>
      <td>${s.collisions}</td>
      <td>${s.avgProbe.toFixed(3)}</td>
      <td>${s.tombstones}</td>
    </tr>`).join('');
}

/* ---------------- Canvas 渲染 ---------------- */
function drawChain(canvas, snapU16, capacity, probeBucket) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!snapU16 || capacity === 0) return;
  const lens = new Uint16Array(snapU16);
  let maxLen = 1;
  for (let i = 0; i < lens.length; i++) if (lens[i] > maxLen) maxLen = lens[i];
  const pad = 4, axisH = 18;
  const plotH = H - pad * 2 - axisH;
  const barW = W / capacity;
  // 背景网格线
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  for (let g = 0; g <= maxLen; g += Math.max(1, Math.ceil(maxLen / 5))) {
    const y = pad + plotH - (g / maxLen) * plotH;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(String(g), 2, y - 2);
  }
  for (let b = 0; b < capacity; b++) {
    const len = lens[b];
    if (len === 0) continue;
    const h = (len / maxLen) * plotH;
    ctx.fillStyle = b === probeBucket ? COLORS.barProbe : COLORS.bar;
    ctx.fillRect(b * barW, pad + plotH - h, Math.max(1, barW - (barW > 3 ? 1 : 0)), h);
  }
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  ctx.fillText(`桶 0 … ${capacity - 1}（共 ${capacity} 桶，最高链长 ${maxLen}）`, W / 2, H - 4);
}

function drawOpen(canvas, snapU8, capacity, probePath) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!snapU8 || capacity === 0) return;
  const meta = new Uint8Array(snapU8);
  const cols = Math.ceil(Math.sqrt(capacity * (W / H)));
  const rows = Math.ceil(capacity / cols);
  const cw = W / cols, ch = (H - 16) / rows;
  const gap = cw > 8 ? 1 : 0;
  for (let i = 0; i < capacity; i++) {
    const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
    const st = meta[i];
    ctx.fillStyle = st === OCCUPIED ? COLORS.occ : st === TOMBSTONE ? COLORS.tomb : COLORS.empty;
    ctx.fillRect(cx + gap, cy + gap, cw - gap * 2, ch - gap * 2);
  }
  // 探测路径高亮 + 顺序编号
  if (probePath && probePath.length) {
    ctx.strokeStyle = COLORS.probeStroke;
    ctx.lineWidth = 2;
    const showText = probePath.length <= 24 && cw >= 14 && ch >= 12;
    ctx.font = `${Math.min(11, ch - 3)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    probePath.forEach((idx, order) => {
      const cx = (idx % cols) * cw, cy = Math.floor(idx / cols) * ch;
      ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
      if (showText) {
        ctx.fillStyle = COLORS.probeText;
        ctx.fillText(String(order + 1), cx + cw / 2, cy + ch / 2);
      }
    });
  }
  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`容量 ${capacity}（蓝=占用 橙=墓碑 黄框=本次探测路径）`, W / 2, H - 3);
}

function render() {
  if (!needsRender || !latestState) { requestAnimationFrame(render); return; }
  needsRender = false;
  const s = latestState.snapshots;
  const probe = lastOpInfo ? lastOpInfo.results : null;
  drawChain(els.chainCanvas, s.chain, s.chainCapacity, probe ? probe.chain.bucket : -1);
  drawOpen(els.linearCanvas, s.linear, s.linearCapacity, probe ? probe.linear.path : null);
  drawOpen(els.quadCanvas, s.quadratic, s.quadraticCapacity, probe ? probe.quadratic.path : null);
  requestAnimationFrame(render);
}

/* ---------------- 事件绑定 ---------------- */
document.getElementById('btnInsert').addEventListener('click', () => sendOp('insert'));
document.getElementById('btnQuery').addEventListener('click', () => sendOp('query'));
document.getElementById('btnDelete').addEventListener('click', () => sendOp('delete'));
document.getElementById('btnRandomKey').addEventListener('click', () => {
  els.keyInput.value = (Math.random() * 0x7fffffff) | 0;
});
document.getElementById('btnReset').addEventListener('click', resetTables);
document.getElementById('btnBatchInsert').addEventListener('click', () => runBatch('insert'));
document.getElementById('btnBatchMixed').addEventListener('click', () => runBatch('mixed'));
els.keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendOp('insert'); });

/* ---------------- 启动 ---------------- */
resetTables();
requestAnimationFrame(render);
