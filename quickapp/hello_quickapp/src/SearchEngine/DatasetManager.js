// DatasetManager —— 资料集注册表 + 多实例引擎池 + 跨集搜索聚合
// 架构见 docs/2026-09-05-资料集模块化规范v1.md
// 每个资料集一个 SearchEngine 实例（零改动复用已验证的单集逻辑），
// 全局 ID = (datasetId << 20) | localId
import { SearchEngine, CACHE_VERSION } from './SearchEngine.js'

// 资料集注册清单（内置集；蓝牙动态集由手机端下发清单后追加到 DYNAMIC_DATASETS）
console.log('[DM] module evaluating')
// 6 标签 = 6 数据集（主人定的精简架构：集数=标签数，搜索只需遍历 6 个集，
// 不再是原先 24 集跨集聚合——那套导致搜索慢、缓存大、清缓存耗时、命中率低）
var DATASETS = [
  { id: 0, folder: 'datasets/history/', name: '历史', tag: '历史', count: 850, icon: '/common/datasets/history/icon.png',
    desc: '世界历史大事记，覆盖六大洲从史前到现代的关键事件',
    tags: [ { label: '亚洲', value: 'asia' }, { label: '欧洲', value: 'europe' },
            { label: '非洲', value: 'africa' }, { label: '其他', value: 'other' },
            { label: '南美洲', value: 'south_america' }, { label: '北美洲', value: 'north_america' } ] },
  { id: 1, folder: 'datasets/poems/', name: '诗词', tag: '诗词', count: 550, icon: '/common/datasets/poems/icon.png',
    desc: '中国古诗词名篇，含朝代、作者与全文',
    tags: [ { label: '诗', value: '诗' }, { label: '词', value: '词' }, { label: '先秦', value: '先秦' },
            { label: '魏晋', value: '魏晋' }, { label: '唐朝', value: '唐朝' }, { label: '五代', value: '五代' },
            { label: '宋朝', value: '宋朝' }, { label: '元朝', value: '元朝' }, { label: '清朝', value: '清朝' } ] },
  { id: 2, folder: 'datasets/english/', name: '英语', tag: '英语', count: 750, icon: '/common/datasets/english/icon.png',
    desc: 'CET-4/6 核心词汇，含词性与中文释义',
    tags: [ { label: '四级', value: '四级' }, { label: '六级', value: '六级' } ] },
  { id: 3, folder: 'datasets/health/', name: '健康', tag: '健康', count: 1000, icon: '/common/datasets/health/icon.png',
    desc: '健康养生、心理情绪、急救、护肤美妆与运动知识',
    tags: [ { label: '健康', value: '健康' }, { label: '心理情绪', value: '心理情绪' },
            { label: '急救', value: '急救' }, { label: '护肤美妆', value: '护肤美妆' },
            { label: '运动', value: '运动' } ] },
  { id: 4, folder: 'datasets/life/', name: '生活', tag: '生活', count: 1200, icon: '/common/datasets/life/icon.png',
    desc: '厨房烹饪、居家清洁、出行旅游、育儿养老等生活常识',
    tags: [ { label: '亲子育儿', value: '亲子育儿' }, { label: '出行旅游', value: '出行旅游' },
            { label: '厨房烹饪', value: '厨房烹饪' }, { label: '宠物照料', value: '宠物照料' },
            { label: '房屋维修', value: '房屋维修' }, { label: '民俗常识', value: '民俗常识' },
            { label: '烟酒茶饮', value: '烟酒茶饮' }, { label: '理财省钱', value: '理财省钱' },
            { label: '生活居家', value: '生活居家' }, { label: '绿植养护', value: '绿植养护' },
            { label: '职场办公', value: '职场办公' }, { label: '节气节日', value: '节气节日' },
            { label: '衣物打理', value: '衣物打理' } ] },
  { id: 5, folder: 'datasets/study/', name: '学习', tag: '学习', count: 800, icon: '/common/datasets/study/icon.png',
    desc: '学习效率、手机数码与百科知识',
    tags: [ { label: '学习效率', value: '学习效率' }, { label: '手机数码', value: '手机数码' },
            { label: '百科', value: '百科' } ] }
]

var engines = {}

// 大类分组映射（首页只渲染这几个入口——真机上 image 元素一多就卡死，24 个集压到 6 个入口）
// ⚠️ 每组都必须声明 datasets（含只有单集的组）：searchAllAsync 的组过滤遇到 g.datasets 缺失
//    会 continue 掉该组所有集 = 点进去搜不到任何结果
// 6 标签 ↔ 6 数据集（1:1，与 DATASETS 的 id 对齐——集数=标签数，不再需要跨集聚合分组）
var GROUP_MAP = {
  0: { name: '历史', icon: '/common/icons/history.png', colorClass: 'ci-orange', datasets: [0] },
  1: { name: '诗词', icon: '/common/datasets/poems/icon.png', colorClass: 'ci-ds', datasets: [1] },
  2: { name: '英语', icon: '/common/datasets/english/icon.png', colorClass: 'ci-blue', datasets: [2] },
  3: { name: '健康', icon: '/common/datasets/health/icon.png', colorClass: 'ci-green', datasets: [3] },
  4: { name: '生活', icon: '/common/datasets/life/icon.png', colorClass: 'ci-cyan', datasets: [4] },
  5: { name: '学习', icon: '/common/datasets/study/icon.png', colorClass: 'ci-yellow', datasets: [5] }
}

// 首页分类行：大类入口清单（替代 20+ 个独立集入口）
function getGroupEntries() {
  var entries = []
  var ids = Object.keys(GROUP_MAP).map(Number).sort(function(a, b) { return a - b })
  for (var i = 0; i < ids.length; i++) {
    var g = GROUP_MAP[ids[i]]
    // ⚠️ v1.16.49 回退「整类名变量」写法：轻量运行时对 classList 返回数组的路径会丢类
    //（实测分类图标底色消失）——恢复「固定类 + 变量类」拼接（线上多版本验证 OK）
    entries.push({ name: g.name, icon: g.icon, colorClass: g.colorClass, isGroup: true, groupId: ids[i] })
  }
  return entries
}

// 按大类获取所有资料集 ID 列表
function getDatasetIdsByGroup(groupId) {
  var g = GROUP_MAP[groupId]
  if (!g || !g.datasets) return []
  return g.datasets
}

function ensureEngine(ds) {
  if (!engines[ds.id]) {
    var e = new SearchEngine()
    // ⚠️ 关键：深拷贝 config——所有实例共享模块常量 C，直接改会互相污染；
    // 且缓存 key 必须按集隔离（keyPrefix 加 ds 后缀），否则各集块缓存同名互相覆盖串数据
    var cloned = JSON.parse(JSON.stringify(e.config))
    cloned.blockBinary.enabled = false
    cloned.cache.keyPrefix = cloned.cache.keyPrefix + '_ds' + ds.id
    cloned.mapCache.keyPrefix = cloned.mapCache.keyPrefix + '_ds' + ds.id
    e.config = cloned
    // 蓝牙动态集在应用沙箱（internal://files/，运行时可写），内置集在 /common/（rpk 只读）
    e.basePath = ds.baseUri ? ds.baseUri : ('/common/' + ds.folder)
    if (e.basePath.charAt(e.basePath.length - 1) !== '/') e.basePath += '/'
    engines[ds.id] = e
  }
  return engines[ds.id]
}

// 注册蓝牙传输的动态资料集（v1.16.46）：追加到 DATASETS 后全局生效——
// searchAllAsync 遍历 DATASETS（搜索可达）、getItemByGlobalId（详情可达）自动覆盖。
// id 从 100 起避让内置集；重复传输同目录幂等（返回已有项，缓存按版本自动重建）。
var DYN_ID_BASE = 100
function registerDynamicDataset(opt) {
  for (var i = 0; i < DATASETS.length; i++) {
    if (DATASETS[i].dirName === opt.dirName) return DATASETS[i]
  }
  var maxId = DYN_ID_BASE - 1
  for (var j = 0; j < DATASETS.length; j++) if (DATASETS[j].id > maxId) maxId = DATASETS[j].id
  var ds = {
    id: maxId + 1,
    dirName: opt.dirName,
    folder: '',
    baseUri: 'internal://files/datasets/' + opt.dirName + '/',
    name: opt.name || opt.dirName,
    tag: opt.name || opt.dirName,
    icon: '/common/datasets/bt/icon.png',
    desc: '蓝牙传输资料集',
    tags: []
  }
  DATASETS.push(ds)
  console.log('[DM] 动态资料集已注册: id=' + ds.id + ' ' + ds.name + ' baseUri=' + ds.baseUri)
  // 刷新首页入口清单（审查修复）：global 清单只在 app onCreate 生成一次，
  // 不刷新则传输完成后首页分类行看不到新集入口（index onInit 会重读 global）
  try {
    if (typeof global !== 'undefined') {
      global.datasetEntries = getDatasetEntries()
      global.groupEntries = getGroupEntries()
    }
  } catch (e) {}
  return ds
}

// 首页资料入口动态清单：已注册的资料集 = 真实存在的资料（图标/名称/集ID）
function getDatasetEntries() {
  console.log('[DM] getDatasetEntries called, DATASETS=' + (typeof DATASETS !== 'undefined' ? DATASETS.length : 'UNDEFINED'))
  var entries = []
  for (var i = 0; i < DATASETS.length; i++) {
    var ds = DATASETS[i]
    entries.push({
      name: ds.name,
      icon: ds.icon,
      colorClass: 'ci-ds',
      dsId: ds.id,
      isDataset: true
    })
  }
  return entries
}

function encodeGlobalId(dsId, localId) {
  return (dsId * 1048576) + localId
}

function decodeGlobalId(gid) {
  return { dsId: Math.floor(gid / 1048576), localId: gid % 1048576 }
}

// 异步聚合（跨集分页语义 = 全局第 N 页：各集拉 1..page 页，按注册表顺序稳定排序后切片）
async function searchAllAsync(query, options) {
  // v1.16.178（大赛自查要求：性能数据须有可核对佐证）：记录本次跨集检索的真实耗时，
  // 由页面显示在结果计数旁 —— 使「热缓存 66~138ms」这类声明可由界面直接观察与截图复现。
  var _t0 = Date.now()
  options = options || {}
  var pageSize = options.pageSize || 20
  var page = options.page || 1
  var onlyDsId = (options.datasetId !== undefined && options.datasetId !== null) ? options.datasetId : null
  // 大类入口筛选（首页大类按 GROUP_MAP 聚合时传入；未传 = null 不限集）
  var onlyGroup = (options.groupId !== undefined && options.groupId !== null) ? options.groupId : null
  // 分类/地区筛选透传（历史集 v4 语义：引擎内按 categoryList/regionList 匹配）
  var category = (options.category !== undefined && options.category !== null) ? options.category : 'all'
  var region = (options.region !== undefined && options.region !== null) ? options.region : 'all'
  var merged = []
  var total = 0
  var initFailed = false

  // v1.16.136（主人定案）：集遍历顺序按**查询词散列出的起点轮转** ——
  // 避免所有查询都从同一个集开始（历史集最靠前且 850 条，容易长期霸占首批结果）；
  // 用查询词做种子而非真随机 → 同一查询每次结果稳定可复现（演示可重复）。
  var order = DATASETS.slice()
  var _seed = 0
  for (var _si = 0; _si < String(query).length; _si++) _seed = (_seed * 31 + String(query).charCodeAt(_si)) % 9973
  var _rot = order.length ? (_seed % order.length) : 0
  if (_rot > 0) order = order.slice(_rot).concat(order.slice(0, _rot))

  // v1.16.137（主人定案）：总搜索改为「顺序逐集累加、够数即停」——
  // 原来 6 个集全部并行发起，峰值十几个 map（各约 600 行）同时 JSON.parse，是卡顿主因。
  // 现在逐个集搜索、累计卡片数够 target 就 break（后面的集本轮不搜）；用户点「显示更多」
  // → 页码 +1 → target 增大 → 自然从上次停下的集继续（前面的集命中 _searchState 缓存，很快）。
  // 「一个集凑不够就继续下一个集，直到凑够为止」由循环本身保证。
  var target = pageSize * page
  var searchedAll = true        // 是否把所有集都搜过（未搜完 → allLoaded 必为 false）
  var eachAllLoaded = true
  var accumulated = 0
  // v1.16.146（主人选 A）：探索上限放宽为**不限制**（= order.length）。
  // 原 MAX_PROBE=4 但资料集共 6 个 —— 后 2 个永远搜不到；且点「更多」时 target 递增而探索上限
  // 不变，4 个集凑不够 target 时 slice 会取到空区间 = 「点更多没反应」。
  // 该上限当初是为治「没有停止过」加的，而真根因（触底自动翻页）已于 v1.16.141 修复，故放宽。
  var MAX_PROBE = order.length
  var probed = 0

  for (var i = 0; i < order.length; i++) {
    if (accumulated >= target) { searchedAll = false; break }   // 够数即停（主人核心要求）
    if (probed >= MAX_PROBE) { searchedAll = false; break }     // 探索上限（v1.16.141）
    var ds = order[i]
    if (onlyDsId !== null && ds.id !== onlyDsId) continue
    if (onlyGroup !== null) {
      var g = GROUP_MAP[onlyGroup]
      if (!g || !g.datasets || g.datasets.indexOf(ds.id) === -1) continue
    }
    // ⚠️ 分类/地区筛选只对历史集生效：资料集 meta 的 categoryList 为空，
    // 透传给引擎会把该集结果全部滤掉（categoryList[undefined] !== category 恒真）；
    // 筛选激活时只搜历史集（与聚合改造前的单集搜索行为一致）。
    // 标签筛选（region）对【所有集】生效。
    if (category !== 'all' && ds.id !== 0) continue
    probed++

    try {
      var eng = ensureEngine(ds)
      // ⚠️ 每集独立超时（v1.16.23）：readText 回调可能丢失（#18/#84），单集卡住会让整轮挂起。
      // 串行后这个保护更重要 —— 没有它，一个卡住的集会让后续所有集都轮不到。
      var r = await Promise.race([
        eng.search(query, { page: 1, pageSize: target, category: category, region: region }),
        new Promise(function(resolve) { setTimeout(function() { resolve(null) }, 8000) })
      ])
      if (!r) { eachAllLoaded = false; continue }        // 该集超时：按「无结果」处理，继续下一个集
      if (r.initFailed) initFailed = true
      if (!r.allLoaded) eachAllLoaded = false
      var items = r.results || []
      total += r.total || 0
      var card = (eng.display && eng.display.card) || null
      var mainField = (card && card.mainField) || 'year'
      var rows = (card && card.rows) || null
      for (var j = 0; j < items.length; j++) {
        var it = items[j]
        it.globalId = encodeGlobalId(ds.id, it.id)
        it.datasetTag = ds.tag
        // 主字段≠year 时，卡片第一行显示主字段值（学段/分类值在 region 里）
        if (mainField !== 'year') {
          it.yearDisplay = it.region || ds.tag
          it.region = ds.tag
        } else if (ds.id !== 0) {
          // 非历史集无年份语义（物化 year=0 会显示「公元元年」）——卡片年份位改显集标签
          it.yearDisplay = ds.tag
        }
        // ⚠️ 手环9固件雷：模板里 class 拼接表达式会让 DOM 属性设置崩（Unsupported type for
        // setDomAttributes）——必须在此预拼完整类名，模板只做纯变量插值。
        // v1.16.124 审查建议#5：补 rows 空值防护（card 声明存在但 rows 缺失时会抛 TypeError）
        var sz0 = (card && rows && rows[0]) ? rows[0].size : ''
        var sz1 = (card && rows && rows[1]) ? rows[1].size : ''
        var sz2 = (card && rows && rows[2]) ? rows[2].size : ''
        it.yearClass = 'result-year' + (sz0 ? ' sz-' + sz0 : '')
        it.titleClass = 'result-title' + (sz1 ? ' sz-' + sz1 : '')
        it.catClass = 'result-region' + (sz2 ? ' sz-' + sz2 : '')
        it._dsOrder = i
        it._seq = j
        merged.push(it)
      }
      accumulated += items.length
    } catch (e) {
      eachAllLoaded = false
    }
  }
  // 只有「所有集都搜过、且每集都渐进加载完」才算全部加载完（未搜完 → 还有「更多」）
  // ⚠️ 必须带 var：上一版删掉了原声明却漏加 var，隐式全局在严格模式下抛 ReferenceError，
  // 整个函数失败 → 搜索恒返回 0 条（实测搜「宋朝」0 条即为该 bug）
  var allLoaded = searchedAll && eachAllLoaded


  // v1.16.142（主人定案）：按**资料标题字数升序**（原为「各集第 1 条 → 各集第 2 条」的交错排序）。
  // 腕上屏幕窄，短标题一行放得下、长标题要折行 —— 短在前视觉更整齐、扫读更快。
  // 同字数时按集序稳定排列（避免同分记录顺序抖动）；排序在切片前做，且每次调用都从头重排，
  // 所以「显示更多」新增批次会与已有批次一起参与全局排序，不会局部乱序。
  merged.sort(function(a, b) {
    var la = (a.title || '').length
    var lb = (b.title || '').length
    if (la !== lb) return la - lb
    return a._dsOrder - b._dsOrder
  })
  var start = (page - 1) * pageSize
  return { results: merged.slice(start, start + pageSize), total: total, initFailed: initFailed,
           allLoaded: allLoaded, elapsedMs: Date.now() - _t0 }
}

// 全局 ID 取详情（跨集路由）
async function getItemByGlobalId(gid) {
  var d = decodeGlobalId(gid)
  var ds = null
  for (var i = 0; i < DATASETS.length; i++) {
    if (DATASETS[i].id === d.dsId) { ds = DATASETS[i]; break }
  }
  if (!ds) return null
  var eng = ensureEngine(ds)
  return await eng.getDoc(d.localId)
}

// 清除全部资料集的 chunk/map/resume 缓存（设置页「关于」连续点四下触发）
// ⚠️ 关键：改用【引擎自己的】clearChunkCache/clearMapCache —— 它们用 _getChunkCacheKey()
//    现算 key，与写入侧 100% 一致。此前手工拼 key（'search_engine__ds{id}v{ver}_chunk_n'）
//    在真机上实测没清掉任何东西（拉取设备 persist.db 无任何 search_engine 键），
//    正是「清完缓存重新加载仍提示有缓存」的根因。
// ⚠️ 但懒加载未 init 的实例 this.chunks/this.maps 为空 → 必须先 _loadMeta() 拿到清单，
//    否则清缓存循环一次都不执行（这也是当初没用引擎方法的原因）。
async function clearAllCaches() {
  var ok = 0, keys = 0
  for (var i = 0; i < DATASETS.length; i++) {
    var ds = DATASETS[i]
    try {
      var eng = ensureEngine(ds)
      // 只读 meta（不构建块），让 chunks/maps 清单就位
      if (typeof eng._loadMeta === 'function') await eng._loadMeta()
      if (typeof eng.clearChunkCache === 'function') await eng.clearChunkCache()
      if (typeof eng.clearMapCache === 'function') await eng.clearMapCache()
      if (typeof eng._clearResumeProgress === 'function') eng._clearResumeProgress()
      keys += (eng.chunks ? eng.chunks.length : 0) + (eng.maps ? eng.maps.length : 0) + 1
      ok++
    } catch (e) {
      console.log('[DM] 清缓存失败 ds=' + ds.id + ': ' + e.message)
    }
  }
  // ⚠️ 额外清理 app.ux 自建引擎实例：其缓存键不含 _ds 后缀（search_engine_v6_chunk_N），
  // 与资料集实例的键不同；不单独清的话历史集（/common）的缓存永远清不掉。
  try {
    var appEng = (typeof global !== 'undefined') ? global.searchEngine : null
    if (appEng && typeof appEng.clearChunkCache === 'function') {
      await appEng.clearChunkCache()
      await appEng.clearMapCache()
    }
  } catch (e) { console.log('[DM] 清理 app 引擎缓存失败: ' + e.message) }

  // 丢弃内存引擎池：下次搜索/加载按当前数据文件重建缓存
  engines = {}
  // 清缓存必须同时清标记（v1.16.66）：否则下次启动不重走 loading
  try { require('@system.storage').delete({ key: 'cache_built' }) } catch (e) {}
  console.log('[DM] clearAllCaches: 已清理 ' + ok + '/' + DATASETS.length + ' 个数据集，共 ' + keys + ' 个键位')
  return { datasets: DATASETS.length, cleared: ok, keys: keys }
}

// 全量预热（v1.16.43 主人定案，v1.16.44 流式化 + 无条件幂等）：
// 把全部资料集的索引（map+chunk）建好 storage 缓存——此前资料 5 集引擎懒创建
//（首次搜到该集才读块文件+写缓存），总搜索第一次要同时冷启动 5 个集 = 慢的根因。
// ⚠️ 流式约束（主人强调）：手环内存小，禁止 6 集索引同时驻留内存——
// 串行逐集建立，每集建完【立即丢弃该集引擎实例】（内存池随实例释放）再建下一集，
// 只保留 storage 持久缓存；下次搜索 ensureEngine 重建实例，从缓存直读（快）。
// 单集 20s 上限，失败/超时跳过——搜索路径懒加载天然兜底。
// 幂等：每次启动都可安全重跑——已有缓存的集快速读入即弃（内存池重建后随实例释放），
// 缺失的自动补建（自愈，无需任何检查——主人定案：正常情况缓存不会消失）。

async function warmupOne(ds, onProgress, keepAlive) {
  var eng = ensureEngine(ds)
  if (!eng.isReady) await eng._lazyInit()
  if (onProgress) { try { onProgress(30, '读取资料元数据') } catch (e) {} }
  // v1.16.130（性能审查 T1⑥）：每步让出一帧 —— _ensureMap/_ensureChunk 内含大字符串 JSON.parse，
  // 是 JS 线程同步 CPU 操作；后台预热在用户滑首页时跑会掉帧（init 路径早有「每 3 个歇 100ms」
  // 的节拍，warmupOne 之前没有）。让出后预热总时长几乎不变，但不再和 UI 抢主线程。
  var _yield = function () { return new Promise(function (r) { setTimeout(r, 0) }) }
  for (var m = 0; m < eng.maps.length; m++) { await eng._ensureMap(m); await _yield() }
  if (onProgress) { try { onProgress(60, '建立检索索引') } catch (e) {} }
  for (var c = 0; c < eng.chunks.length; c++) { await eng._ensureChunk(c); await _yield() }
  if (!keepAlive) {
    // 流式释放：缓存已持久化，实例内存池（loadedMaps/loadedChunks）随实例一起丢弃
    delete engines[ds.id]
  }
  if (onProgress) { try { onProgress(95, '完成') } catch (e) {} }
}

// 单集预热（蓝牙传输唤醒，v1.16.46）：loading 页只给传输来的文件建缓存。
// keepAlive=保留引擎实例（用户接下来就会搜它，不必重建）
function warmupSingle(dsId, onProgress) {
  var ds = null
  for (var i = 0; i < DATASETS.length; i++) if (DATASETS[i].id === dsId) { ds = DATASETS[i]; break }
  if (!ds) return Promise.reject(new Error('资料集不存在: ' + dsId))
  return warmupOne(ds, onProgress, true)
}

// v1.16.85 可选 keepAlive：true 时保留引擎实例（内存池常驻）——供首页后台预热用，
// 首次总搜索直接命中内存不再冷读；loading 页可视构建仍默认释放（峰值内存约束不变）
async function warmupAllCaches(onProgress, keepAlive) {
  var done = 0
  var okCount = 0   // v1.16.124：成功集数（done 是尝试数，不可用于判断是否需要自愈重跑）
  for (var i = 0; i < DATASETS.length; i++) {
    var ds = DATASETS[i]
    var okThis = false
    try {
      await Promise.race([
        (async function() { await warmupOne(ds, null, keepAlive); okThis = true })(),
        new Promise(function(r) { setTimeout(r, 20000) })
      ])
      if (okThis) okCount++
    } catch (e) {
      console.log('[DM] 预热跳过 ds=' + ds.id + ': ' + (e && e.message ? e.message : '未知'))
    }
    done++
    if (typeof onProgress === 'function') {
      try { onProgress(Math.round(done / DATASETS.length * 100), '预加载资料 · ' + ds.name) } catch (e) {}
    }
  }
  // v1.16.66 首次加载判断（主人定案）：预热完成写标记——下次启动 isCacheBuilt() 命中
  // 直接进主界面；中断/失败（标记没写）→ 下次启动自动重走 loading 重跑（幂等自愈）
  // v1.16.124 审查建议#4：done 计的是「尝试数」，原代码无条件写标记 —— 6 集全部超时/失败时
  // 也会标记「已建」，下次启动直接进主界面失去自愈机会、首搜全冷。改为至少一集成功才写。
  try {
    if (okCount > 0) require('@system.storage').set({ key: 'cache_built', value: String(CACHE_VERSION) })
    else console.log('[DM] 预热全部失败，不写 cache_built 标记（下次启动重跑 loading 自愈）')
  } catch (e) {}
  // 内存标记（v1.16.68 循环修复）：loading 建完即记——同会话内 index 判断走内存快路径，
  // 不依赖 storage 回调（该回调在部分环境会丢失，导致「超时→跳 loading→回来→再超时」死循环）
  try { if (typeof global !== 'undefined') global._launchCacheReady = true } catch (e) {}
  console.log('[DM] 预热完成 ' + done + '/' + DATASETS.length + ' 集（流式：逐集建缓存逐集释放内存，标记已写）')
  return done
}


// 缓存是否已建（首次加载判断，v1.16.66 主人定案）：标记值==当前数据版本
function isCacheBuilt() {
  return new Promise(function(resolve) {
    try {
      var cur = String(CACHE_VERSION || '')
      require('@system.storage').get({
        key: 'cache_built',
        success: function(data) { resolve(String(data) === cur && cur !== '') },
        fail: function() { resolve(false) }
      })
    } catch (e) { resolve(false) }
  })
}

// 取资料集展示信息（图标/名称/简介/标签）——供首页「资料详情视图」使用
// tags 的 cls 在此预拼（选中态由 pickTag 重设），模板只做纯变量插值
function getDatasetInfo(dsId) {  for (var i = 0; i < DATASETS.length; i++) {
    var ds = DATASETS[i]
    if (ds.id !== dsId) continue
    var tags = []
    var list = ds.tags || []
    for (var j = 0; j < list.length; j++) {
      tags.push({ label: list[j].label, value: list[j].value, cls: 'ds-tag' })
    }
    return { id: ds.id, name: ds.name, icon: ds.icon, desc: ds.desc || '', colorClass: 'ci-ds', tags: tags, count: (ds.count !== undefined ? ds.count : -1) }
  }
  return null
}

export { DATASETS, ensureEngine, searchAllAsync, getItemByGlobalId, encodeGlobalId, decodeGlobalId, getDatasetEntries, getGroupEntries, getDatasetIdsByGroup, clearAllCaches, getDatasetInfo, warmupAllCaches, registerDynamicDataset, warmupSingle, GROUP_MAP }
