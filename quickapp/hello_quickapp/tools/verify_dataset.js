#!/usr/bin/env node
// verify_dataset.js —— 资料集校验器
// ─────────────────────────────────────────────────────────────────
// 用法:
//   node tools/verify_dataset.js diff <目录A> <目录B> [--icons]
//       逐字节比对两个资料目录的全部资料文件（map_*/detail_*/block_*/meta.txt/meta.json），
//       用于证明「新工具产出 ≡ 旧脚本产出」或比对改动前后。
//
//   node tools/verify_dataset.js check <目录> [spec] [--quiet]
//       结构校验（无 spec 也能跑）:
//         ① meta.txt 可解析，totalCount = map 行数 = detail 行数
//         ② map/detail 的 localId 从 0 连续递增（引擎二分查找的前提）
//         ③ 分片行数 ≤ 分片参数，meta.maps 覆盖 [0, totalCount-1] 无缝
//         ④ regionIdx 不越界 regionList
//         ⑤ block 桶号 < bucketSize 且桶内 id 全部 < totalCount（越界 = block 过期的铁证）
//         ⑥ detail 列数与 meta.json fields.detail 声明一致
//         ⑦ year_index.txt（若存在）逐 id 比对 map 行年份（历史集过期检测）
//       深度校验（给 spec）: 按 spec 内存重建全部产物，与盘上逐字节比对。
'use strict'

const fs = require('fs')
const path = require('path')
const core = require('./lib/dataset_core.js')

const ROOT = path.join(__dirname, '..')
const DATA_RE = /^(map|detail)_\d+\.txt$/

function listDataFiles(dir, includeIcons) {
  const files = fs.readdirSync(dir).filter(f =>
    DATA_RE.test(f) || f === 'block_0.txt' || f === 'meta.txt' || f === 'meta.json'
    || (includeIcons && f === 'icon.png'))
  files.sort()
  return files
}

// ── diff：字节级比对 ─────────────────────────────────────────────
function cmdDiff(a, b, includeIcons) {
  const fa = listDataFiles(a, includeIcons)
  const fb = listDataFiles(b, includeIcons)
  const names = Array.from(new Set(fa.concat(fb)))
  let ok = 0, bad = 0
  console.log('═'.repeat(60))
  console.log('字节级比对: A=' + a + '\n            B=' + b)
  for (const name of names) {
    const pa = path.resolve(a, name)
    const pb = path.resolve(b, name)
    if ((pa === a || pa.startsWith(a + path.sep)) && (pb === b || pb.startsWith(b + path.sep))) {
      const ea = fs.existsSync(pa), eb = fs.existsSync(pb)
      if (!ea || !eb) {
        console.log('  ❌ ' + name + ' — 仅' + (ea ? 'A' : 'B') + '存在')
        bad++
        continue
      }
      const ba = fs.readFileSync(pa), bb = fs.readFileSync(pb)
      if (ba.equals(bb)) {
        if (process.argv.indexOf('--quiet') >= 0) continue
        console.log('  ✅ ' + name + ' (' + ba.length + 'B)')
        ok++
      } else {
        console.log('  ❌ ' + name + ' — 内容不同 (A=' + ba.length + 'B, B=' + bb.length + 'B)')
        bad++
      }
    } else { bad++ }
  }
  console.log('─'.repeat(60))
  console.log((bad === 0 ? '✅ 完全一致' : '❌ ' + bad + ' 个文件不一致') + '（' + ok + ' 个文件相同）')
  process.exitCode = bad === 0 ? 0 : 1
}

// ── check：结构校验 + 深度重建比对 ───────────────────────────────
function cmdCheck(dir, specName) {
  const problems = []
  const warns = []
  const P = msg => problems.push(msg)
  const W = msg => warns.push(msg)

  const metaTxt = fs.readFileSync(path.join(dir, 'meta.txt'), 'utf-8')
  let meta
  try { meta = JSON.parse(metaTxt) } catch (e) { P('meta.txt 解析失败: ' + e.message); return report() }

  function readChunks(prefix) {
    const lines = []
    for (let i = 0; fs.existsSync(path.join(dir, prefix + '_' + i + '.txt')); i++) {
      lines.push(...fs.readFileSync(path.join(dir, prefix + '_' + i + '.txt'), 'utf-8').split('\n').filter(l => l.trim()))
    }
    return lines
  }
  const mapLines = readChunks('map')
  const detailLines = readChunks('detail')
  const n = meta.totalCount

  // ① 行数一致
  if (mapLines.length !== n) P('map 行数 ' + mapLines.length + ' ≠ meta.totalCount ' + n)
  if (detailLines.length !== n) P('detail 行数 ' + detailLines.length + ' ≠ meta.totalCount ' + n)

  // ② id 连续递增
  const mapIds = mapLines.map(l => parseInt(l.split('|')[0], 10))
  const detailIds = detailLines.map(l => parseInt(l.split('|')[0], 10))
  for (let i = 0; i < mapIds.length; i++) if (mapIds[i] !== i) { P('map 第 ' + i + ' 行 id=' + mapIds[i] + ' ≠ ' + i + '（引擎二分要求 0..N-1 连续）'); break }
  for (let i = 0; i < detailIds.length; i++) if (detailIds[i] !== i) { P('detail 第 ' + i + ' 行 id=' + detailIds[i] + ' ≠ ' + i); break }

  // ③ 分片参数与 maps 覆盖
  const mapChunk = meta.mapChunkSize || 100
  let acc = 0
  for (let i = 0; i < meta.maps.length; i++) {
    const m = meta.maps[i]
    if (m.startId !== acc) P('meta.maps[' + i + '].startId=' + m.startId + ' ≠ 期望 ' + acc + '（覆盖断档）')
    acc = (m.endId === undefined ? (m.startId + (m.recordCount || 0)) : m.endId + 1)
  }
  if (acc !== n) P('meta.maps 覆盖到 ' + acc + ' ≠ totalCount ' + n)
  for (let i = 0; i < meta.maps.length - 1; i++) {
    // 每片行数 ≤ mapChunk（最后一片可少）
    const size = meta.maps[i].endId - meta.maps[i].startId + 1
    if (size !== mapChunk) P('meta.maps[' + i + '] 行数 ' + size + ' ≠ mapChunkSize ' + mapChunk + '（除末片外应满片）')
  }

  // ④ regionIdx 越界
  const rl = meta.regionList || []
  let badRegion = 0
  for (const l of mapLines) {
    const idx = parseInt(l.split('|')[2], 10)
    if (!(idx >= 0 && idx < rl.length)) badRegion++
  }
  if (badRegion) P(badRegion + ' 条 map 行 regionIdx 越界（regionList 共 ' + rl.length + ' 项）')

  // ⑤ block 越界检测（过期铁证）
  const blockLines = readChunks('block')
  let maxId = -1, idRefs = 0, badBucket = 0
  for (const l of blockLines) {
    const parts = l.split('|')
    const b = parseInt(parts[0], 10)
    if (b >= (meta.bucketSize || 2048)) badBucket++
    const ids = parts[1].split(',').map(Number)
    idRefs += ids.length
    for (const id of ids) if (id > maxId) maxId = id
  }
  if (badBucket) P(badBucket + ' 个桶号 ≥ bucketSize')
  if (blockLines.length && maxId >= n) P('block 最大 id ' + maxId + ' ≥ totalCount ' + n + ' → block 必然过期（id 曾被重编号而 block 未重建）')
  if (blockLines.length === 0) P('block 文件缺失')

  // ⑥ detail 列数 vs meta.json 声明
  const metaJsonPath = path.join(dir, 'meta.json')
  if (fs.existsSync(metaJsonPath)) {
    try {
      const mj = JSON.parse(fs.readFileSync(metaJsonPath, 'utf-8'))
      const declared = (mj.fields && mj.fields.detail || []).length
      const cols0 = detailLines[0] ? detailLines[0].split('|').length : 0
      if (declared && cols0 !== declared + 2) W('detail 首行 ' + cols0 + ' 列 ≠ fields.detail(' + declared + ')+2（若个别行含全角/竖线转义遗漏会断列）')
      if (mj.totalCount !== n) W('meta.json.totalCount=' + mj.totalCount + ' 与 meta.txt=' + n + ' 不一致（历史集声明文件为手工维护，已知项）')
    } catch (e) { W('meta.json 解析失败: ' + e.message) }
  }

  // ⑦ year_index 交叉验证
  const yearIdxPath = path.join(dir, 'year_index.txt')
  if (fs.existsSync(yearIdxPath)) {
    const yearOf = {}
    for (const l of mapLines) {
      const c = l.split('|')
      yearOf[c[0]] = c[1]
    }
    let match = 0, mismatch = 0, oob = 0
    for (const l of fs.readFileSync(yearIdxPath, 'utf-8').split('\n').filter(x => x.trim())) {
      const parts = l.split('|')
      if (parts.length < 2) continue
      const year = parts[0]
      for (const idStr of parts[1].split(',')) {
        const y = yearOf[idStr]
        if (y === undefined) { oob++; continue }
        if (y === year) match++; else mismatch++
      }
    }
    if (match + mismatch + oob > 0) {
      if (mismatch || oob) P('year_index.txt 过期: 匹配 ' + match + ' / 错位 ' + mismatch + ' / 越界 ' + oob
        + ' → 年份搜索会命中错位记录，需按当前 id 重编')
      else console.log('  ✅ year_index 与 map 年份全量吻合（' + match + ' 个引用）')
    }
  }

  // ⑧ 深度校验：按 spec 重建并逐字节比对
  if (specName) {
    const specPath = /[\\/]/.test(specName) || specName.endsWith('.json')
      ? path.resolve(specName) : path.join(__dirname, 'specs', specName + '.json')
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'))
    console.log('  深度校验: 按 ' + specPath + ' 内存重建…')
    let artifacts
    if (spec.mode === 'existing') {
      const existsFn = fp => fs.existsSync(fp)
      const existing = core.readExisting(dir, fp => fs.readFileSync(fp, 'utf-8'), existsFn)
      const sampled = core.sampleRecords(existing.records, spec.sample)
      artifacts = core.buildArtifacts(spec, sampled, [], meta)
    } else {
      const files = (spec.sources || []).map(s => ({
        path: path.isAbsolute(s.path) ? s.path : path.join(ROOT, spec.sourcesBase || '', s.path),
        level: s.level
      }))
      const parsed = core.parseSources(spec, files, fp => fs.readFileSync(fp, 'utf-8'))
      const sampled = core.sampleRecords(parsed.records, spec.sample)
      artifacts = core.buildArtifacts(spec, sampled, parsed.regionValues, null)
    }
    const expect = [
      ['meta.txt', artifacts.metaTxt],
      ['block_0.txt', artifacts.blockBody],
      ...artifacts.mapBodies.map((b, i) => ['map_' + i + '.txt', b]),
      ...artifacts.detailBodies.map((b, i) => ['detail_' + i + '.txt', b])
    ]
    if (artifacts.metaJsonTxt && fs.existsSync(metaJsonPath)) expect.push(['meta.json', artifacts.metaJsonTxt])
    let deepBad = 0
    for (const [name, body] of expect) {
      const fp = path.join(dir, name)
      if (!fs.existsSync(fp)) { console.log('  ❌ 重建产物 ' + name + ' 盘上不存在'); deepBad++; continue }
      const disk = fs.readFileSync(fp)
      const rebuilt = Buffer.from(body, 'utf-8')
      if (!disk.equals(rebuilt)) {
        deepBad++
        // 定位首个差异字节，方便人工排查
        let d = 0
        const len = Math.min(disk.length, rebuilt.length)
        while (d < len && disk[d] === rebuilt[d]) d++
        console.log('  ❌ ' + name + ' 与重建结果不同（首个差异 @' + d + 'B, 盘上 ' + disk.length + 'B / 重建 ' + rebuilt.length + 'B）')
      }
    }
    if (deepBad === 0) console.log('  ✅ 深度校验通过: 盘上数据 ≡ spec 重建结果（' + expect.length + ' 个文件逐字节一致）')
    else P('深度校验 ' + deepBad + ' 个文件与 spec 重建结果不一致')
  }

  function report() {
    console.log('═'.repeat(60))
    console.log('校验: ' + dir)
    console.log('  条数=' + n + '  map片=' + meta.maps.length + '  bucketSize=' + meta.bucketSize
      + '  regionList=' + rl.length + '  桶=' + blockLines.length + '  id引用=' + idRefs)
    if (warns.length) { console.log('⚠️ 警告 ' + warns.length + ' 项:'); warns.forEach(w => console.log('  ⚠️ ' + w)) }
    if (problems.length) { console.log('❌ 问题 ' + problems.length + ' 项:'); problems.forEach(p => console.log('  ❌ ' + p)); process.exitCode = 1 }
    else console.log('✅ 结构校验通过')
  }
  report()
}

// ── 入口 ─────────────────────────────────────────────────────────
const cmd = process.argv[2]
if (cmd === 'diff') {
  const rawA = process.argv[3], rawB = process.argv[4]
  const a = rawA ? path.resolve(ROOT, rawA) : null
  const b = rawB ? path.resolve(ROOT, rawB) : null
  if (!a || !b || !fs.existsSync(a) || !fs.existsSync(b)) { console.error('用法: node tools/verify_dataset.js diff <目录A> <目录B> [--icons]'); process.exit(1) }
  if (a !== ROOT && !a.startsWith(ROOT + path.sep)) { console.error('❌ 路径必须在工程目录内: ' + a); process.exit(1) }
  if (b !== ROOT && !b.startsWith(ROOT + path.sep)) { console.error('❌ 路径必须在工程目录内: ' + b); process.exit(1) }
  cmdDiff(a, b, process.argv.indexOf('--icons') >= 0)
} else if (cmd === 'check') {
  const rawDir = process.argv[3]
  const dir = rawDir ? path.resolve(ROOT, rawDir) : null
  if (!dir || !fs.existsSync(dir)) { console.error('用法: node tools/verify_dataset.js check <目录> [spec]'); process.exit(1) }
  if (dir !== ROOT && !dir.startsWith(ROOT + path.sep)) { console.error('❌ 路径必须在工程目录内: ' + dir); process.exit(1) }
  const specName = process.argv[4] && process.argv[4].indexOf('--') !== 0 ? process.argv[4] : null
  cmdCheck(dir, specName)
} else {
  console.error('用法:\n  node tools/verify_dataset.js diff <目录A> <目录B> [--icons]\n  node tools/verify_dataset.js check <目录> [spec]')
  process.exit(1)
}
