// 跨集详情读取：gid → 集 → detail 分片按 meta.fields 列序拆字段
// （detail.ux 的历史集读取逻辑硬编码 /common 路径与 v4 列序，无法吃资料集格式——此处统一适配）
// ⚠️ 必须显式 import：各 JS 模块作用域独立，DATASETS/decodeGlobalId/ensureEngine 不会凭空可见
import { DATASETS, ensureEngine, decodeGlobalId } from './DatasetManager.js'

var FIELD_NAME_MAP = { source: '出处', content: '正文', translation: '译文', keywords: '关键词', author: '作者',
  // 历史集（v1.16.61 统一引擎路径后，历史集字段经此映射显示中文名）
  cause: '原因/背景', impact: '影响/做法' }

function _readText(uri) {
  // file 用函数内 require（与引擎一致——顶层静态 import 原生模块在快应用互操作下不可靠）
  var file = require('@system.file')
  return new Promise(function(resolve) {
    file.readText({
      uri: uri,
      success: function(res) { resolve(res.text || '') },
      fail: function() { resolve('') }
    })
  })
}

// fields 声明在 meta.json；meta.txt 是引擎吃的 v4 兼容壳（无 fields 键）
// 兼容两种声明：字符串数组 ["source","content"] / 对象数组 [{name, position}]
async function _loadMeta(eng) {
  var raw = await _readText(eng.basePath + 'meta.json')
  var metaObj = {}
  try { metaObj = JSON.parse(raw) } catch (e) { metaObj = {} }
  if (!metaObj.fields) {
    // 历史集特例（v1.16.63；v1.16.122 后数据已归入 datasets/history/，声明文件同目录）：
    // meta.txt 无 fields 时读 meta.json 拿字段名
    if (eng.basePath === '/common/datasets/history/') {
      raw = await _readText('/common/datasets/history/meta.json')
      try { metaObj = JSON.parse(raw) } catch (e1) { metaObj = {} }
    }
  }
  if (!metaObj.fields) {
    raw = await _readText(eng.basePath + 'meta.txt')
    try { metaObj = JSON.parse(raw) } catch (e2) { metaObj = {} }
  }
  // 历史集最终兜底：物化列序就是 cause/impact（v1.16.63）
  var isHistory = (eng.basePath === '/common/datasets/history/')
  if (!metaObj.fields && isHistory) {
    metaObj.fields = { detail: ['cause', 'impact'] }
  }
  var names = []
  var fd = (metaObj.fields && metaObj.fields.detail) || []
  for (var i = 0; i < fd.length; i++) {
    var f = fd[i]
    var idx = (f && f.position !== undefined) ? (f.position - 2) : i
    names[idx] = (typeof f === 'string') ? f : f.name
  }
  return {
    detailChunkSize: metaObj.detailChunkSize || (eng.detailChunkSize || 100),
    detFieldNames: names.length ? names : ['详情']
  }
}

// detail 内存缓存（v1.16.61 主人指定）：看完一页清一次、最多留一个——
// 同一详情页的重复访问（重渲染/收藏切换）免重读文件；加载新详情时替换旧页；
// 退出详情页（detail.ux onDestroy）调 clearDetailCache 主动清空。
var _detailCache = null   // { key: gid 字符串, data: 详情对象 }

function clearDetailCache() {
  _detailCache = null
}

async function getDetailByGlobalId(gid) {
  var cacheKey = String(gid)
  if (_detailCache && _detailCache.key === cacheKey) {
    return _detailCache.data
  }
  var d = decodeGlobalId(gid)
  var ds = null
  for (var i = 0; i < DATASETS.length; i++) {
    if (DATASETS[i].id === d.dsId) { ds = DATASETS[i]; break }
  }
  if (!ds) return null
  var eng = ensureEngine(ds)
  var mapDoc = await eng.getDoc(d.localId)

  var meta = await _loadMeta(eng)

  // 读 detail 分片找 localId 行
  var chunkId = Math.floor(d.localId / meta.detailChunkSize)
  var raw = await _readText(eng.basePath + 'detail_' + chunkId + '.txt')

  var rows = raw.split('\n')
  var line = null
  for (var ri = 0; ri < rows.length; ri++) {
    var cols = rows[ri].split('|')
    if (parseInt(cols[0], 10) === d.localId) { line = cols; break }
  }

  var details = []
  if (line) {
    // detail 行：localId|关键词|字段值1|字段值2...（列 2 起按 fields.detail 顺序）
    for (var ci = 2; ci < line.length; ci++) {
      // v1.16.63 最底层兜底：meta 读取失败时也保证字段名正确（历史集列序固定 cause/impact）
      var rawName = meta.detFieldNames[ci - 2] ||
        (ds.id === 0 ? (ci === 2 ? 'cause' : 'impact') : ('详情' + (ci - 1)))
      var name = FIELD_NAME_MAP[rawName] || rawName
      // 物化时真实换行编码为字面 \n 两字符（| 是列分隔符，裸换行会断行），这里还原
      var value = (line[ci] || '').replace(/\\n/g, '\n')
      if (value) details.push({ name: name, value: value })
    }
  }

  var result = {
    isDataset: true,
    dsName: ds.name,
    // v1.16.63 兜底：mapDoc 缺失时用 detail 行关键词首段当标题（保证简略卡始终渲染，
    // 避免详情卡上移造成『简略/详情位置反了』的视觉）
    title: (mapDoc && mapDoc.title) || (line && line[1] ? String(line[1]).split(/[,，]/)[0] : '') || '',
    // 资料集无年份语义（物化 year=0 → 引擎返回「公元元年」）：年份位显示集标签
    yearDisplay: ds.id !== 0 ? ds.tag : ((mapDoc && mapDoc.yearDisplay) || ds.tag || '历史'),
    region: (mapDoc && mapDoc.region) || ds.tag,
    keywords: line && line[1] ? line[1].split(',').filter(function(k) { return k }) : [],
    details: details
  }
  // 写入缓存（替换旧页 = 只留一个，v1.16.61 主人指定）
  _detailCache = { key: cacheKey, data: result }
  return result
}


export { getDetailByGlobalId, clearDetailCache }
