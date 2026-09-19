
var C = {
  version: '3.4.0',
  dataPath: '',
  
  files: {
    meta: 'meta.txt',
    blockPrefix: 'block_',
    blockSuffix: '.txt',
    mapPrefix: 'map_',
    mapSuffix: '.txt',
    detailPrefix: 'detail_',
    detailSuffix: '.txt',
    yearIndex: 'year_index.txt'
  },
  
  // Block 二进制配置（新增）
  blockBinary: {
    enabled: true,              // 是否使用二进制格式
    magic: 0x424C4F4B,          // "BLOK"
    version: 1
  },
  
  chunk: {
    enabled: true,
    bucketSize: 2048,
    targetSize: 500,
    storageKeyPrefix: 'chunk_'
  },
  
  mapCache: {
    enabled: true,
    keyPrefix: 'search_engine_map_',
    version: 2
  },
  
  cache: {
    enabled: true,
    keyPrefix: 'search_engine_',
    // ⚠️ 数据文件变更后必须递增：chunk 缓存持久化在 storage，version 不变则旧缓存继续命中
    //（v3→v4：21 个集重建；v4→v5：架构精简 24集→6集；v5→v6：按内容质量重采 + 历史集精简）
    // ⚠️ 每次重跑生成脚本、改数据集内容后，都必须递增此号，否则搜索会命中上一版数据的块
    version: 7
  },
  
  search: {
    yearMaxResults: 5,
    // ⚠️ 原为 10：_searchKeyword 取到候选后被 slice(0,10)，每个集只保留前 10 条命中，
    // 命中多的集后面的条目被整片截掉 = 主人反馈「有的时候搜索不出结果」的直接原因。
    // 数据精简后各集仅 800~1200 条，放到 100 对性能影响可忽略。
    keywordMaxResults: 100,
    yearRangeLimit: 500,
    pageSize: 20
  },
  
  tokenizer: {
    // v1.16.148（主人二次反馈）：3 → 1。英文索引改为**从 1 个字母起建全部前缀**，
    // 于是搜 "d" 就能列出所有 d 开头的单词（实测 58 条），彻底解决「短查询搜不到」的可用性问题。
    // ⚠️ 改动此值必须同步重建各集的 block（英文集用 tools/rebuild_english_block.py）
    //    并同步 tools/lib/dataset_core.js —— 两侧规则不一致会导致 token 对不上、条目永远搜不到。
    minEnglishPrefix: 1,
    delimiters: /[\s,，、]+/
  },
  
  detailChunkSize: 100,
  
  resume: {
    enabled: true,
    saveInterval: 500,
    expireMinutes: 10
  },
  
  // LRU 上限（v1.16.61 主人指定动态内存策略）：Block 最多存活 2、Map 最多留 4。
  // 超限即淘汰最久未用的——内存只保留"最近用到的"，其余放回 storage 缓存按需重载
  //（淘汰的只是内存副本，storage 持久缓存仍在，重载便宜）。
  // ⚠️ 必须 > 0：0 会让淘汰 while 变死循环（见 _ensureMap/_ensureChunk 内注释）
  maxLoadedChunks: 2,
  // v1.16.94 内存收紧（主人定案）：动态加载最多驻留 2 张 Map（原 4），
  // 防真机意外爆内存；被淘汰的 Map 其命中行早已提取进搜索态 rows，翻页正确性不受影响
  maxLoadedMaps: 2,
  //调度策略：按需加载（默认）或预加载
  blockPreload: {
    enabled: true,      // 是否启用 Block 预加载
    // v1.16.61：与 LRU 上限对齐（预载超限只会立刻被淘汰，是无效 I/O）
    maxBlocks: 2,        // 最多预加载几个 Block（0 = 全部）
    preloadOnInit: true  // 完整初始化时预加载（快速启动时强制跳过）
  },
  
  mapPreload: {
    enabled: true,           // 是否启用预加载
    // v1.16.177（独立审查修复）：预载上限必须与 LRU 上限对齐 —— maxLoadedMaps 已于
    // v1.16.94 从 4 收紧到 2，而这里仍是 4 且注释写「Map 最多留 4」（旧值）→
    // 预载 4 张 Map 会有 2 张立刻被 LRU 淘汰，等于白读白解析（blockPreload 的注释
    // 早就写明「预载超限只会立刻被淘汰，是无效 I/O」，Map 侧漏改了）。
    maxMaps: 2,               // 最多预加载几个 Map（0 = 全部加载）
    preloadOnInit: true      // 是否在完整初始化（非快速启动）时预加载
  },
  // ⚠️ 生产环境关闭：引擎内部每一步都会 _logInfo/_logSuccess，真机上日志写入本身
  // 就是可观开销（尤其首搜要打上百条），排查问题时可临时改回 true
  debug: false
}

// ========== 日志工具 ==========
function _log(msg, level, ctx) {
  // ⚠️ 生产（debug:false）直接返回：引擎内部每一步都会打日志，而 app.ux 的
  // addRuntimeLog 每次都会 storage.set —— 一次跨集搜索可产生数十次块设备写入，
  // 这是手环上「搜索卡顿」的主要来源之一。排查问题时可临时把 config.debug 改回 true。
  if (!C.debug) return
  level = level || 'info'
  try {
    if (typeof global !== 'undefined' && global.addRuntimeLog) {
      var prefix = '[引擎] '
      if (ctx) prefix += '[' + ctx + '] '
      global.addRuntimeLog(prefix + msg, level)
    }
    if (C.debug && console) {
      console.log('[' + level.toUpperCase() + '] ' + msg)
    }
  } catch(e) {}
}

function _logInfo(msg, ctx) { _log(msg, 'info', ctx) }
function _logSuccess(msg, ctx) { _log(msg, 'success', ctx) }
function _logWarn(msg, ctx) { _log(msg, 'warn', ctx) }
function _logError(msg, ctx) { _log(msg, 'error', ctx) }

// ========== 哈希函数 ==========
function hashCode(str) {
  var hash = 5381
  for (var i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return hash >>> 0
}

// ========== 搜索引擎主类 ==========
class SearchEngine {
  constructor() {
    this.config = C
    
    // 元数据
    this.totalCount = 0
    this.regionList = []
    this.categoryList = []
    this.bucketSize = C.chunk.bucketSize
    this.chunks = []
    this.detailChunkSize = C.detailChunkSize
    
    // Map元数据
    this.maps = []
    this.mapChunkSize = 0
    
    // 年份索引
    this.yearToIds = {}
    
    // 分块缓存（内存）
    this.loadedChunks = {}
    
    // Map数据（内存）—— 按需加载
    this.mapData = {}
    this._cachedMaps = {}   // 记录哪些 Map 已有缓存
    
    // 运行状态
    this._searchState = null   // 渐进式 map 加载状态（v1.16.60：同 query 复用候选/已加载进度）
    this.isReady = false
    this.basePath = ''
    // 懒初始化：首次搜索自动建立缓存（meta/年份索引 + 按需块缓存），
    // 二次搜索/启动直接命中 storage 缓存，无需手动「加载数据」流程
    this._lazyIniting = false
    this._lazyInitPromise = null
    this.initFailed = false
    
    // LRU 缓存限制（Block）
    this.maxLoadedChunks = C.maxLoadedChunks || 2
    this.loadedChunksOrder = []
    
    // ========== 新增：Map LRU 缓存限制 ==========
    this.maxLoadedMaps = C.maxLoadedMaps || 2
    this.loadedMapsOrder = []
    
    _logInfo('引擎实例创建完成 (v3.4)')   // 审查报告小瑕疵：原字符串被截断，缺右括号
  }
  
  // ========== 工具方法 ==========
  
  _formatYearDisplay(year) {
    if (year < 0) return '约公元前' + Math.abs(year) + '年'
    if (year > 0) return '公元' + year + '年'
    return '公元元年'
  }
  
  _getCacheKey() {
    return this.config.cache.keyPrefix + 'v' + this.config.cache.version
  }
  
  _getChunkCacheKey(chunkId) {
    return this._getCacheKey() + '_' + this.config.chunk.storageKeyPrefix + chunkId
  }
  
  _getMapCacheKey(mapId) {
    return this.config.mapCache.keyPrefix + 'v' + this.config.mapCache.version + '_' + mapId
  }
  
  _getResumeKey() {
    return this.config.cache.keyPrefix + 'resume_v' + this.config.cache.version
  }
  
  // ========== 断点续建 ==========
  
  _saveProgress(currentId, totalCount) {
    if (!this.config.resume.enabled) return
    try {
      var storage = require('@system.storage')
      var progress = {
        currentId: currentId,
        totalCount: totalCount,
        timestamp: Date.now(),
        version: this.config.cache.version
      }
      storage.set({ key: this._getResumeKey(), value: JSON.stringify(progress) })
      _logInfo('进度保存: ' + currentId + '/' + totalCount, 'resume')
    } catch(e) {
      _logWarn('进度保存失败: ' + e.message, 'resume')
    }
  }
  
  _loadResumeProgress() {
    return new Promise(function(resolve) {
      try {
        var storage = require('@system.storage')
        storage.get({
          key: this._getResumeKey(),
          success: function(data) {
            try {
              var progress = JSON.parse(data)
              var expireMs = this.config.resume.expireMinutes * 60 * 1000
              if (progress && progress.version === this.config.cache.version &&
                  (Date.now() - progress.timestamp) < expireMs) {
                _logInfo('找到有效进度: ' + progress.currentId + '/' + progress.totalCount, 'resume')
                resolve(progress)
              } else {
                resolve(null)
              }
            } catch(e) { resolve(null) }
          }.bind(this),
          fail: function() { resolve(null) }
        })
      } catch(e) {
        resolve(null)
      }
    }.bind(this))
  }
  
  _clearResumeProgress() {
    try {
      var storage = require('@system.storage')
      storage.delete({ key: this._getResumeKey() })
      _logInfo('进度已清除', 'resume')
    } catch(e) {}
  }
  
  // ========== 初始化 ==========

  /**
   * 懒初始化（搜索/查询触发）：只读 meta + 年份索引即置就绪，
   * 块与 Map 不预载 —— 由 _ensureChunk/_ensureMap 在搜索时按需
   * 「内存 → storage 缓存 → 文件」加载并自动写缓存。
   * 第一次搜索建立缓存（稍慢属预期），二次搜索/启动直接命中缓存。
   */
  async _lazyInit() {
    if (this.isReady) return true
    if (this._lazyIniting) return this._lazyInitPromise
    this._lazyIniting = true
    var self = this
    this._lazyInitPromise = (async function() {
      _logInfo('懒初始化开始（由搜索触发）', 'init')
      // 补数据路径：懒初始化不经过 init()/initLight()，basePath 仍为 constructor 的空串，
      // 缺了它 meta 读取必失败 → initFailed → 页面误提示「去设置加载」
      // v1.16.176（提交前审查修复）：这里原本在 basePath 为空时**兜底写死历史集路径** —— 一旦
      // 有非历史集的引擎走到这条路（basePath 未被注入），它会静默去读历史集的数据（串集/结果错误），
      // 比失败更糟。所有引擎实例都由 DatasetManager.ensureEngine 创建并注入 basePath（含蓝牙动态集的
      // 沙箱路径），故此处应为不可达；改成**响亮失败**，让问题暴露而不是被掩盖。
      if (!self.basePath) {
        self._lazyIniting = false
        self.initFailed = true
        _logError('懒初始化失败：basePath 未注入（应由 ensureEngine 提供）', 'init')
        return false
      }
      var ok = await self._loadMeta()
      if (!ok) {
        self._lazyIniting = false
        self.initFailed = true
        _logError('懒初始化失败：meta 读取失败', 'init')
        return false
      }
      await self._loadYearIndex()
      self.isReady = true
      self._lazyIniting = false
      _logSuccess('懒初始化完成，共 ' + self.totalCount + ' 条（块按需加载）', 'init')
      return true
    })()
    return this._lazyInitPromise
  }

  async initLight(basePath) {
    this.basePath = basePath || this.config.dataPath
    if (this.basePath && this.basePath.charAt(this.basePath.length - 1) !== '/') {
      this.basePath += '/'
    }
    
    // 设置快速启动标志
    this._isQuickLaunch = true
    
    await this._loadMeta()
    await this._loadYearIndex()
    // 快速启动模式下，_loadAllMaps 会检测 _isQuickLaunch 并跳过预加载
    
    this.isReady = true
    _logInfo('轻量初始化完成（跳过Map预加载）', 'init')
    return true
  }
  
  async init(basePath, progressCallback) {
    _logInfo('========== 引擎初始化开始 ==========', 'init')
    
    this.basePath = basePath || this.config.dataPath
    if (this.basePath && this.basePath.charAt(this.basePath.length - 1) !== '/') {
      this.basePath += '/'
    }
    _logInfo('数据路径: ' + this.basePath, 'init')
    
    // 重置快速启动标志
    this._isQuickLaunch = false
    
    try {
      // Step 1: 加载元数据
      if (typeof progressCallback === 'function') progressCallback(5, '加载元数据...')
      var metaLoaded = await this._loadMeta()
      if (!metaLoaded) {
        _logError('元数据加载失败', 'init')
        return false
      }
      
      // Step 2: 加载年份索引
      if (typeof progressCallback === 'function') progressCallback(10, '加载年份索引...')
      await this._loadYearIndex()
      
      // Step 3: 加载 Map（根据预加载策略）
      if (typeof progressCallback === 'function') progressCallback(12, '加载Map索引...')
      await this._loadAllMaps()
      
      // Step 4: 检查缓存并加载块
      if (this.config.cache.enabled && this.config.chunk.enabled) {
        if (typeof progressCallback === 'function') progressCallback(15, '检查缓存...')
        var loaded = await this._loadAllChunksFromCache(progressCallback)
        if (loaded) {
          this.isReady = true
          _logSuccess('所有块加载完成，共 ' + this.totalCount + ' 条', 'init')
          if (typeof progressCallback === 'function') progressCallback(100, '就绪')
          return true
        }
      }
      
      // Step 5: 从文件构建
      if (typeof progressCallback === 'function') progressCallback(20, '构建索引块...')
      var built = await this._buildAllChunks(progressCallback)
      if (!built) {
        _logError('索引构建失败', 'init')
        return false
      }
      
      this.isReady = true
      _logSuccess('引擎初始化完成，共 ' + this.totalCount + ' 条数据', 'init')
      if (typeof progressCallback === 'function') progressCallback(100, '就绪')
      return true
      
    } catch(e) {
      _logError('初始化异常: ' + e.message, 'init')
      return false
    }
  }
  
  // ========== 加载元数据 ==========
  
  _loadMeta() {
    return new Promise(function(resolve) {
      try {
        var file = require('@system.file')
        var metaPath = this.basePath + this.config.files.meta
        
        file.readText({
          uri: metaPath,
          success: function(data) {
            try {
              var meta = JSON.parse(data.text)
              this.totalCount = meta.totalCount || 0
              this.regionList = meta.regionList || []
              this.categoryList = meta.categoryList || []
              this.bucketSize = meta.bucketSize || this.config.chunk.bucketSize
              this.detailChunkSize = meta.detailChunkSize || this.config.detailChunkSize
              
              if (meta.chunks && meta.chunks.length > 0) {
                this.chunks = meta.chunks
              } else {
                this.chunks = [{ id: 0, bucketStart: 0, bucketEnd: this.bucketSize - 1, recordCount: this.totalCount }]
              }
              
              this.maps = meta.maps || []
              this.display = meta.display || null
              this.categoryListMeta = meta.categoryList || null
              this.mapChunkSize = meta.mapChunkSize || 100
              
              _logInfo('元数据: 总条数=' + this.totalCount + ', 块数=' + this.chunks.length + ', Map数=' + this.maps.length, 'meta')
              resolve(true)
            } catch(e) {
              _logError('meta解析失败: ' + e.message, 'meta')
              resolve(false)
            }
          }.bind(this),
          fail: function(err, code) {
            _logError('meta文件读取失败: code=' + code, 'meta')
            resolve(false)
          }
        })
      } catch(e) {
        _logError('_loadMeta异常: ' + e.message, 'meta')
        resolve(false)
      }
    }.bind(this))
  }
  
  // ========== 加载年份索引 ==========
  
  _loadYearIndex() {
    return new Promise(function(resolve) {
      try {
        var file = require('@system.file')
        var indexPath = this.basePath + this.config.files.yearIndex
        
        file.readText({
          uri: indexPath,
          success: function(data) {
            try {
              var lines = data.text.split('\n').filter(function(line) { return line.trim() })
              for (var i = 0; i < lines.length; i++) {
                var parts = lines[i].split('|')
                if (parts.length < 2) continue
                var year = parseInt(parts[0], 10)
                var ids = parts[1].split(',').map(function(id) { return parseInt(id, 10) })
                this.yearToIds[year.toString()] = ids
              }
              _logInfo('年份索引加载完成，共 ' + Object.keys(this.yearToIds).length + ' 个年份', 'year')
              resolve(true)
            } catch(e) {
              _logWarn('年份索引解析失败: ' + e.message, 'year')
              resolve(true)
            }
          }.bind(this),
          fail: function() {
            _logWarn('年份索引文件不存在，年份搜索不可用', 'year')
            resolve(true)
          }
        })
      } catch(e) {
        _logWarn('_loadYearIndex异常: ' + e.message, 'year')
        resolve(true)
      }
    }.bind(this))
  }
  
  // ========== Map加载（只检查缓存，不加载到内存） ==========
  
  _loadMapFromCache(mapId) {
    return new Promise(function(resolve) {
      try {
        var storage = require('@system.storage')
        var cacheKey = this._getMapCacheKey(mapId)
        
        storage.get({
          key: cacheKey,
          success: function(data) {
            try {
              var mapData = JSON.parse(data)
              if (mapData.version !== this.config.mapCache.version) {
                resolve(null)
                return
              }
              _logInfo('Map ' + mapId + ' 缓存命中', 'map')
              resolve(mapData)
            } catch(e) {
              resolve(null)
            }
          }.bind(this),
          fail: function() { resolve(null) }
        })
      } catch(e) {
        resolve(null)
      }
    }.bind(this))
  }
  
  _saveMapToCache(mapId, mapData) {
    try {
      var storage = require('@system.storage')
      var cacheKey = this._getMapCacheKey(mapId)
      mapData.version = this.config.mapCache.version
      storage.set({ key: cacheKey, value: JSON.stringify(mapData) })
      _logInfo('Map ' + mapId + ' 缓存保存成功', 'map')
      return true
    } catch(e) {
      _logWarn('Map ' + mapId + ' 缓存保存失败: ' + e.message, 'map')
      return false
    }
  }
  
  _loadMapFromFile(mapId) {
    return new Promise(function(resolve) {
      try {
        var file = require('@system.file')
        var mapPath = this.basePath + this.config.files.mapPrefix + mapId + this.config.files.mapSuffix
        var mapMeta = this.maps[mapId]
        
        if (!mapMeta) {
          _logWarn('Map ' + mapId + ' 元数据不存在', 'map')
          resolve(null)
          return
        }
        
        file.readText({
          uri: mapPath,
          success: function(data) {
            try {
              var lines = data.text.split('\n').filter(function(line) { return line.trim() })
              var ids = []
              var years = []
              var regionIds = []
              var titles = []
              
              for (var i = 0; i < lines.length; i++) {
                var parts = lines[i].split('|')
                if (parts.length < 4) continue
                ids.push(parseInt(parts[0], 10))
                years.push(parseInt(parts[1], 10))
                regionIds.push(parseInt(parts[2], 10))
                titles.push(parts[3] || '')
              }
              
              var mapData = {
                ids: ids,
                years: years,
                regionIds: regionIds,
                titles: titles,
                recordCount: ids.length
              }
              
              _logInfo('Map ' + mapId + ' 从文件加载完成，' + ids.length + ' 条', 'map')
              resolve(mapData)
            } catch(e) {
              _logError('Map ' + mapId + ' 文件解析失败: ' + e.message, 'map')
              resolve(null)
            }
          }.bind(this),
          fail: function(err, code) {
            _logError('Map ' + mapId + ' 文件读取失败: code=' + code, 'map')
            resolve(null)
          }
        })
      } catch(e) {
        _logError('_loadMapFromFile异常: ' + e.message, 'map')
        resolve(null)
      }
    }.bind(this))
  }
  
  // 启动时只检查缓存，不加载到内存
  /**
 * 加载 Map（支持预加载策略）
 * 快速启动模式下强制跳过预加载
 */
  async _loadAllMaps() {
    if (this.maps.length === 0) {
      _logInfo('没有Map配置，跳过加载', 'map')
      return
    }
  
    // 快速启动模式跳过预加载
    if (this._isQuickLaunch) {
      _logInfo('快速启动模式，跳过Map预加载', 'map')
      return
    }
  
    var preloadConfig = this.config.mapPreload || { enabled: false, maxMaps: 0 }
  
    // 按需加载模式：只检查缓存
    if (!preloadConfig.enabled) {
      await this._checkAllMapsCache()
      return
    }
  
    // ====== 预加载模式：直接调用 _ensureMap ======
    var maxMaps = preloadConfig.maxMaps || 0
    var totalMaps = this.maps.length
    var loadCount = (maxMaps === 0) ? totalMaps : Math.min(maxMaps, totalMaps)
  
    _logInfo('预加载模式：加载前 ' + loadCount + '/' + totalMaps + ' 个Map', 'map')
  
    for (var i = 0; i < loadCount; i++) {
      // 直接用 _ensureMap 加载，它会处理缓存/文件/内存
      var mapData = await this._ensureMap(i)
      if (mapData) {
        _logInfo('Map ' + i + ' 预加载成功', 'map')
      } else {
        _logWarn('Map ' + i + ' 预加载失败', 'map')
      }
  
      // 每加载 3 个休息 100ms
      if (i % 3 === 2) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  
    _logSuccess('Map预加载完成', 'map')
  }
  
/**
 * 仅检查 Map 缓存是否存在，不加载到内存
 * 用于按需加载模式
 */
async _checkAllMapsCache() {
  _logInfo('检查 ' + this.maps.length + ' 个Map缓存', 'map')
  this._cachedMaps = {}
  
  for (var i = 0; i < this.maps.length; i++) {
    try {
      var mapData = await this._loadMapFromCache(i)
      this._cachedMaps[i] = !!mapData
      if (this._cachedMaps[i]) {
        _logInfo('Map ' + i + ' 缓存存在', 'map')
      } else {
        // 尝试构建缓存
        mapData = await this._loadMapFromFile(i)
        if (mapData) {
          this._saveMapToCache(i, mapData)
          this._cachedMaps[i] = true
          _logInfo('Map ' + i + ' 已构建缓存', 'map')
        }
      }
    } catch(e) {
      _logError('检查Map ' + i + ' 失败: ' + e.message, 'map')
      this._cachedMaps[i] = false
    }
    
    if (i % 3 === 2) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  
  _logSuccess('Map缓存检查完成', 'map')
}
  // ========== Map 按需加载（搜索时调用） ==========
  async _ensureMap(mapId) {
    // 如果已经在内存中，移到最近使用位置
    if (this.mapData[mapId]) {
      var idx = this.loadedMapsOrder.indexOf(mapId)
      if (idx > -1) {
        this.loadedMapsOrder.splice(idx, 1)
        this.loadedMapsOrder.push(mapId)
      }
      return this.mapData[mapId]
    }
    
    _logInfo('加载 Map ' + mapId + ' 到内存', 'map')
    
    var mapData = await this._loadMapFromCache(mapId)
    if (!mapData) {
      mapData = await this._loadMapFromFile(mapId)
      if (mapData) {
        this._saveMapToCache(mapId, mapData)
      }
    }
    
    if (!mapData) {
      _logError('Map ' + mapId + ' 加载失败', 'map')
      return null
    }
    
    // ========== 新增：LRU 淘汰 ==========
    // ⚠️ 死循环防护：maxLoadedMaps 为 0 时 length>=0 恒真，而 shift() 在空数组上不改变
    // 长度 → 0>=0 永远成立 = 无限循环。必须显式要求上限 > 0 才做淘汰。
    while (this.maxLoadedMaps > 0 && this.loadedMapsOrder.length >= this.maxLoadedMaps) {
      var oldest = this.loadedMapsOrder.shift()
      delete this.mapData[oldest]
      _logInfo('移除 Map ' + oldest + ' 释放内存', 'map')
    }
    
    // 存入内存
    this.mapData[mapId] = mapData
    this.loadedMapsOrder.push(mapId)
    // v1.16.72 审查修复（中#2）：idToIndex 统一在此补建——渐进切片/LRU 逐出后
    // 自愈重载的 map 也带索引（原只在 _loadNextMapIntoState 建，重载路径缺失 → 整批丢行）
    if (!mapData.idToIndex) {
      var idxMap = {}
      for (var ii = 0; ii < mapData.ids.length; ii++) idxMap[mapData.ids[ii]] = ii
      mapData.idToIndex = idxMap
    }
    
    return mapData
  }
  
  // 从 Map 获取信息（确保 Map 已加载）
  async _getMapInfoById(mapId, id) {
    var map = await this._ensureMap(mapId)
    if (!map) return null
    
    var ids = map.ids
    var left = 0
    var right = ids.length - 1
    
    while (left <= right) {
      var mid = Math.floor((left + right) / 2)
      if (ids[mid] === id) {
        return {
          year: map.years[mid],
          regionId: map.regionIds[mid],
          title: map.titles[mid]
        }
      } else if (ids[mid] < id) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }
    return null
  }
  
  _getMapIdById(id) {
    for (var i = 0; i < this.maps.length; i++) {
      var map = this.maps[i]
      if (id >= map.startId && id <= map.endId) {
        return i
      }
    }
    return -1
  }
  
  // ========== 分块核心 ==========
  
  _getChunkIdByBucketIndex(bucketIndex) {
    for (var i = 0; i < this.chunks.length; i++) {
      var chunk = this.chunks[i]
      if (bucketIndex >= chunk.bucketStart && bucketIndex <= chunk.bucketEnd) {
        return chunk.id
      }
    }
    return -1
  }
  
  _loadChunkFromCache(chunkId) {
    return new Promise(function(resolve) {
      try {
        var storage = require('@system.storage')
        var cacheKey = this._getChunkCacheKey(chunkId)
        
        storage.get({
          key: cacheKey,
          success: function(data) {
            try {
              var chunkData = JSON.parse(data)
              if (chunkData.version !== this.config.cache.version) {
                resolve(null)
                return
              }
              _logInfo('块 ' + chunkId + ' 缓存命中', 'chunk')
              resolve(chunkData)
            } catch(e) {
              resolve(null)
            }
          }.bind(this),
          fail: function() { resolve(null) }
        })
      } catch(e) {
        resolve(null)
      }
    }.bind(this))
  }
  
  _saveChunkToCache(chunkId, chunkData) {
    try {
      var storage = require('@system.storage')
      var cacheKey = this._getChunkCacheKey(chunkId)
      chunkData.version = this.config.cache.version
      chunkData.chunkId = chunkId
      storage.set({ key: cacheKey, value: JSON.stringify(chunkData) })
      _logInfo('块 ' + chunkId + ' 缓存保存成功', 'chunk')
      return true
    } catch(e) {
      _logWarn('块 ' + chunkId + ' 缓存保存失败: ' + e.message, 'chunk')
      return false
    }
  }
  
  /**
   * 从二进制文件加载 Block（新格式）
   * 文件格式：BLOK (4B) | version (4B) | chunkId (4B) | bucketCount (2B) | [bucketIndex (2B) | idCount (2B) | ids (idCount×4B)] ...
   */
  _loadChunkFromFileBinary(chunkId) {
    return new Promise(function(resolve) {
      try {
        var file = require('@system.file')
        var blockPath = this.basePath + this.config.files.blockPrefix + chunkId + this.config.files.blockSuffix
        var chunkConfig = this.chunks[chunkId]
        
        if (!chunkConfig) {
          _logWarn('块 ' + chunkId + ' 配置不存在', 'chunk')
          resolve(null)
          return
        }
        
        file.readArrayBuffer({
          uri: blockPath,
          success: function(res) {
            try {
              // ========== 关键修复：手动转换类数组为 ArrayBuffer ==========
              var arrayLike = res.buffer
              var buffer = new ArrayBuffer(arrayLike.length)
              var uint8View = new Uint8Array(buffer)
              for (var i = 0; i < arrayLike.length; i++) {
                uint8View[i] = arrayLike[i] & 0xFF
              }
              
              var dv = new DataView(buffer)
              var offset = 0
              
              // 读取头部
              var magic = dv.getUint32(offset, true)
              offset += 4
              var version = dv.getUint32(offset, true)
              offset += 4
              var chunkIdRead = dv.getUint32(offset, true)
              offset += 4
              // 验证 Magic
              if (magic !== 0x424C4F4B) {
                _logError('块 ' + chunkId + ' Magic 不匹配: 0x' + magic.toString(16), 'chunk')
                resolve(null)
                return
              }
              
              if (version !== 1) {
                _logWarn('块 ' + chunkId + ' 版本不匹配: ' + version + '，尝试文本格式', 'chunk')
                this._loadChunkFromFileText(chunkId).then(resolve)
                return
              }
              
              var bucketCount = dv.getUint16(offset, true)
              offset += 2
              
              var chunkData = {
                chunkId: chunkIdRead,
                bucketStart: chunkConfig.bucketStart,
                bucketEnd: chunkConfig.bucketEnd,
                recordCount: 0,
                buckets: {}
              }
              
              for (var i = 0; i < bucketCount; i++) {
                if (offset + 4 > buffer.byteLength) {
                  _logError('块 ' + chunkId + ' 数据截断', 'chunk')
                  resolve(null)
                  return
                }
                var bucketIndex = dv.getUint16(offset, true)
                offset += 2
                var idCount = dv.getUint16(offset, true)
                offset += 2
                
                if (offset + idCount * 4 > buffer.byteLength) {
                  _logError('块 ' + chunkId + ' ID数据截断', 'chunk')
                  resolve(null)
                  return
                }
                
                var ids = []
                for (var j = 0; j < idCount; j++) {
                  ids.push(dv.getUint32(offset, true))
                  offset += 4
                }
                chunkData.buckets[bucketIndex] = ids
                chunkData.recordCount += idCount
              }
              
              _logInfo('块 ' + chunkId + ' 从二进制文件加载完成，' + chunkData.recordCount + ' 条', 'chunk')
              resolve(chunkData)
            } catch(e) {
              _logError('块 ' + chunkId + ' 二进制解析失败: ' + e.message + '，尝试文本格式', 'chunk')
              this._loadChunkFromFileText(chunkId).then(resolve)
            }
          }.bind(this),
          fail: function(err, code) {
            _logWarn('块 ' + chunkId + ' 二进制文件读取失败: code=' + code + '，尝试文本格式', 'chunk')
            this._loadChunkFromFileText(chunkId).then(resolve)
          }.bind(this)
        })
      } catch(e) {
        _logError('_loadChunkFromFileBinary异常: ' + e.message, 'chunk')
        this._loadChunkFromFileText(chunkId).then(resolve)
      }
    }.bind(this))
  }
  
  /**
   * 从文本文件加载 Block（回退方案，兼容旧格式）
   */
  _loadChunkFromFileText(chunkId) {
    return new Promise(function(resolve) {
      try {
        var file = require('@system.file')
        var blockPath = this.basePath + this.config.files.blockPrefix + chunkId + this.config.files.blockSuffix
        var chunkConfig = this.chunks[chunkId]
        
        if (!chunkConfig) {
          resolve(null)
          return
        }
        
        file.readText({
          uri: blockPath,
          success: function(data) {
            try {
              var lines = data.text.split('\n').filter(function(line) { return line.trim() })
              var chunkData = {
                chunkId: chunkId,
                bucketStart: chunkConfig.bucketStart,
                bucketEnd: chunkConfig.bucketEnd,
                recordCount: 0,
                buckets: {}
              }
              
              for (var i = 0; i < lines.length; i++) {
                var parts = lines[i].split('|')
                if (parts.length < 2) continue
                var bucketIndex = parseInt(parts[0], 10)
                var ids = parts[1].split(',').map(function(id) { return parseInt(id, 10) })
                chunkData.buckets[bucketIndex] = ids
                chunkData.recordCount += ids.length
              }
              
              _logInfo('块 ' + chunkId + ' 从文本文件加载完成（回退），' + chunkData.recordCount + ' 条', 'chunk')
              resolve(chunkData)
            } catch(e) {
              _logError('块 ' + chunkId + ' 文本解析失败: ' + e.message, 'chunk')
              resolve(null)
            }
          }.bind(this),
          fail: function(err, code) {
            _logError('块 ' + chunkId + ' 文本文件读取失败: code=' + code, 'chunk')
            resolve(null)
          }
        })
      } catch(e) {
        _logError('_loadChunkFromFileText异常: ' + e.message, 'chunk')
        resolve(null)
      }
    }.bind(this))
  }
  
  /**
   * 加载块（自动选择二进制或文本格式）
   */
  _loadChunkFromFile(chunkId) {
    if (this.config.blockBinary.enabled) {
      return this._loadChunkFromFileBinary(chunkId)
    } else {
      return this._loadChunkFromFileText(chunkId)
    }
  }
  
  async _buildAndCacheChunk(chunkId, progressCallback) {
    _logInfo('构建块 ' + chunkId, 'build')
    var chunkData = await this._loadChunkFromFile(chunkId)
    if (!chunkData) return false
    
    var saved = this._saveChunkToCache(chunkId, chunkData)
    
    
    // 休息 300ms（用户指定保留）
    await new Promise(resolve => setTimeout(resolve, 300))
    
    if (typeof progressCallback === 'function') {
      var percent = Math.floor((chunkId + 1) / this.chunks.length * 100)
      progressCallback(percent, '块 ' + (chunkId + 1) + '/' + this.chunks.length)
    }
    return saved
  }
  
  // 全量构建块（init 的 Step 5 兜底路径）。此前该方法【只有调用、没有定义】，
  // 一旦走到该分支就抛 TypeError 并被 catch 吞掉 → 表现为「数据加载失败」。
  async _buildAllChunks(progressCallback) {
    var total = this.chunks.length
    _logInfo('开始构建 ' + total + ' 个块', 'build')
    for (var i = 0; i < total; i++) {
      var ok = await this._buildAndCacheChunk(i, progressCallback)
      if (!ok) {
        _logError('块 ' + i + ' 构建失败', 'build')
        return false
      }
    }
    return true
  }

  async _loadAllChunksFromCache(progressCallback) {
    var totalChunks = this.chunks.length
    _logInfo('开始检查 ' + totalChunks + ' 个块缓存', 'cache')
    
    // 检查是否为快速启动模式
    if (this._isQuickLaunch) {
      _logInfo('快速启动模式，跳过Block预加载', 'cache')
      this._cachedChunks = {}
      return true
    }
    
    // 检查预加载策略
    var preloadConfig = this.config.blockPreload || { enabled: false, maxBlocks: 0 }
    
    // ====== 预加载模式 ======
    if (preloadConfig.enabled) {
      var maxBlocks = preloadConfig.maxBlocks || 0
      var loadCount = (maxBlocks === 0) ? totalChunks : Math.min(maxBlocks, totalChunks)
      
      _logInfo('预加载模式：加载前 ' + loadCount + '/' + totalChunks + ' 个Block', 'cache')
      
      for (var i = 0; i < loadCount; i++) {
        // 直接用 _ensureChunk 加载到内存
        var chunkData = await this._ensureChunk(i)
        if (chunkData) {
          _logInfo('Block ' + i + ' 预加载成功', 'cache')
        } else {
          _logWarn('Block ' + i + ' 预加载失败', 'cache')
        }
        
        if (typeof progressCallback === 'function') {
          var percent = Math.floor((i + 1) / totalChunks * 60 + 20)
          progressCallback(percent, '预加载块 ' + (i + 1) + '/' + totalChunks)
        }
        
        if (i % 3 === 2) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      
      _logSuccess('Block预加载完成：' + loadCount + '/' + totalChunks + ' 个', 'cache')
      return true
    }
    
    // ====== 按需加载模式：只检查缓存 ======
    this._cachedChunks = {}
    for (var i = 0; i < totalChunks; i++) {
      try {
        var chunkData = await this._loadChunkFromCache(i)
        if (chunkData) {
          this._cachedChunks[i] = true
          _logInfo('块 ' + i + ' 缓存存在', 'cache')
        } else {
          this._cachedChunks[i] = false
          _logInfo('块 ' + i + ' 缓存不存在，从文件构建', 'cache')
          var built = await this._buildAndCacheChunk(i, progressCallback)
          if (!built) return false
        }
      } catch(e) {
        _logError('检查块 ' + i + ' 失败: ' + e.message, 'cache')
        this._cachedChunks[i] = false
      }
      
      if (i % 3 === 2) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    
    _logInfo('缓存检查完成', 'cache')
    return true
  }
  
  async _ensureChunk(chunkId) {
    if (this.loadedChunks[chunkId]) {
      var idx = this.loadedChunksOrder.indexOf(chunkId)
      if (idx > -1) {
        this.loadedChunksOrder.splice(idx, 1)
        this.loadedChunksOrder.push(chunkId)
      }
      return this.loadedChunks[chunkId]
    }
    
    _logInfo('加载块 ' + chunkId + ' 到内存', 'chunk')
    
    var chunkData = await this._loadChunkFromCache(chunkId)
    if (!chunkData) {
      chunkData = await this._loadChunkFromFile(chunkId)
      if (chunkData) {
        this._saveChunkToCache(chunkId, chunkData)
      }
    }
    
    if (!chunkData) {
      _logError('块 ' + chunkId + ' 加载失败', 'chunk')
      return null
    }
    
    // ⚠️ 同上：maxLoadedChunks 为 0 会构成无限循环
    while (this.maxLoadedChunks > 0 && this.loadedChunksOrder.length >= this.maxLoadedChunks) {
      var oldest = this.loadedChunksOrder.shift()
      delete this.loadedChunks[oldest]
      _logInfo('移除块 ' + oldest + ' 释放内存', 'chunk')
    }
    
    this.loadedChunks[chunkId] = chunkData
    this.loadedChunksOrder.push(chunkId)
    
    return chunkData
  }
  
  // ========== 详情读取,暂时因为Vela OS上下文限制用不了，所以调用这个没啥用,待解决,读取逻辑直接在Detail.ux完成即可 ==========
  
  async loadDetail(id) {
  }
  
  // ========== 解析查询 ==========
  
  _parseQuery(query) {
    var trimmed = query.trim()
    if (!trimmed) return []
    
    var hashes = []
    if (/^-?\d+$/.test(trimmed.replace(/\s/g, ''))) {
      return []
    }
    
    var words = trimmed.split(this.config.tokenizer.delimiters)
    var minPrefix = this.config.tokenizer.minEnglishPrefix
    
    for (var i = 0; i < words.length; i++) {
      var word = words[i]
      if (word.length === 0) continue
      if (/^[a-zA-Z]+$/.test(word)) {
        // v1.16.148：minPrefix 已降为 1，短英文查询本身有正确结果可命中，
        // 故移除 v1.16.147 的「跳过过短英文词」（那条是为绕开哈希碰撞的临时措施）。
        for (var j = minPrefix; j <= word.length; j++) {
          hashes.push(hashCode(word.substring(0, j).toLowerCase()))
        }
      } else {
        for (var k = 0; k < word.length; k++) {
          var ch = word[k]
          if (ch && ch.trim().length > 0) {
            hashes.push(hashCode(ch))
          }
        }
      }
    }
    
    var unique = []
    for (var m = 0; m < hashes.length; m++) {
      if (unique.indexOf(hashes[m]) === -1) unique.push(hashes[m])
    }
    return unique
  }
  
  _searchInChunk(chunkData, hash) {
    var bucketIndex = hash % this.bucketSize
    var bucket = chunkData.buckets[bucketIndex]
    return bucket || []
  }
  
  // ========== 年份搜索 ==========
  
  _searchByYear(year) {
    var targetYear = year
    var allIds = []
    var yearKey = targetYear.toString()
    
    if (this.yearToIds[yearKey]) {
      allIds = allIds.concat(this.yearToIds[yearKey])
    }
    
    var offset = 1
    var maxResults = this.config.search.yearMaxResults
    var rangeLimit = this.config.search.yearRangeLimit
    
    while (allIds.length < maxResults && offset <= rangeLimit) {
      var prevKey = (targetYear - offset).toString()
      var nextKey = (targetYear + offset).toString()
      if (this.yearToIds[prevKey]) {
        allIds = allIds.concat(this.yearToIds[prevKey])
      }
      if (this.yearToIds[nextKey]) {
        allIds = allIds.concat(this.yearToIds[nextKey])
      }
      offset++
    }
    
    return allIds
  }
  
  // ========== 关键词搜索 ==========
  
  async _searchKeyword(query) {
    var hashes = this._parseQuery(query)
    if (hashes.length === 0) return []
    _logInfo('关键词搜索: ' + query + ', 哈希数=' + hashes.length, 'search')
    
    var neededChunks = {}
    for (var h = 0; h < hashes.length; h++) {
      var hash = hashes[h]
      var bucketIndex = hash % this.bucketSize
      var chunkId = this._getChunkIdByBucketIndex(bucketIndex)
      if (chunkId !== -1) neededChunks[chunkId] = true
    }
    
    _logInfo('需要加载的块: ' + Object.keys(neededChunks).join(','), 'search')
    
    var chunkIds = Object.keys(neededChunks).map(Number)
    // v1.16.120 修复「多块求交静默吞结果」（审查报告 #3）：候选块数可能超过 LRU 上限
    // （maxLoadedChunks=2），先加载的块会被后加载的挤掉 → 下面求交读 this.loadedChunks[id]
    // 得 undefined → candidateSet 被清空 = 假「无结果」。本次查询期间临时把上限抬到候选
    // 块数（通常 2~4 块，短暂驻留），查完立即还原 —— 不改变常驻内存策略。
    // v1.16.124 审查建议#2：并发搜索会互相覆盖 —— A 存2抬到4、B 存4抬到6、A 还原2、B 还原4
    // → 常驻上限被永久改成 4。加所有权标记：仅当抬升后的值仍属本次调用时才还原。
    var _savedMaxChunks = this.maxLoadedChunks
    var _raisedTo = -1
    if (chunkIds.length > _savedMaxChunks) { this.maxLoadedChunks = chunkIds.length; _raisedTo = chunkIds.length }
    for (var c = 0; c < chunkIds.length; c++) {
      var chunkData = await this._ensureChunk(chunkIds[c])
      if (!chunkData) {
        delete neededChunks[chunkIds[c]]
        _logWarn('块 ' + chunkIds[c] + ' 加载失败，从候选中移除', 'search')
      }
    }
    
    var candidateSet = new Set()
    var firstHash = hashes[0]
    var firstBucketIndex = firstHash % this.bucketSize
    var firstChunkId = this._getChunkIdByBucketIndex(firstBucketIndex)
    
    if (firstChunkId !== -1 && neededChunks[firstChunkId] !== undefined) {
      var firstChunk = this.loadedChunks[firstChunkId]
      if (firstChunk) {
        var firstIds = this._searchInChunk(firstChunk, firstHash)
        for (var i = 0; i < firstIds.length; i++) {
          candidateSet.add(firstIds[i])
        }
        _logInfo('首轮候选数: ' + candidateSet.size, 'search')
      }
    }
    
    for (var h = 1; h < hashes.length; h++) {
      var hash = hashes[h]
      var bucketIndex = hash % this.bucketSize
      var chunkId = this._getChunkIdByBucketIndex(bucketIndex)
      if (chunkId === -1 || neededChunks[chunkId] === undefined) {
        candidateSet = new Set()
        break
      }
      var chunk = this.loadedChunks[chunkId]
      if (!chunk) {
        candidateSet = new Set()
        break
      }
      var ids = this._searchInChunk(chunk, hash)
      var idSet = new Set(ids)
      var newSet = new Set()
      for (var id of candidateSet) {
        if (idSet.has(id)) newSet.add(id)
      }
      candidateSet = newSet
      if (candidateSet.size === 0) break
    }
    
    _logInfo('最终候选数: ' + candidateSet.size, 'search')
    // v1.16.124：仅当当前值仍等于本次抬升的值（期间无其他并发搜索改动过）才还原
    if (_raisedTo > 0 && this.maxLoadedChunks === _raisedTo) this.maxLoadedChunks = _savedMaxChunks
    return Array.from(candidateSet)
  }
  
  // ========== 主搜索接口 ==========
  
  async search(query, options) {
    var startTime = Date.now()
    var stepTimings = {}
    
    try {
      options = options || {}
      
      if (typeof global !== 'undefined' && global.addRuntimeLog) {
        global.addRuntimeLog('搜索: "' + query + '"', 'info')
      }
      
      if (!this.isReady) {
        // 懒初始化：首次搜索当场读 meta/年份索引并建缓存，失败才返回空（带 initFailed 供页面提示）
        var lazyOk = await this._lazyInit()
        if (!lazyOk) {
          return { results: [], total: 0, initFailed: true }
        }
      }
      
      var category = options.category !== undefined ? options.category : 'all'
      var region = options.region !== undefined ? options.region : 'all'
      var page = options.page || 1
      var pageSize = options.pageSize || this.config.search.pageSize
      
      var trimmed = query.trim()
      if (!trimmed) {
        return { results: [], total: 0 }
      }
      
      var candidateIds = []
      var isYearSearch = /^-?\d+$/.test(trimmed.replace(/\s/g, ''))
      
      var t0 = Date.now()
      if (isYearSearch) {
        var year = parseInt(trimmed.replace(/\s/g, ''), 10)
        candidateIds = this._searchByYear(year)
        var maxYearResults = this.config.search.yearMaxResults
        if (candidateIds.length > maxYearResults) {
          candidateIds = candidateIds.slice(0, maxYearResults)
        }
      } else if (this._searchState && this._searchState.key === (trimmed + '|' + category + '|' + region) && this._searchState.candidateIds) {
        // v1.16.72 审查修复（中#5）：同 query 翻页直接复用候选（不重复读 block 求交）
        candidateIds = this._searchState.candidateIds
      } else {
        candidateIds = await this._searchKeyword(trimmed)
        var maxKeywordResults = this.config.search.keywordMaxResults
        if (candidateIds.length > maxKeywordResults) {
          candidateIds = candidateIds.slice(0, maxKeywordResults)
        }
        if (this._searchState && this._searchState.key === (trimmed + '|' + category + '|' + region)) {
          this._searchState.candidateIds = candidateIds
        }
      }
      stepTimings['0_获取候选ID'] = Date.now() - t0
      
      if (!candidateIds || candidateIds.length === 0) {
        return { results: [], total: 0 }
      }
      

      // ===== 渐进式 map 加载（v1.16.60 主人优化）=====
      // 读完 block 求交得全部候选 id 后：
      //   ① 按候选的 map 归属统计落点，map 按命中数降序排行（mapRank）
      //   ② 首轮只加载【命中前 2 的 map】立即返回——读出来多少先显示多少（不凑满页）
      //   ③ 翻页（page 增大）时逐次多加载一个 map 再切片 =「点一次显示更多、读一次 map」
      //   total = 候选总数（block 求交已是全量命中，无需读 map 即可知）
      //   ④ 同 query 复用 _searchState（候选/mapRank/已加载进度），不重复求交
      var t1 = Date.now()
      var mapDistribution = {}
      var idsInMap = {}
      for (var i = 0; i < candidateIds.length; i++) {
        var id = candidateIds[i]
        var mapId = this._getMapIdById(id)
        if (mapId === -1) continue
        if (!mapDistribution[mapId]) {
          mapDistribution[mapId] = 0
          idsInMap[mapId] = []
        }
        mapDistribution[mapId]++
        idsInMap[mapId].push(id)
      }
      var mapRank = Object.keys(mapDistribution).map(Number)
        .sort(function(a, b) { return mapDistribution[b] - mapDistribution[a] })
      stepTimings['1_统计Map分布'] = Date.now() - t1

      if (mapRank.length === 0) {
        return { results: [], total: 0, allLoaded: true }
      }

      // 状态缓存：同 query+筛选条件复用（新搜索词到来时整体重建）
      var queryKey = trimmed + '|' + category + '|' + region
      var st = this._searchState
      var filtering = (region !== 'all' || category !== 'all')
      // 筛选激活时禁用渐进（未读 map 无法筛选）——直接标记"全部加载"走全量读
      if (!st || st.key !== queryKey) {
        var candidateTotal = 0
        for (var mk in idsInMap) candidateTotal += idsInMap[mk].length
        st = this._searchState = {
          key: queryKey,
          idsInMap: idsInMap,
          mapRank: mapRank,
          loadedMaps: {},
          loadedCount: 0,
          rows: [],            // [{id, mapId}] 已加载且通过筛选的行（map 排行序）
          candidateTotal: candidateTotal,
          candidateIds: candidateIds,   // v1.16.72 审查修复（中#5）：候选一并缓存（翻页复用）
          forceAll: filtering
        }
      }

      // 逐 map 加载（v1.16.136 总搜索提速，主人定案）：
      // · 首批（page=1）**最多 2 个 map** 且行数够 MIN_ENOUGH 条即停 —— 原实现要加载到够
      //   page*pageSize 条，首批常解析 3~6 个 map；6 集并行 = 十几个 map（各约 600 行
      //   JSON.parse）同时解析，正是「十几个卡片同时出来 + 卡顿」的来源。
      // · 翻页（page>1）放开上限，由「更多资料」按钮逐步补齐（用户可接受的渐进语义）。
      // · mapRank 已按候选数降序 → 解析的就是「条数最多的 map」。
      var t3 = Date.now()
      // v1.16.141：每批 6 条 —— MIN_ENOUGH 同步对齐（原值与「每批 N 条」曾多次脱节）
      var MIN_ENOUGH = 6
      var need = (page <= 1) ? MIN_ENOUGH : page * pageSize
      // v1.16.139（主人反馈「没有中途停止」的根因）：minMaps 原为 2 —— **每个集至少解析 2 个 map**，
      // 与凑够多少条无关；6 集就是 12 个 map（各约 600 行 JSON.parse）同时/连续解析。
      // 改为 1：先试 1 个 map，行数不够 need 时由下方 `st.rows.length < need` 自动继续加载 ——
      // 既保证「够就停」，也保留候选稀疏时的兜底。
      var minMaps = st.forceAll ? st.mapRank.length : 1
      // 首批兜底上限 4：正常情况「2 个 map 就够 4 条即停」（1 个 map 约 600 行、候选充足），
      // 只有候选稀疏时才继续 —— 与「最多两个 map」两条要求同时满足（硬限 2 会让稀疏查询不足 4 条）
      var maxMaps = st.forceAll ? st.mapRank.length : (page > 1 ? st.mapRank.length : 4)
      while (st.loadedCount < st.mapRank.length &&
             st.loadedCount < maxMaps &&
             (st.loadedCount < minMaps || st.rows.length < need)) {
        await this._loadNextMapIntoState(st, category, region, filtering)
      }
      stepTimings['2_加载Map' + st.loadedCount + '个'] = Date.now() - t3

      // 切片：从已加载行按页取（map 排行序稳定，翻页只追加不重排）
      var t5 = Date.now()
      var total = filtering ? st.rows.length : st.candidateTotal
      var start = (page - 1) * pageSize
      var end = Math.min(start + pageSize, st.rows.length)
      var results = []
      // v1.16.130（性能审查 T0②）：先把本页涉及的所有 Map 一次性载齐，再走纯内存切片。
      // 原实现是循环内逐条 `if (!map) await this._ensureMap(r.mapId)` —— 候选分散在 >2 个 map
      // 且翻深页时会来回淘汰重载（载 map3 → 挤掉 map1 → 要用 map1 → 重载 map1 → 挤掉 map2…），
      // 一次翻页触发多次重复 I/O 与 JSON.parse，表现为翻页偶发长顿。
      var _needMaps = {}
      for (var i0 = start; i0 < end; i0++) _needMaps[st.rows[i0].mapId] = true
      var _needIds = Object.keys(_needMaps)
      var _savedMaxMaps = this.maxLoadedMaps
      var _raisedMapsTo = -1
      if (_needIds.length > _savedMaxMaps) { this.maxLoadedMaps = _needIds.length; _raisedMapsTo = _needIds.length }
      for (var k0 = 0; k0 < _needIds.length; k0++) {
        var mid = Number(_needIds[k0])
        if (!this.mapData[mid]) await this._ensureMap(mid)
      }
      for (var i = start; i < end; i++) {
        var r = st.rows[i]
        var map = this.mapData[r.mapId]
        if (!map) continue
        var index = map.idToIndex ? map.idToIndex[r.id] : -1
        if (index === undefined || index === -1) continue
        results.push({
          _id: r.id,
          id: r.id,
          year: map.years[index],
          yearDisplay: this._formatYearDisplay(map.years[index]),
          regionId: map.regionIds[index],
          region: this.regionList[map.regionIds[index]] || '未知',
          categoryId: -1,
          category: '未知',
          title: map.titles[index],
          keywords: null,
          cause: null,
          impact: null
        })
      }
      // v1.16.130：还原 LRU 上限（所有权标记 —— 仅当值仍属本次抬升时才还原，防并发搜索互相覆盖）
      if (_raisedMapsTo > 0 && this.maxLoadedMaps === _raisedMapsTo) this.maxLoadedMaps = _savedMaxMaps
      stepTimings['5_构建结果'] = Date.now() - t5
      var allLoaded = st.loadedCount >= st.mapRank.length

      var elapsed = Date.now() - startTime
      stepTimings['总耗时'] = elapsed + 'ms'
      
      // 直接输出到日志界面
      if (typeof global !== 'undefined' && global.addRuntimeLog) {
        var logMsg = '搜索完成: ' + results.length + '/' + total + ' 条(已载map ' + st.loadedCount + '/' + st.mapRank.length + '), 耗时分解: '
        var parts = []
        for (var key in stepTimings) {
          parts.push(key + '=' + stepTimings[key])
        }
        global.addRuntimeLog(logMsg + parts.join(' | '), 'success')
      }
      
      return { results: results, total: total, allLoaded: allLoaded }
      
    } catch(e) {
      if (typeof global !== 'undefined' && global.addRuntimeLog) {
        global.addRuntimeLog('搜索异常: ' + e.message, 'error')
      }
      // v1.16.72 审查修复（低#13）：异常不当「已显示全部」（原 allLoaded:true 会把
      // 错误吞成正常空态）；false 让上层可区分（后续可加错误重试 UI）
      return { results: [], total: 0, allLoaded: false }
    }
  }

  // 渐进加载：把 mapRank 中的下一个 map 读入并收集其命中行到 st.rows
  // （v1.16.60：翻页逐 map 加载的核心；map 内预建 idToIndex 加速定位）
  async _loadNextMapIntoState(st, category, region, filtering) {
    var mapId = st.mapRank[st.loadedCount]
    if (mapId === undefined) return
    st.loadedCount++          // 先占位（失败也推进，避免死循环）
    st.loadedMaps[mapId] = true
    var map = await this._ensureMap(mapId)
    if (!map) return
    if (!map.idToIndex) {
      var idxMap = {}
      for (var k = 0; k < map.ids.length; k++) idxMap[map.ids[k]] = k
      map.idToIndex = idxMap
    }
    var ids = st.idsInMap[mapId] || []
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i]
      var index = map.idToIndex[id]
      if (index === undefined) continue
      if (filtering) {
        var pass = true
        if (region !== 'all' && this.regionList[map.regionIds[index]] !== region) pass = false
        // ⚠️ category 筛选暂放行（审查低#9）：loadDetail 为空实现，启用会导致恒 0 结果；
        // 真要启用 category 筛选前必须先实现 loadDetail
        if (pass && category !== 'all' && this.categoryList.length > 0) {
          pass = true   // TODO: 实现 loadDetail 后改为真实过滤
        }
        if (!pass) continue
      }
      st.rows.push({ id: id, mapId: mapId })
    }
  }
  
  // ========== 获取完整文档 ==========
  
  async getDoc(id) {
    if (id < 0) {
      return null
    }
    if (!this.isReady) {
      var lazyOk = await this._lazyInit()
      if (!lazyOk) return null
    }
    if (id >= this.totalCount) {
      return null
    }
  
    // 1. 找到 ID 属于哪个 Map
    var mapId = this._getMapIdById(id)
    if (mapId === -1) {
      return null
    }
  
    // 2. 确保 Map 已加载
    if (!this.mapData[mapId]) {
      await this._ensureMap(mapId)
    }
  
    // 3. 从 Map 中查具体数据
    var info = this._getMapInfoByIdSync(mapId, id)
    if (!info) {
      return null
    }
  
    return {
      id: id,
      year: info.year,
      yearDisplay: this._formatYearDisplay(info.year),
      regionId: info.regionId,
      region: this.regionList[info.regionId] || '未知',
      title: info.title,
      // 以下字段留空，由详情页自己从 detail 文件补
      cause: null,
      impact: null
    }
  }
  
  
  getDocSync(id) {
    var mapId = this._getMapIdById(id)
    if (mapId === -1) return null
  
    if (!this.mapData[mapId]) return null
  
    var info = this._getMapInfoByIdSync(mapId, id)
    if (!info) return null
  
    return {
      id: id,
      year: info.year,
      yearDisplay: this._formatYearDisplay(info.year),
      regionId: info.regionId,
      region: this.regionList[info.regionId] || '未知',
      title: info.title,
      cause: null,
      impact: null
    }
  }
  
  // 同步版本，用于 getDocSync（不加载 Map，只返回已有数据）
  _getMapInfoByIdSync(mapId, id) {
    var map = this.mapData[mapId]
    if (!map) return null
    
    // ========== 新增：同步访问时也更新访问顺序（LRU 友好） ==========
    var idx = this.loadedMapsOrder.indexOf(mapId)
    if (idx > -1) {
      this.loadedMapsOrder.splice(idx, 1)
      this.loadedMapsOrder.push(mapId)
    }
    
    var ids = map.ids
    var left = 0
    var right = ids.length - 1
    
    while (left <= right) {
      var mid = Math.floor((left + right) / 2)
      if (ids[mid] === id) {
        return {
          year: map.years[mid],
          regionId: map.regionIds[mid],
          title: map.titles[mid]
        }
      } else if (ids[mid] < id) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }
    return null
  }
  
  // ========== 辅助方法 ==========
  
  getTotalCount() { return this.totalCount }
  getRegionList() { return this.regionList }
  getCategoryList() { return this.categoryList }
  getConfig() { return this.config }
  getVersion() { return this.config.version }
  getMapChunkSize() {
    return this.mapChunkSize
  }
  
  getCacheStats() {
    return {
      totalChunks: this.chunks.length,
      loadedChunks: Object.keys(this.loadedChunks).length,
      totalCount: this.totalCount,
      bucketSize: this.bucketSize,
      mapCount: Object.keys(this.mapData).length
    }
  }
  
  async clearChunkCache() {
    try {
      var storage = require('@system.storage')
      for (var i = 0; i < this.chunks.length; i++) {
        var key = this._getChunkCacheKey(i)
        try { storage.delete({ key: key }) } catch(e) {}
      }
      this.loadedChunks = {}
      this.loadedChunksOrder = []   // v1.16.120：同步清 LRU 顺序表（否则留幽灵 id，淘汰顺序失真）
      _logSuccess('所有块缓存已清除', 'cache')
    } catch(e) {
      _logError('清除缓存失败: ' + e.message, 'cache')
    }
  }
  
  async clearMapCache() {
    try {
      var storage = require('@system.storage')
      for (var i = 0; i < this.maps.length; i++) {
        var key = this._getMapCacheKey(i)
        try { storage.delete({ key: key }) } catch(e) {}
      }
      this.mapData = {}
      this.loadedMapsOrder = []   // v1.16.120：同上
      _logSuccess('所有Map缓存已清除', 'cache')
    } catch(e) {
      _logError('清除Map缓存失败: ' + e.message, 'cache')
    }
  }
}

var instance = null

function getSearchEngine() {
  if (!instance) {
    instance = new SearchEngine()
  }
  return instance
}

// 缓存版本号独立导出：首次加载判断/预热标记比对用（免建引擎实例）
var CACHE_VERSION = C.cache.version
export { SearchEngine, getSearchEngine, CACHE_VERSION }