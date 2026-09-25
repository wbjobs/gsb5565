/*
 * 哈希表核心实现（TypedArray 存储）
 *  - ChainingTable:        链地址法（桶内链表，节点池 + 空闲链表复用）
 *  - OpenAddressingTable:  开放寻址法（线性探测 / 二次探测，墓碑删除）
 * 该文件同时被 Web Worker（importScripts）与 Node 测试（require）使用。
 */
(function (global) {
  'use strict';

  /* ---------------- 哈希函数 ---------------- */
  // 输入整数 key，输出 uint32 哈希值；槽位下标统一用 hash & mask（容量为 2 的幂）
  const HASH_FNS = {
    // 除留余数法（容量为 2 的幂时退化为取低位，对顺序键友好、对高位模式键较差）
    division(key) {
      return key >>> 0;
    },
    // 乘法散列（Knuth, A = 2654435761 = (sqrt(5)-1)/2 * 2^32）
    multiply(key) {
      return Math.imul(key >>> 0, 2654435761) >>> 0;
    },
    // 平方取中法
    midsquare(key) {
      const x = key >>> 0;
      const sq = Math.imul(x, x) >>> 0;
      return ((sq >>> 8) ^ (sq & 0xffff)) >>> 0;
    },
    // FNV-1a（把整数当 4 字节处理）
    fnv1a(key) {
      let h = 0x811c9dc5;
      for (let i = 0; i < 4; i++) {
        h ^= (key >>> (i * 8)) & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h >>> 0;
    },
  };
  const HASH_NAMES = Object.keys(HASH_FNS);

  function hashKey(fnName, key) {
    const fn = HASH_FNS[fnName] || HASH_FNS.multiply;
    return fn(key | 0);
  }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  /* ---------------- 链地址法 ---------------- */
  const CHAIN_RESIZE_LF = 0.75; // 装载因子阈值

  class ChainingTable {
    constructor(capacity, hashFn) {
      this.name = '链地址法';
      this.kind = 'chain';
      this.hashFn = hashFn || 'multiply';
      this.bucketCount = nextPow2(Math.max(8, capacity || 16));
      this.mask = this.bucketCount - 1;
      this.heads = new Int32Array(this.bucketCount).fill(-1);
      // 节点池：keys/next 平行数组，删除的节点进入空闲链表复用
      this.nodeCap = Math.max(16, this.bucketCount * 2);
      this.keys = new Int32Array(this.nodeCap);
      this.next = new Int32Array(this.nodeCap);
      this.nodeCount = 0;
      this.freeHead = -1;
      // 统计
      this.size = 0;
      this.collisions = 0;   // 插入时桶非空（且非同键）计一次冲突
      this.totalProbes = 0;  // 累计探测（链表节点访问）次数
      this.probeOps = 0;     // 参与统计的操作次数
    }

    _index(key) { return hashKey(this.hashFn, key) & this.mask; }

    _allocNode() {
      if (this.freeHead !== -1) {
        const idx = this.freeHead;
        this.freeHead = this.next[idx];
        return idx;
      }
      if (this.nodeCount >= this.nodeCap) this._growNodePool();
      return this.nodeCount++;
    }

    _growNodePool() {
      const newCap = this.nodeCap * 2;
      const keys = new Int32Array(newCap);
      const next = new Int32Array(newCap);
      keys.set(this.keys); next.set(this.next);
      this.keys = keys; this.next = next;
      this.nodeCap = newCap;
    }

    _freeNode(idx) {
      this.next[idx] = this.freeHead;
      this.freeHead = idx;
    }

    // 返回 { inserted, collision, probes, bucket }
    insert(key) {
      key = key | 0;
      const bucket = this._index(key);
      let probes = 0;
      let collision = false;
      for (let cur = this.heads[bucket]; cur !== -1; cur = this.next[cur]) {
        probes++;
        if (this.keys[cur] === key) {
          this.totalProbes += probes; this.probeOps++;
          return { inserted: false, collision: false, probes, bucket };
        }
        collision = true;
      }
      if (collision) this.collisions++;
      const node = this._allocNode();
      this.keys[node] = key;
      this.next[node] = this.heads[bucket];
      this.heads[bucket] = node;
      this.size++;
      this.totalProbes += Math.max(probes, 1); this.probeOps++;
      if (this.size / this.bucketCount > CHAIN_RESIZE_LF) this._resize(this.bucketCount * 2);
      return { inserted: true, collision, probes: Math.max(probes, 1), bucket };
    }

    // 返回 { found, probes, bucket }
    query(key) {
      key = key | 0;
      const bucket = this._index(key);
      let probes = 0;
      for (let cur = this.heads[bucket]; cur !== -1; cur = this.next[cur]) {
        probes++;
        if (this.keys[cur] === key) {
          this.totalProbes += probes; this.probeOps++;
          return { found: true, probes, bucket };
        }
      }
      this.totalProbes += Math.max(probes, 1); this.probeOps++;
      return { found: false, probes: Math.max(probes, 1), bucket };
    }

    // 返回 { found, probes, bucket }
    delete(key) {
      key = key | 0;
      const bucket = this._index(key);
      let probes = 0;
      let prev = -1;
      for (let cur = this.heads[bucket]; cur !== -1; cur = this.next[cur]) {
        probes++;
        if (this.keys[cur] === key) {
          if (prev === -1) this.heads[bucket] = this.next[cur];
          else this.next[prev] = this.next[cur];
          this._freeNode(cur);
          this.size--;
          this.totalProbes += probes; this.probeOps++;
          return { found: true, probes, bucket };
        }
        prev = cur;
      }
      this.totalProbes += Math.max(probes, 1); this.probeOps++;
      return { found: false, probes: Math.max(probes, 1), bucket };
    }

    _resize(newBucketCount) {
      const newHeads = new Int32Array(newBucketCount).fill(-1);
      const newMask = newBucketCount - 1;
      for (let b = 0; b < this.bucketCount; b++) {
        let cur = this.heads[b];
        while (cur !== -1) {
          const nxt = this.next[cur];
          const nb = hashKey(this.hashFn, this.keys[cur]) & newMask;
          this.next[cur] = newHeads[nb];
          newHeads[nb] = cur;
          cur = nxt;
        }
      }
      this.heads = newHeads;
      this.bucketCount = newBucketCount;
      this.mask = newMask;
    }

    loadFactor() { return this.size / this.bucketCount; }
    avgProbe() { return this.probeOps ? this.totalProbes / this.probeOps : 0; }

    // 桶分布快照（每桶链长），用于可视化
    snapshot() {
      const lens = new Uint16Array(this.bucketCount);
      for (let b = 0; b < this.bucketCount; b++) {
        let len = 0;
        for (let cur = this.heads[b]; cur !== -1; cur = this.next[cur]) len++;
        lens[b] = len;
      }
      return lens;
    }

    keysSorted() {
      const out = [];
      for (let i = 0; i < this.nodeCount; i++) {
        // 节点池中被删除的节点在空闲链表里，需排除
      }
      // 直接遍历桶收集，避免空闲节点干扰
      out.length = 0;
      for (let b = 0; b < this.bucketCount; b++) {
        for (let cur = this.heads[b]; cur !== -1; cur = this.next[cur]) out.push(this.keys[cur]);
      }
      return out.sort((a, b) => a - b);
    }

    stats() {
      return {
        kind: this.kind, name: this.name,
        size: this.size, capacity: this.bucketCount,
        loadFactor: this.loadFactor(),
        collisions: this.collisions,
        avgProbe: this.avgProbe(),
        tombstones: 0,
      };
    }
  }

  /* ---------------- 开放寻址法 ---------------- */
  const EMPTY = 0, OCCUPIED = 1, TOMBSTONE = 2;
  const OA_RESIZE_LF = 0.7; // (size + tombstones) / capacity 阈值

  class OpenAddressingTable {
    constructor(capacity, hashFn, probeType) {
      this.kind = 'open';
      this.probeType = probeType === 'quadratic' ? 'quadratic' : 'linear';
      this.name = this.probeType === 'quadratic' ? '开放寻址-二次探测' : '开放寻址-线性探测';
      this.hashFn = hashFn || 'multiply';
      this.capacity = nextPow2(Math.max(8, capacity || 16));
      this.mask = this.capacity - 1;
      this.keys = new Int32Array(this.capacity);
      this.meta = new Uint8Array(this.capacity); // 0空 1占用 2墓碑
      // 统计
      this.size = 0;
      this.tombstones = 0;
      this.collisions = 0;
      this.totalProbes = 0;
      this.probeOps = 0;
    }

    _home(key) { return hashKey(this.hashFn, key) & this.mask; }

    // 第 i 次探测的槽位（i 从 0 开始）
    _slot(h, i) {
      if (this.probeType === 'linear') return (h + i) & this.mask;
      // 二次探测：三角数序列 i*(i+1)/2，容量为 2 的幂时可遍历全部槽位
      return (h + (i * (i + 1)) / 2) & this.mask;
    }

    // 返回 { inserted, collision, probes, path }
    insert(key) {
      key = key | 0;
      const h = this._home(key);
      const path = [];
      let firstTomb = -1;
      let collision = false;
      let probes = 0;
      for (let i = 0; i < this.capacity; i++) {
        const idx = this._slot(h, i);
        path.push(idx);
        probes++;
        const st = this.meta[idx];
        if (st === EMPTY) {
          const target = firstTomb !== -1 ? firstTomb : idx;
          if (collision) this.collisions++;
          this.keys[target] = key;
          this.meta[target] = OCCUPIED;
          if (firstTomb !== -1) this.tombstones--;
          this.size++;
          this.totalProbes += probes; this.probeOps++;
          if ((this.size + this.tombstones) / this.capacity > OA_RESIZE_LF) {
            this._resize(this.capacity * 2);
          }
          return { inserted: true, collision, probes, path };
        }
        if (st === TOMBSTONE) {
          if (firstTomb === -1) firstTomb = idx;
          continue;
        }
        if (this.keys[idx] === key) {
          this.totalProbes += probes; this.probeOps++;
          return { inserted: false, collision: false, probes, path };
        }
        collision = true;
      }
      // 表满且无空槽（理论上装载因子控制下不会走到，这里兜底扩容重试）
      this._resize(this.capacity * 2);
      return this.insert(key);
    }

    // 返回 { found, probes, path }
    query(key) {
      key = key | 0;
      const h = this._home(key);
      const path = [];
      let probes = 0;
      for (let i = 0; i < this.capacity; i++) {
        const idx = this._slot(h, i);
        path.push(idx);
        probes++;
        const st = this.meta[idx];
        if (st === EMPTY) break;
        if (st === OCCUPIED && this.keys[idx] === key) {
          this.totalProbes += probes; this.probeOps++;
          return { found: true, probes, path };
        }
      }
      this.totalProbes += probes; this.probeOps++;
      return { found: false, probes, path };
    }

    // 返回 { found, probes, path }
    delete(key) {
      key = key | 0;
      const h = this._home(key);
      const path = [];
      let probes = 0;
      for (let i = 0; i < this.capacity; i++) {
        const idx = this._slot(h, i);
        path.push(idx);
        probes++;
        const st = this.meta[idx];
        if (st === EMPTY) break;
        if (st === OCCUPIED && this.keys[idx] === key) {
          this.meta[idx] = TOMBSTONE; // 墓碑标记，保证后续探测链不断
          this.tombstones++;
          this.size--;
          this.totalProbes += probes; this.probeOps++;
          return { found: true, probes, path };
        }
      }
      this.totalProbes += probes; this.probeOps++;
      return { found: false, probes, path };
    }

    _resize(newCapacity) {
      const oldKeys = this.keys, oldMeta = this.meta, oldCap = this.capacity;
      this.capacity = newCapacity;
      this.mask = newCapacity - 1;
      this.keys = new Int32Array(newCapacity);
      this.meta = new Uint8Array(newCapacity);
      const oldSize = this.size;
      this.size = 0;
      this.tombstones = 0; // 扩容重哈希时丢弃墓碑
      for (let i = 0; i < oldCap; i++) {
        if (oldMeta[i] === OCCUPIED) this._reinsert(oldKeys[i]);
      }
      this.size = oldSize;
    }

    // 扩容内部插入：不触碰统计计数器
    _reinsert(key) {
      const h = this._home(key);
      for (let i = 0; i < this.capacity; i++) {
        const idx = this._slot(h, i);
        if (this.meta[idx] !== OCCUPIED) {
          this.keys[idx] = key;
          this.meta[idx] = OCCUPIED;
          return;
        }
      }
    }

    loadFactor() { return this.size / this.capacity; }
    effectiveLoad() { return (this.size + this.tombstones) / this.capacity; }
    avgProbe() { return this.probeOps ? this.totalProbes / this.probeOps : 0; }

    // 槽位状态快照（0空 1占用 2墓碑），用于可视化
    snapshot() {
      return this.meta.slice();
    }

    keysSorted() {
      const out = [];
      for (let i = 0; i < this.capacity; i++) {
        if (this.meta[i] === OCCUPIED) out.push(this.keys[i]);
      }
      return out.sort((a, b) => a - b);
    }

    stats() {
      return {
        kind: this.kind, name: this.name, probeType: this.probeType,
        size: this.size, capacity: this.capacity,
        loadFactor: this.loadFactor(),
        collisions: this.collisions,
        avgProbe: this.avgProbe(),
        tombstones: this.tombstones,
      };
    }
  }

  const api = {
    ChainingTable, OpenAddressingTable,
    HASH_FNS, HASH_NAMES, hashKey,
    EMPTY, OCCUPIED, TOMBSTONE,
    CHAIN_RESIZE_LF, OA_RESIZE_LF,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.HashTables = api;
})(typeof self !== 'undefined' ? self : globalThis);
