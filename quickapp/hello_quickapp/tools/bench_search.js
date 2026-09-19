// 检索性能佐证脚本（离线可复现）
// 用法: node tools/bench_search.js [数据集目录]
//
// 作用：在不依赖模拟器的前提下，用与引擎完全一致的分词与哈希，复现"桶定位 → 取候选 id → 回查卡片"
// 的检索路径，输出各阶段耗时与命中数，为技术报告中的性能数据提供可核对的佐证。
// 说明：本脚本衡量的是索引侧的算法成本；真机/模拟器上的端到端耗时另见运行时日志中的
//      SearchEngine.search() 分阶段埋点（stepTimings）。
'use strict'
const fs = require('fs')
const path = require('path')

const BUCKET = 2048
const ROOT = process.argv[2] || path.join(__dirname, '..', 'src', 'common', 'datasets')

// 与引擎 SearchEngine.hashCode 完全一致的 DJBXOR 变体
function hashCode(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) hash = (hash * 33) ^ str.charCodeAt(i)
  return hash >>> 0
}

// 与引擎 _parseQuery 完全一致的入桶分词
function tokenize(text) {
  const tokens = []
  for (const w of String(text).split(/[\s,，、]+/)) {
    if (!w) continue
    if (/^[a-zA-Z]+$/.test(w)) {
      for (let j = 1; j <= w.length; j++) tokens.push(w.substring(0, j).toLowerCase())
    } else {
      for (const ch of w) if (ch && ch.trim()) tokens.push(ch)
    }
  }
  return [...new Set(tokens)]
}

function loadDataset(dir) {
  const blocks = {}
  const files = fs.readdirSync(dir)
  const blockFile = files.find(f => /^block_\d+\.txt$/.test(f))
  if (!blockFile) return null
  for (const line of fs.readFileSync(path.join(dir, blockFile), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const i = line.indexOf('|')
    blocks[+line.slice(0, i)] = line.slice(i + 1).split(',').map(Number)
  }
  const maps = []
  for (const f of files.filter(f => /^map_\d+\.txt$/.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const c = line.split('|')
      maps[+c[0]] = c[3] || ''
    }
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  return { blocks, maps, meta }
}

function bench(name, ds, query) {
  const tokens = tokenize(query)
  const t0 = process.hrtime.bigint()
  const ids = new Set()
  for (const t of tokens) {
    const list = ds.blocks[hashCode(t) % BUCKET]
    if (list) for (const id of list) ids.add(id)
  }
  const t1 = process.hrtime.bigint()
  const titles = [...ids].slice(0, 3).map(i => ds.maps[i]).filter(Boolean)
  const t2 = process.hrtime.bigint()
  return {
    name, query, tokens: tokens.length,
    hits: ids.size,
    intersectUs: Number(t1 - t0) / 1000,     // 桶定位 + 候选合并
    mapUs: Number(t2 - t1) / 1000,           // 回查卡片标题
    sample: titles,
  }
}

const QUERIES = [
  ['history', '亚洲'], ['history', '战争'],
  ['poems', '李'], ['poems', '唐'], ['poems', '杜甫'],
  ['english', 'project'], ['english', 'abandon'],
  ['health', '急救'], ['life', '厨房'], ['study', '记忆'],
]

const datasets = {}
const _ld0 = process.hrtime.bigint()
for (const d of fs.readdirSync(ROOT)) {
  const p = path.join(ROOT, d)
  if (fs.statSync(p).isDirectory()) {
    const ds = loadDataset(p)
    if (ds) datasets[d] = ds
  }
}

const _ldMs = Number(process.hrtime.bigint() - _ld0) / 1e6
console.log('=== 检索索引侧性能佐证（离线，与引擎同一套分词/哈希）===')
console.log('数据集数:', Object.keys(datasets).length, '| 桶数:', BUCKET)
console.log(`索引全量加载（读 6 集 block + map 并解析）: ${_ldMs.toFixed(1)}ms  ← 冷启动代价，之后进内存）`)
console.log('')
let totalMs = 0, totalHits = 0
for (const [ds, q] of QUERIES) {
  if (!datasets[ds]) continue
  const r = bench(ds, datasets[ds], q)
  totalMs += (r.intersectUs + r.mapUs) / 1000
  totalHits += r.hits
  console.log(
    `${ds.padEnd(8)} 查「${r.query}」→ ${String(r.hits).padStart(4)} 命中 | ` +
    `桶定位+合并 ${r.intersectUs.toFixed(1)}µs | 回查卡片 ${r.mapUs.toFixed(1)}µs | ` +
    `例: ${r.sample.join(' / ')}`)
}
console.log('')
console.log(`合计 ${QUERIES.length} 次查询：索引侧总耗时 ${totalMs.toFixed(3)}ms，平均 ${(totalMs / QUERIES.length).toFixed(3)}ms（亚毫秒 = 索引已常驻内存），累计命中 ${totalHits} 条`)
console.log('注：本脚本为索引侧算法成本；端到端耗时（含文件读取与渲染）见运行时日志 stepTimings 埋点。')
