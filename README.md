# 哈希表冲突解决策略对比工具

纯前端实现，对比 **链地址法** 与 **开放寻址法（线性探测 / 二次探测）** 三种策略，
支持插入 / 查询 / 删除，实时统计装载因子、冲突次数、平均探测长度，并用 Canvas 可视化桶分布与探测过程。

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000/index.html
```

> 必须通过 HTTP 访问（Web Worker 不能用 file:// 加载）。

## 测试

```bash
node test.cjs   # 31 项验收测试：一致性 / 统计准确性 / 扩容 / 墓碑 / 空表查询
```

## 架构

| 文件 | 职责 |
| --- | --- |
| `hashtables.js` | 核心数据结构（TypedArray 存储），Worker 与 Node 测试共用 |
| `worker.js` | Web Worker：后台线程维护三张表，批量压测不阻塞 UI |
| `main.js` | 主线程：UI 交互 + Canvas 渲染（链长直方图 / 槽位网格 / 探测路径高亮） |
| `index.html` / `style.css` | 页面布局与样式 |
| `test.cjs` | 对照 Set 参考模型的随机化验收测试 |

## 关键设计

- **TypedArray 存储**：链地址法用 `Int32Array` 节点池（head/next 平行数组 + 空闲链表复用删除节点）；开放寻址用 `Int32Array` 键数组 + `Uint8Array` 状态数组（0 空 / 1 占用 / 2 墓碑）。
- **哈希函数可选**：除留余数、乘法散列（Knuth）、平方取中、FNV-1a；容量恒为 2 的幂，下标用 `hash & mask`。
- **扩容**：链地址法装载因子 > 0.75、开放寻址 (size+墓碑)/容量 > 0.7 时容量翻倍并重哈希；扩容时丢弃墓碑。
- **二次探测**：三角数序列 `i(i+1)/2`，容量为 2 的幂时保证遍历全部槽位。
- **墓碑**：开放寻址删除置墓碑保证探测链不断，插入优先复用墓碑槽。
- **一致性**：Worker 对每次操作校验三表结论（new/dup、hit/miss），压测结束做全量键集比对。
- **主线程不卡**：所有计算在 Worker；快照以 Transferable ArrayBuffer 零拷贝回传；渲染走 `requestAnimationFrame`。
