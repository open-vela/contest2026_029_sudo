// dataset_core.js —— 资料集拆分核心库（唯一权威实现）
// ─────────────────────────────────────────────────────────────
// 本文件是「源数据 → 手环资料集（map_*/detail_*/block_*/meta.*）」全部规则的
// 单一权威实现，供 tools/split_dataset.js（通用拆分 CLI）与
// tools/verify_dataset.js（字节级校验器）共用。
//
// 规则来源（逐字节对齐，勿改语义）：
//   - 入桶分词/哈希：src/SearchEngine/SearchEngine.js 的 hashCode + _parseQuery
//   - 行格式/分片/meta：tools/build_datasets_batch.js（健康/生活/学习）、
//     tools/build_poems_dataset.js（诗词）、tools/rebuild_english_cet.js（英语）、
//     tools/slim_history.js（历史 existing 模式）
//
// 字节级硬约束（引擎/现有数据已固化的格式，改一处即全量数据漂移）：
//   1. 所有 .txt 行以 \n 分隔，文件末尾【不带】换行，无 \r
//   2. meta.txt = JSON.stringify(obj)（紧凑）；meta.json = JSON.stringify(obj, null, 2)
//   3. 桶行升序 = 数值升序（a-b），桶内 id 按记录顺序推送、不去重（哈希撞桶时同 id 可重复）
//   4. detail 字段值中的真实换行物化为字面 \n 两字符；竖线物化为全角 ｜
//   5. localId 从 0 连续递增，map/detail 行首 ID 与行序绑定
'use strict'

var path = require('path')

// 路径护栏（CLI 工具的 IO sink 共用）：以 base 为界，拒绝 ../ 越出
function rooted(base, name) {
  var b = path.resolve(base)
  var t = path.resolve(b, name)
  if (t !== b && !t.startsWith(b + path.sep)) throw new Error('路径越界（拒绝访问 base 之外）: ' + t)
  return t
}
// 拒绝路径串中的 ./.. 段（纯字符串护栏，用于回调式 readFile 前的校验）
function assertNoDotSegs(p) {
  var segs = String(p).split(/[\\/]+/)
  if (segs.indexOf('..') >= 0 || segs.indexOf('.') >= 0) throw new Error('路径不允许包含 . 或 .. 段: ' + p)
}

// ── 哈希与分词（与引擎 _parseQuery 逐字对齐） ─────────────────────

function hashCode(str) {
  var hash = 5381
  for (var i = 0; i < str.length; i++) hash = (hash * 33) ^ str.charCodeAt(i)
  return hash >>> 0
}

// 引擎查询侧按「纯字母词前缀 + 其余逐字符」哈希求交，入桶侧必须同规则，
// 否则 token 对不上 → 交集恒空 = 该条目永远搜不到
function tokenize(text) {
  var tokens = []
  var words = String(text).split(/[\s,，、]+/)
  for (var i = 0; i < words.length; i++) {
    var w = words[i]
    if (!w) continue
    if (/^[a-zA-Z]+$/.test(w)) {
      if (w.length >= 3) {
        for (var j = 3; j <= w.length; j++) tokens.push(w.substring(0, j).toLowerCase())
      } else {
        tokens.push(w.toLowerCase())
      }
    } else {
      for (var k = 0; k < w.length; k++) {
        var ch = w[k]
        if (ch && ch.trim()) tokens.push(ch)
      }
    }
  }
  // 每条记录内去重（与各构建脚本 [...new Set(tokens)] 一致）
  return Array.from(new Set(tokens))
}

// ── 通用清洗 ────────────────────────────────────────────────────

// 竖线是列分隔符，字段值里必须物化为全角
function sanitizePipe(s) {
  return String(s).replace(/\|/g, '｜')
}

// 真实换行会断行，物化为字面 \n 两字符（DatasetDetail.js 读取侧对应还原）
function sanitizeNewline(s) {
  return String(s).replace(/\r?\n/g, '\\n')
}

// 模板插值："{title}·{author}" + {title:'静夜思',author:'李白'} → "静夜思·李白"
function renderTemplate(tpl, cols) {
  return String(tpl).replace(/\{(\w+)\}/g, function(m, name) {
    return (cols[name] !== undefined && cols[name] !== null) ? String(cols[name]) : ''
  })
}

// ── 源数据解析（三种 preset + existing） ────────────────────────
// spec.parser:
//   pipe5 : 标准五列竖线行（健康/生活/学习）  title|keywords|cause|impact|category
//   poems : 六列竖线行（诗词）                ID|标题|作者|朝代|出处|内容
//   tsv   : 制表符词条（英语）                单词<TAB>释义
//   existing: 无源文件，从既有 map_*/detail_* 读回（历史）
//
// 返回 { records, regionValues, dropped }
//   records: [{ cols:{...}, localId }]（解析序，未采样）
//   regionValues: 分类值收集（采样【前】的全量集合——与旧脚本一致，
//                 regionList 会包含未入选记录的分类）
//   dropped: 各类丢弃计数（供人工核对）

function parseSources(spec, files, readFile) {
  var p = spec.parser || {}
  var type = p.type
  var records = []
  var regionValues = []
  var seenRegion = {}
  var dropped = { shortLine: 0, emptyTitle: 0, emptyWord: 0, blankLine: 0, dedupe: 0 }
  var seenWord = {}

  function pushRegion(cat) {
    if (Array.isArray(spec.regionList)) return // 显式声明序（英语集）不需要收集
    if (cat && !seenRegion[cat]) { seenRegion[cat] = true; regionValues.push(cat) }
  }

  for (var fi = 0; fi < files.length; fi++) {
    var fileLabel = files[fi].label || files[fi].path
    var srcPath = files[fi].path
    assertNoDotSegs(srcPath)
    var raw = readFile(srcPath)
    if (type === 'tsv') {
      // rebuild_english_cet 语义：行不 trim，split(\t)，p.length<2 或空词丢弃
      var lines = raw.split('\n')
      for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].split('\t')
        if (parts.length < 2 || !parts[0].trim()) { dropped.emptyWord++; continue }
        var word = parts[0].trim().toLowerCase()
        var level = files[fi].level
        if (spec.dedupe && seenWord[word]) { dropped.dedupe++; continue }
        if (spec.dedupe) seenWord[word] = true
        pushRegion(level)
        records.push({
          cols: { title: word, keywords: word + ',' + level, meaning: sanitizePipe(parts[1].trim()), level: level },
          source: fileLabel
        })
      }
    } else if (type === 'poems') {
      // build_poems_dataset 语义：行过滤(trim 后非空保留原行)，split(|) 后逐列 trim
      var lines2 = raw.replace(/^\uFEFF/, '').split('\n').filter(function(l) { return l.trim() })
      for (var i2 = 0; i2 < lines2.length; i2++) {
        var pp = lines2[i2].split('|')
        if (pp.length < 6) { dropped.shortLine++; continue }
        var title = pp[1].trim().replace(/\|/g, '｜')
        if (!title) { dropped.emptyTitle++; continue }
        var dynasty = (pp[3].trim() || '未知')
        pushRegion(dynasty)
        records.push({
          cols: {
            title: title,
            author: pp[2].trim().replace(/\|/g, '｜'),
            dynasty: dynasty,
            source: pp[4].trim().replace(/\|/g, '｜'),
            content: sanitizeNewline(pp[5].trim().replace(/\|/g, '｜'))
          },
          source: fileLabel
        })
      }
    } else { // pipe5（默认）
      // build_datasets_batch 语义：行 trim 后非空保留，split(|) 逐列 trim，≥5 列且首列非空
      var lines3 = raw.replace(/^\uFEFF/, '').split('\n').map(function(l) { return l.trim() }).filter(function(l) { return l })
      for (var i3 = 0; i3 < lines3.length; i3++) {
        var c = lines3[i3].split('|').map(function(x) { return x.trim() })
        if (c.length < 5 || !c[0]) { dropped.shortLine++; continue }
        var cat = c[4] || (p.categoryDefault || spec.name)
        pushRegion(cat)
        records.push({
          cols: {
            title: c[0].replace(/\|/g, '｜'),
            keywords: c[1].replace(/\|/g, '｜'),
            cause: c[2].replace(/\|/g, '｜'),
            impact: c[3].replace(/\|/g, '｜'),
            category: cat
          },
          source: fileLabel
        })
      }
    }
  }
  return { records: records, regionValues: regionValues, dropped: dropped }
}

// 从既有 map_*/detail_* 读回记录（历史集 existing 模式；slim_history/fix_quality 同源逻辑）
// 返回的 cols：title/year/regionIdx（map 列）+ keywords/detailFields（detail 列）
function readExisting(dir, readFile, existsFn) {
  function readChunks(prefix) {
    var out = []
    for (var i = 0; existsFn(rooted(dir, prefix + '_' + i + '.txt')); i++) {
      out.push.apply(out, readFile(rooted(dir, prefix + '_' + i + '.txt')).split('\n').filter(function(l) { return l.trim() }))
    }
    return out
  }
  var mapLines = readChunks('map')
  var detailLines = readChunks('detail')
  var mapById = {}
  var detailById = {}
  mapLines.forEach(function(l) {
    var c = l.split('|')
    var id = parseInt(c[0], 10)
    if (!isNaN(id)) mapById[id] = c
  })
  detailLines.forEach(function(l) {
    var c = l.split('|')
    var id = parseInt(c[0], 10)
    if (!isNaN(id) && !detailById[id]) detailById[id] = c
  })
  var ids = Object.keys(detailById).map(Number).filter(function(id) { return mapById[id] })
  ids.sort(function(a, b) { return a - b })
  var records = ids.map(function(id) {
    var m = mapById[id]
    return {
      cols: {
        title: m[3] || '',
        year: m[1] || '0',
        regionIdx: m[2] || '0',
        keywords: (detailById[id][1] || ''),
        detailFields: detailById[id].slice(2)
      }
    }
  })
  return { records: records, mapCount: mapLines.length, detailCount: detailLines.length }
}

// ── 采样（与旧脚本逐字对齐） ─────────────────────────────────────
// spec.sample:
//   { mode: 'content-length', target: N, lengthOf: ['title','keywords','cause','impact'] }
//     → 按指定列长度和降序取前 N（稳定排序，同长保序）——「长的/信息完整的优先」
//   { mode: 'head', target: N }
//     → 保序取前 N（CET 高频词在前）
//   省略 → 全保留
// 采样后统一重编号 localId = 0..N-1（map/detail 行首 ID 与行序绑定）

function sampleRecords(records, sample) {
  var out = records
  if (sample && sample.target && records.length > sample.target) {
    if (sample.mode === 'content-length') {
      var fields = sample.lengthOf || ['title', 'keywords', 'cause', 'impact']
      var lenOf = function(r) {
        var n = 0
        for (var i = 0; i < fields.length; i++) n += String(r.cols[fields[i]] || '').length
        return n
      }
      out = records.slice().sort(function(a, b) { return lenOf(b) - lenOf(a) })
    }
    out = out.slice(0, sample.target)
  }
  for (var i = 0; i < out.length; i++) out[i].localId = i
  return out
}

// ── 产物构建（map/detail/block/meta） ───────────────────────────
// spec 关键字段：
//   mapLine:    模板，可用 {localId} {year} {regionIdx} {title} 及任意列名
//   detailLine: keywords 模板 + detailFields 列名数组
//   bucketText: 入桶文本模板（决定搜得到什么）
//   regionList: 'sorted-set'（解析期收集并 .sort()）| 显式数组（声明序）| 'inherit'（existing）
//   mapsEntry:  'simple' {startId,endId} | 'v4' {id,startId,endId,recordCount}

function buildArtifacts(spec, records, regionValues, existingMeta) {
  var mapChunk = spec.mapChunkSize
  var detailChunk = spec.detailChunkSize
  var bucketSize = spec.bucketSize

  // regionList
  var regionList
  if (Array.isArray(spec.regionList)) {
    regionList = spec.regionList.slice()
  } else if (spec.regionList === 'inherit' && existingMeta) {
    regionList = existingMeta.regionList || []
  } else {
    regionList = regionValues.slice().sort()
  }
  var regionIndex = {}
  regionList.forEach(function(c, i) { regionIndex[c] = i })

  // map 行
  var regionField = spec.regionField || 'category'
  var mapLines = records.map(function(r) {
    var cols = r.cols
    var regionIdx = (cols.regionIdx !== undefined) ? cols.regionIdx
      : (regionIndex[cols[regionField]] !== undefined ? regionIndex[cols[regionField]] : 0)
    var lineCols = {}
    for (var k in cols) if (Object.prototype.hasOwnProperty.call(cols, k)) lineCols[k] = cols[k]
    lineCols.localId = r.localId
    lineCols.year = (cols.year !== undefined) ? cols.year : (spec.year !== undefined ? spec.year : 0)
    lineCols.regionIdx = regionIdx
    return renderTemplate(spec.mapLine, lineCols)
  })

  // detail 行：localId|keywords|f1|f2...
  var detailLines = records.map(function(r) {
    var cols = r.cols
    var kw = renderTemplate(spec.detailKeywords, cols)
    var fields = (spec.mode === 'existing')
      ? (cols.detailFields || [])
      : (spec.detailFields || []).map(function(name) { return sanitizeNewline(cols[name] || '') })
    return [String(r.localId), kw].concat(fields).join('|')
  })

  // block 桶：kwText 逐 token 哈希入桶（桶内不去重——与旧脚本一致）
  var buckets = {}
  records.forEach(function(r) {
    var kwText = renderTemplate(spec.bucketText, r.cols)
    var toks = tokenize(kwText)
    for (var i = 0; i < toks.length; i++) {
      var b = hashCode(toks[i]) % bucketSize
      ;(buckets[b] = buckets[b] || []).push(r.localId)
    }
  })
  var blockBody = Object.keys(buckets).map(Number).sort(function(a, b) { return a - b })
    .map(function(b) { return b + '|' + buckets[b].join(',') }).join('\n')

  // 分片
  var mapBodies = [], detailBodies = []
  for (var c = 0; c * mapChunk < mapLines.length; c++) {
    mapBodies.push(mapLines.slice(c * mapChunk, (c + 1) * mapChunk).join('\n'))
  }
  for (var c2 = 0; c2 * detailChunk < detailLines.length; c2++) {
    detailBodies.push(detailLines.slice(c2 * detailChunk, (c2 + 1) * detailChunk).join('\n'))
  }

  var n = records.length
  // year_index（spec.yearIndex=true 时重建）：year|id,id,...，年份与 id 均数值升序
  // ⚠️ id 重编号而 year_index 不重建 = 年份搜索命中错位记录（存量事故），故 existing 模式默认重建
  var yearIndexBody = null
  if (spec.yearIndex) {
    var byYear = {}
    records.forEach(function(r) {
      var y = parseInt(r.cols.year, 10)
      if (isNaN(y)) return
      ;(byYear[y] = byYear[y] || []).push(r.localId)
    })
    yearIndexBody = Object.keys(byYear).map(Number).sort(function(a, b) { return a - b })
      .map(function(y) { return y + '|' + byYear[y].sort(function(a, b) { return a - b }).join(',') }).join('\n')
  }

  // meta.txt（引擎物化视图）—— 键序即字节序，勿调整
  var meta
  if (spec.mode === 'existing' && existingMeta) {
    // existing：继承原 meta 键序，只覆写容量相关字段（slim_history 语义）
    meta = JSON.parse(JSON.stringify(existingMeta))
    meta.totalCount = n
    meta.bucketSize = bucketSize
    meta.chunks = [{ id: 0, bucketStart: 0, bucketEnd: bucketSize - 1, recordCount: n }]
    meta.mapChunkSize = mapChunk
    meta.detailChunkSize = detailChunk
    delete meta.blockBinary
    var maps = []
    for (var m = 0; m < mapBodies.length; m++) {
      maps.push({ id: m, startId: m * mapChunk, endId: Math.min((m + 1) * mapChunk, n) - 1,
        recordCount: Math.min((m + 1) * mapChunk, n) - m * mapChunk })
    }
    meta.maps = maps
  } else {
    var mapsSimple = mapBodies.map(function(_, i) {
      return { startId: i * mapChunk, endId: Math.min((i + 1) * mapChunk, n) - 1 }
    })
    meta = {
      totalCount: n,
      regionList: regionList,
      categoryList: spec.categoryList || [],
      bucketSize: bucketSize,
      chunks: [{ id: 0, bucketStart: 0, bucketEnd: bucketSize - 1, recordCount: n }],
      maps: mapsSimple,
      mapChunkSize: mapChunk,
      detailChunkSize: detailChunk,
      version: spec.metaVersion
    }
  }

  // meta.json（规范 v1 自描述）—— totalCount 由工具回填，其余按 spec 声明
  var metaJson = null
  if (spec.metaJson) {
    metaJson = JSON.parse(JSON.stringify(spec.metaJson))
    metaJson.totalCount = n
  }

  return {
    mapBodies: mapBodies,
    detailBodies: detailBodies,
    blockBody: blockBody,
    yearIndexBody: yearIndexBody,
    metaTxt: JSON.stringify(meta),
    metaJsonTxt: metaJson ? JSON.stringify(metaJson, null, 2) : null,
    regionList: regionList,
    metaObj: meta,
    stats: { records: n, mapFiles: mapBodies.length, detailFiles: detailBodies.length, buckets: Object.keys(buckets).length }
  }
}

// ── 写盘（清理旧分片 → 写新，防残留分片带旧 id 被引擎读到） ────────

function writeDataset(dir, artifacts, io) {
  io.mkdir(rooted(dir, '.'))
  var olds = io.listFiles(rooted(dir, '.'))
  for (var i = 0; i < olds.length; i++) {
    if (/^(map|detail)_\d+\.txt$/.test(olds[i])) io.unlink(rooted(dir, olds[i]))
  }
  artifacts.mapBodies.forEach(function(body, i) { io.write(rooted(dir, 'map_' + i + '.txt'), body) })
  artifacts.detailBodies.forEach(function(body, i) { io.write(rooted(dir, 'detail_' + i + '.txt'), body) })
  io.write(rooted(dir, 'block_0.txt'), artifacts.blockBody)
  if (artifacts.yearIndexBody) io.write(rooted(dir, 'year_index.txt'), artifacts.yearIndexBody)
  io.write(rooted(dir, 'meta.txt'), artifacts.metaTxt)
  if (artifacts.metaJsonTxt) io.write(rooted(dir, 'meta.json'), artifacts.metaJsonTxt)
}

module.exports = {
  hashCode: hashCode,
  tokenize: tokenize,
  sanitizePipe: sanitizePipe,
  sanitizeNewline: sanitizeNewline,
  renderTemplate: renderTemplate,
  parseSources: parseSources,
  readExisting: readExisting,
  sampleRecords: sampleRecords,
  buildArtifacts: buildArtifacts,
  writeDataset: writeDataset
}
