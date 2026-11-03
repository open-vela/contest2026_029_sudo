// BtTransfer.js —— 蓝牙动态资料集接收器（v1.16.46 主人需求）
// ─────────────────────────────────────────────────────────────────
// 【触发逻辑】应用级全局生效：app.ux onCreate 调 initBtReceiver() 挂 interconnect
// 监听，任何界面收到传输都会触发（不是特定页面触发）。
//
// 【传输协议】（手机 App / ble_tools → 手环 interconnect onmessage，JSON 文本帧）：
//   {t:'ds-begin', ds:'<集目录名>', name:'<显示名>', total:<文件数>}
//   {t:'ds-chunk', ds, f:'<文件名>', i:<分片号>, last:0|1, data:'<文本片段>'}   // 大文件分片拼装
//   {t:'ds-end',   ds}                                                        // 全部就绪 → 触发加载
//   {t:'ds-icon',  ds, name:'<显示名>', b64:'<PNG base64>'}                     // （v1.16.454）资料集图标
//                                                                             //   须在 ds-end 之前发；写入
//                                                                             //   internal://files/datasets/<ds>/icon.png
//
// 【主界面图标配置协议】（v1.16.252 cfg 族，同通道同 onmessage，t 字段路由，单帧不分片）：
//   {t:'cfg-query'}                                     // 手机拉取现状
//   → 回 {t:'cfg-state', ok, cur, installed:[{ds,name}], capacity:{pill:2,rect:4,max:6}}
//   {t:'cfg-home', ver:<递增>, icons:[{ds:'<入口标识>'}]}  // 下发有序配置（空数组=恢复默认）
//   → 回 {t:'cfg-ack', ok:true, ver} / {t:'cfg-ack', ok:false, ver, err:'BAD_JSON|BAD_VER|BAD_DS|TOO_MANY|BAD_FIELD|STORE_FAIL | 说明'}
//   手环渲染按形态取前 N（胶囊 2 / 方屏 4），icons[].name/icon/color 手环忽略（以 entry 为准）。
//   存储：@system.storage key='home_icon_config'，值=JSON{ver,icons}；启动时读入 global.homeIconCfg。
// 引擎所需完整文件集：meta.txt + map_N.txt + detail_N.txt + block_0.txt（见 docs/资料拆分指南.md）。
//
// 【落盘位置】internal://files/datasets/<ds>/ —— @system.file 沙箱，运行时可写可读；
// /common/ 是 rpk 打包只读资源目录，运行时不可写，所以蓝牙集必须落沙箱。
// 引擎按 basePath 读文件，沙箱 URI 直接可用（DatasetManager ds.baseUri 支持）。
//
// 【加载触发】ds-end 收齐 → registerDynamicDataset 注册（全局生效，搜索/详情立即可达）
// → router.replace('/pages/loading?source=bt&ds=<ds>') → loading 页【只】对该集
// 建缓存（_lazyInit + _ensureMap + _ensureChunk），不跑历史集 init、不跑全量预热。
'use strict'

var receiving = null // { ds, name, total, files: {fname: {chunks:{i:data}, got, last}}, icon: '<b64>' }

// v1.16.66 传输状态（主人需求：专门蓝牙传输界面）：
// 供 pages/btransfer 轮询显示——phase: idle/receiving/saving/done/error/aborted
// ★ v1.16.454：「收藏」入口在配置里的保留键（虚拟入口，不是资料集）
var FAV_KEY = '__fav__'
var FAV_ICON_DEFAULT = '/common/icons/bookmark.png'

var transfer = { phase: 'idle', ds: '', dsId: '', name: '', total: 0, done: 0, currentFile: '', error: '' }
function getTransferState() { return transfer }
function _resetTransfer() { transfer = { phase: 'idle', ds: '', dsId: '', name: '', total: 0, done: 0, currentFile: '', error: '' } }
// ★★★ v1.16.396（2026-11-01 真机取证）：原为布尔 `registered`，一旦 true 就永不重绑。
//   而 AssistantEngine 的 ping 超时分支会把 `self.conn` 置空并重新 `instance()`
//   （AssistantEngine.js:263 `self.conn = null`）—— 新 conn 是**另一个对象**，
//   BtTransfer 的 onmessage 还挂在已死的旧对象上 → cfg-query 帧到了、ping 照常往返，
//   但 `handleCfg` 永远不被调用（真机现象：23:17:30 成功一次，之后再不复现）。
//   修法：记住「绑到了哪个 conn 对象」，与当前 instance() 不同就重绑。
// ★★★ v1.16.409（2026-11-02 真机回归修复）：**改用「我是不是最外层监听者」判断，不再比较对象身份。**
//
// 我此前用的是 `if (_boundConn === conn) return true`（v1.16.396），
// 结果挡掉了一个必要动作：
//   · app.ux 先 initBtReceiver → BtTransfer 成为外层（prev = 框架原始）
//   · 心跳 tick → probe() → _bindReal(conn) → AssistantEngine 成为外层（prev = BtTransfer）
//   · probe() 里再调 initBtReceiver()，本意是「重新绑回外层，让 cfg 先被本模块处理」，
//     但因为对象还是同一个，被 `_boundConn === conn` 直接 return 掉了。
// 于是两个模块的监听器上下层关系不确定；更糟的是 instance() 若返回新对象，
// 会出现「AE 挂在 A 上、BT 挂在 B 上」——手机投递只到其中一个，
// 表现正是两个症状同时发生：手环收不到 pong（显示未连接）+ 收不到 cfg-query（图标功能失效）。
//
// 新判据只认一件事：**当前 conn.onmessage 是不是我自己**。
// 不是 → 重绑（把当前监听者存为 prev 并转发），保证最外层永远是本模块；
// 是   → 直接返回，天然幂等，不会叠加转发链。
var _btHandler = null      // 固定的外层 handler 引用，用于身份判断
var _btPrevHandler = null  // 重绑时接续下来的监听者
var _dispatching = false   // 分发重入保护（切断 BT↔AE 转发环）
var _conn = null // interconnect 连接引用（cfg-ack / cfg-state 回执发送用）
// ★★★ v1.16.435：入站统一由 IcBus 持有（见 IcBus.js 文件头）。
//   旧实现自己挂 conn.onmessage 并「保存上一个 handler 再转发」，
//   而 conn.onmessage 读回恒 undefined → prev 恒空 → 后绑的模块永远收不到帧。
//   真机诊断 noprev=4/fwd=0/rx=0 就是这条链断掉的直接证据。
var IcBus = null
try { IcBus = require('./IcBus.js') } catch (e) { IcBus = null }
// ★ v1.16.428：记录 onmessage 是靠哪种方式挂上的（1=defineProperty / 2=赋值 / 3=模块函数 / 0=全失败），
//   真机排障时从「接收器已就绪（方式=N）」一行就能看出平台认哪条路。
var _btBind = -1
var _btSubscribed = false   // v1.16.435：是否已订阅 IcBus（取代基于 conn.onmessage 读回的幂等判断）
// ★ v1.16.431 诊断计数（随 ping 帧经上行通道运回手机）
var _rxBt = 0        // 框架调到 _btHandler 的次数
var _rxBtLast = ''   // 最近一帧内容
var _rxFwd = 0       // 成功转发给 prev 的次数
var _rxFwdErr = 0    // 转发时抛异常的次数
var _rxNoPrev = 0    // 没有 prev 可转发的次数
var _rxDrop = 0      // 被重入保护丢掉的次数

// ★★★ v1.16.418（2026-11-02 模拟器实测）：**require 一次就缓存**。
//   实测（emulator-5554，60 秒去重 206 行）：每个心跳周期固定冒出 5 行 interconnect
//   日志，其中 4 行是两次 require 的框架查找痕迹，仅 1 行是真实的 send 失败：
//     [__app_require:106] Try find feautre in old manager: system.interconnect
//     [__app_require:69]  app_require feature: @app-module/system.interconnect
//     [__miwear_send:277] [interconnect] status is not connected, send failed
//     [FEATURE] [findFeature:727] can't find description for native feature …
//     [FEATURE] [findFeature:93]  can not find feature: system.interconnect
//   来源：AssistantEngine.probe() 一次 + 本文件 initBtReceiver() 一次（v1.16.388 由
//   probe 补调）。`@system.*` 是全局单例模块，重复 require 毫无收益，却每次都要走
//   整条 __app_require → findFeature 查找链并固定打印上面 4 行 —— 心跳 5s 一次，
//   等于每秒近 1 行纯框架噪声，业务层无法从自己的 console 关掉它。
//   缓存后每周期只剩 send 那 1 行（「蓝牙确实没连」的真实信号，应当保留）。
//   只缓存**成功**返回的模块对象；require 真抛异常时不缓存，下次照常重试。
var _icModule = null
function _getInterconnect() {
  if (_icModule) return _icModule
  _icModule = require('@system.interconnect')
  return _icModule
}

// ★★★ v1.16.420：数据分片帧的逐帧日志开关（默认关）。
//   背景：v1.16.388 加的「收到帧」诊断注释写的是「帧量很小（心跳 5s 一帧），可长期保留」——
//   这个假设对控制帧成立，对 `ds-chunk` 不成立：手机端按 MAX_CHUNK_BYTES = 4096 切片
//   （databank-companion/.../protocol/DsProtocol.kt:25）、paceMs = 60 逐帧发
//   （.../transfer/DatasetSender.kt:41），本仓 src/common/datasets/ 共 3,023,509 B
//   → 一次全量传输约 738 帧、历时约 44 秒、平均 16.7 帧/秒。
//   每帧原本要付：JSON.stringify(4KB 对象) 后切 60 字符 + console.log + addRuntimeLog。
//   控制帧（pong / cfg-* / ds-begin / ds-end 等）量极小，继续无条件打，排障信息不丢；
//   分片帧只在排障时手动把本开关改 true。
var DEBUG_FRAME = false

function _log(msg, level) {
  console.log('[BT-DS] ' + msg)
  try { if (typeof global !== 'undefined' && global.addRuntimeLog) global.addRuntimeLog('[蓝牙资料] ' + msg, level || 'info') } catch (e) {}
}

function baseDir(ds) {
  return 'internal://files/datasets/' + ds + '/'
}

// 单文件落盘（分片按序拼装后一次性 writeText）
function flushFile(ds, fname, parts) {
  return new Promise(function(resolve, reject) {
    try {
      var file = require('@system.file')
      var dir = baseDir(ds)
      file.mkdir({ uri: dir, recursive: true, success: function() {
        var body = ''
        var i = 0
        while (parts[i] !== undefined) { body += parts[i]; i++ }
        file.writeText({
          uri: dir + fname,
          text: body,
          success: function() { resolve() },
          fail: function(err, code) { reject(new Error('writeText fail code=' + code)) }
        })
      }, fail: function(err, code) { reject(new Error('mkdir fail code=' + code)) } })
    } catch (e) { reject(e) }
  })
}

// ★ v1.16.454：base64 → Uint8Array（手环端无内置 atob，AudioUp.js 里只有编码方向）
var _B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
var _B64_LOOKUP = null
function _b64Lookup() {
  if (_B64_LOOKUP) return _B64_LOOKUP
  var m = {}
  for (var i = 0; i < _B64_CHARS.length; i++) m[_B64_CHARS.charAt(i)] = i
  _B64_LOOKUP = m
  return m
}
function base64ToBytes(b64) {
  var m = _b64Lookup()
  var s = String(b64).replace(/[^A-Za-z0-9+\/=]/g, '')
  var pad = 0
  if (s.charAt(s.length - 1) === '=') pad++
  if (s.charAt(s.length - 2) === '=') pad++
  var outLen = Math.floor(s.length * 3 / 4) - pad
  var out = new Uint8Array(outLen)
  var o = 0
  for (var i = 0; i < s.length; i += 4) {
    var c0 = m[s.charAt(i)] || 0
    var c1 = m[s.charAt(i + 1)] || 0
    var c2 = m[s.charAt(i + 2)]
    var c3 = m[s.charAt(i + 3)]
    if (o < outLen) out[o++] = (c0 << 2) | (c1 >> 4)
    if (c2 !== undefined && o < outLen) out[o++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (c3 !== undefined && o < outLen) out[o++] = ((c2 & 3) << 6) | (c3 & 63)
  }
  return out
}

// 把资料集图标写成 internal://files/datasets/<ds>/icon.png
// 用 writeArrayBuffer（不是 writeText）——PNG 是二进制，writeText 会损坏字节。
function flushIcon(ds, b64) {
  return new Promise(function(resolve) {
    try {
      var file = require('@system.file')
      var dir = baseDir(ds)
      var bytes = base64ToBytes(b64)
      if (!bytes.length) { resolve(false); return }
      file.mkdir({ uri: dir, recursive: true, success: function() {
        file.writeArrayBuffer({
          uri: dir + 'icon.png',
          buffer: bytes,
          success: function() {
            _log('图标已落盘: icon.png（' + bytes.length + ' 字节）', 'success')
            resolve(true)
          },
          fail: function(err, code) {
            _log('图标落盘失败 code=' + code, 'error')
            resolve(false)
          }
        })
      }, fail: function(err, code) {
        _log('图标目录创建失败 code=' + code, 'error')
        resolve(false)
      } })
    } catch (e) {
      _log('图标落盘异常: ' + ((e && e.message) ? e.message : String(e)), 'error')
      resolve(false)
    }
  })
}

// 处理一条 interconnect 消息（JSON 帧，见头部协议）
// ⚠️ 消息形态双兼容（审查修复）：官方互联层可能以 {data:'<json>'} 包装投递
//（AssistantEngine 即按 data.data 解析），也可能直接投递裸字符串/对象——
// 两种形态都兜住，真机联调无需再改。
function handleMessage(data) {
  var payload = data
  if (data && typeof data === 'object' && typeof data.data === 'string') payload = data.data
  var msg
  try { msg = typeof payload === 'string' ? JSON.parse(payload) : payload } catch (e) { return }
  // ★★★ v1.16.388 诊断：确认本模块到底有没有收到帧。
  //   真机教训：`conn.send()` 的 success/send 返回 true **只代表 SDK 收下了帧**，
  //   不代表送到手环。而 pong 帧没有 `t` 字段，会在下一行静默 return ——
  //   于是「收到 pong」与「什么都没收到」在日志里长得一模一样，无法区分。
  //   这里把每帧的 type/t 与前 60 字符打出来。
  //   v1.16.420：原注释「帧量很小（心跳 5s 一帧），可长期保留」只对控制帧成立 ——
  //   `ds-chunk` 全量传输约 738 帧（见 DEBUG_FRAME 上方注释），逐帧 JSON.stringify 4KB
  //   + console.log 是纯浪费。改为：控制帧照常打，分片帧受 DEBUG_FRAME 控制。
  try {
    var _tag = (msg && (msg.t || msg.type)) || '(无 t/type)'
    // ★★★ v1.16.437（2026-11-03 00:35 真机）：**二进制帧一律不打内容**。
    //   audio 帧的 data 是 base64（一帧 4040B 起），旧实现把它整个塞进
    //   addRuntimeLog → 日志面板被 base64 乱码刷满，用户看到「一大堆乱码」。
    //   而且 audio 是**语音上传的热路径**（每 94ms 一帧），逐帧 stringify + 写日志
    //   本身也是实打实的性能浪费。
    //   pong 每 5s 一帧同样只关心类型，不打内容。
    var _quiet = (_tag === 'ds-chunk' && !DEBUG_FRAME) ||
                 _tag === 'audio' ||
                 _tag === 'pong' ||
                 _tag === 'ping'
    if (DEBUG_FRAME || !_quiet) {
      var _raw = (typeof payload === 'string') ? payload.slice(0, 60) : JSON.stringify(payload).slice(0, 60)
      _log('收到帧 t=' + _tag + ' : ' + _raw)
    }
  } catch (e) {}
  if (!msg || !msg.t) return

  // v1.16.252：主界面图标配置族（cfg-*）——见头部协议注释
  if (msg.t === 'cfg-query' || msg.t === 'cfg-home') {
    try { handleCfg(msg) } catch (e) { _log('cfg 处理异常: ' + (e && e.message), 'error') }
    return
  }

  if (msg.t === 'ds-begin') {
    // v1.16.120：尊重「设置 → 蓝牙接收」开关（此前只写不读 = 假开关，审查报告 #2）。
    // undefined 视为开启（保持默认行为不变）；关闭时直接忽略，不跳传输页。
    var _btAllowed = true
    try { if (typeof global !== 'undefined' && global.bluetoothReceive === false) _btAllowed = false } catch (e) {}
    if (!_btAllowed) { _log('蓝牙接收已关闭，忽略 ds-begin: ' + msg.ds); return }
    receiving = { ds: String(msg.ds || ''), name: String(msg.name || msg.ds || ''), total: msg.total || 0, files: {}, okCount: 0, failCount: 0, icon: '' }
    // 进入专门传输界面（无退出入口，只能手机端停止或传完）
    transfer = { phase: 'receiving', ds: receiving.ds, dsId: '', name: receiving.name, total: receiving.total, done: 0, currentFile: '', error: '' }
    try { require('@system.router').replace({ uri: '/pages/btransfer' }) } catch (e) {}
    _log('开始接收资料集: ' + receiving.ds + '（' + receiving.total + ' 个文件）')
  } else if (msg.t === 'ds-icon' && receiving && receiving.ds === String(msg.ds || '')) {
    // ★★★ v1.16.454（2026-11-04 宝宝报「传不了图标」）：
    //   原实现手机端 DatasetRepository 明确写着「二进制（icon.png）不发送」，
    //   协议里也没有承载图标的字段 → 动态资料集只能用 /common/datasets/bt/icon.png 占位，
    //   传进来的集永远显示同一个默认图标。
    //   现新增 ds-icon 帧：base64 承载 PNG（interconnect 只投递文本帧，二进制必须 base64）。
    //   ★ 必须在 ds-end 之前发 —— ds-end 里要用它决定 entry.icon。
    var b64 = String(msg.b64 || '')
    if (b64) {
      receiving.icon = b64
      if (msg.name) receiving.name = String(msg.name)
      _log('收到资料集图标: ' + receiving.ds + '（' + Math.round(b64.length * 3 / 4) + ' 字节）')
    }
  } else if (msg.t === 'ds-chunk' && receiving && receiving.ds === String(msg.ds || '')) {
    // v1.16.124 审查建议#7：文件名过滤，防止路径分隔符写出沙箱子目录
    var fname = String(msg.f || '').replace(/[\\/]/g, '_')
    if (!fname) return
    var rec = receiving.files[fname] || (receiving.files[fname] = { chunks: {}, got: 0, last: false })
    var idx = msg.i || 0
    if (rec.chunks[idx] === undefined) { rec.chunks[idx] = String(msg.data || ''); rec.got++ }
    transfer.currentFile = fname
    if (msg.last && !rec.last) {
      rec.last = true
      transfer.done++
      // 流式：收齐即落盘（审查中#7），从内存释放
      var dsNow = receiving.ds
      finalizeFile(dsNow, fname, rec).then(function(ok) {
        if (!receiving || receiving.ds !== dsNow) return
        if (ok) { receiving.okCount = (receiving.okCount || 0) + 1; delete receiving.files[fname] }
        else { receiving.failCount = (receiving.failCount || 0) + 1 }   // 保留记录：ds-end 补落 + 精确报错
      })
    }
  } else if (msg.t === 'ds-file' && receiving && receiving.ds === String(msg.ds || '')) {
    // 单帧整文件（小文件可不切片）。空文件名防护（审查修复）：空名会让后续
    // flushFile 对目录本身 writeText → 整批落盘失败
    var fname2 = String(msg.f || '').replace(/[\\/]/g, '_')   // v1.16.124 同 ds-chunk 路径过滤
    if (!fname2) return
    var rec2 = receiving.files[fname2] || (receiving.files[fname2] = { chunks: {}, got: 0, last: false })
    if (!rec2.last) {
      rec2.chunks[0] = String(msg.data || '')
      rec2.got = 1
      rec2.last = true
      transfer.done++
      transfer.currentFile = fname2
      var dsNow2 = receiving.ds
      finalizeFile(dsNow2, fname2, rec2).then(function(ok) {
        if (!receiving || receiving.ds !== dsNow2) return
        if (ok) { receiving.okCount = (receiving.okCount || 0) + 1; delete receiving.files[fname2] }
        else { receiving.failCount = (receiving.failCount || 0) + 1 }
      })
    }
  } else if (msg.t === 'ds-abort') {
    // 手机端主动停止（主人定案：传输中唯一退出途径）——回首页
    _log('手机端已停止传输', 'warn')
    receiving = null
    _resetTransfer()
    transfer.phase = 'aborted'
    try { require('@system.router').replace({ uri: '/pages/index' }) } catch (e) {}
  } else if (msg.t === 'ds-end' && receiving && receiving.ds === String(msg.ds || '')) {
    // v1.16.73 流式落盘：文件在收齐时已逐个落盘——这里只做清单校验 + 注册
    var ds = receiving.ds
    var name = receiving.name
    var files = receiving.files
    var declared = receiving.total || 0
    var iconB64 = receiving.icon || ''
    // ⚠️ 校验基准必须是「成功落盘数」而非 Object.keys(files).length（审查必修#1）：
    // 流式落盘下先完成的文件已被 delete，用存活键计数会必然误报「文件数不符」→ 拒绝注册。
    var okTotal = receiving.okCount || 0
    receiving = null
    var names = Object.keys(files)
    // 未落盘的残留（finalizeFile 失败/未触发的）在此补落重试
    var chain = Promise.resolve()
    var failed = []
    names.forEach(function(fn) {
      var rec0 = files[fn]
      if (rec0.chunks && rec0.got > 0) {
        chain = chain.then(function() {
          return finalizeFile(ds, fn, rec0).then(function(ok) { if (ok) okTotal++ ; else failed.push(fn) })
        })
      } else { failed.push(fn) }
    })
    chain.then(function(okAll) {
      if (declared > 0 && okTotal !== declared) {
        transfer.phase = 'error'
        transfer.error = failed.length
          ? ('有 ' + failed.length + ' 个文件未落盘(声明' + declared + '/成功' + okTotal + ')：' + failed.slice(0,3).join(' '))
          : ('文件数不符(声明' + declared + '/成功' + okTotal + ')')
        _log('落盘校验失败: 声明' + declared + '/成功' + okTotal + ' 未落盘' + failed.length, 'error')
        return
      }
      _log('全部落盘完成: internal://files/datasets/' + ds + '/', 'success')
      // ★ v1.16.388：改用 app.ux 挂的 global.registerDynamicDataset。
      //   原写法是运行时 require 相对路径的 DatasetManager，但打包器把它当静态依赖，
      //   于是凡引用了本文件的页面（index → AssistantEngine → BtTransfer）
      //   都会连带内联整个 DatasetManager→SearchEngine 闭包（首页那 267KB 重复副本的成因）。
      //   registerDynamicDataset 是纯数据登记，无时序依赖，走 global 完全等价。
      //   ⚠️ 注释里也不要再写出那个相对 require 的完整字面量：打包器的依赖扫描是文本级的。
      // ★ v1.16.454：先落图标再注册 —— 注册时要把 icon 路径写进 entry，
      //   顺序反了首页会先拿默认图标渲染一帧。
      var iconPath = '/common/datasets/bt/icon.png'
      return flushIcon(ds, iconB64).then(function (iconOk) {
        if (iconOk) iconPath = 'internal://files/datasets/' + ds + '/icon.png'
        var dsObj = global.registerDynamicDataset({ dirName: ds, name: name, icon: iconPath })
        transfer.phase = 'done'
        transfer.dsId = String(dsObj.id)
        transfer.done = declared > 0 ? okTotal : (okTotal + names.length)
      })
    }).catch(function(e) {
      transfer.phase = 'error'
      transfer.error = '保存失败：' + (e && e.message ? e.message : '未知')
      _log('落盘失败: ' + (e && e.message), 'error')
    })
  }
}

// ===== 主界面图标配置（v1.16.252 cfg 族）=====
// 可放置于主界面的入口清单（与 index 页默认渲染同源：分组优先，回退资料集入口）
function _entriesForCfg() {
  var ge = (typeof global !== 'undefined') ? global.groupEntries : null
  var de = (typeof global !== 'undefined') ? global.datasetEntries : null
  return (ge && ge.length > 0) ? ge : (de || [])
}

function _entryKey(en) {
  return String((en.groupId !== undefined && en.groupId !== null) ? en.groupId : en.dsId)
}

// ★★ v1.16.394（2026-11-01，宝宝指正后回退）：**不要每次现取 instance()**。
//
// 复盘：v1.16.391 我怀疑「onCreate 缓存的 _conn 已失效」，于是每次发送前重新
// `require('@system.interconnect').instance()`。这个改法没有依据 —— SPP 时代
// （`AI_CONTEXT.md` #170，2026-10-30 19:16）cfg-query / cfg-home 双向真机跑通过，
// 当时手环端就是这份 BtTransfer.js（`git log -S"cfg-query"` 只命中 v1.16.292 引入，
// 此后该文件没有改动 cfg 逻辑），用的是 initBtReceiver 里缓存的 _conn。
// 所以「缓存的 conn 失效」这个假设与既有事实矛盾，属于把通道问题错记到对象上。
//
// 现在的处置：回到 SPP 时代验证过的形态（直接用 _conn），只保留一个兜底 ——
// _conn 为空时补取一次。真正的差异在通道（SPP vs SDK 的拉起与权限），不在这个对象。
// ★★★ v1.16.396：每次现取 instance()，并顺手保证「收发用的是同一个对象」。
//   原先缓存 `_conn` 不更新：AssistantEngine 在 ping 超时后会把 conn 置空重建
//   （AssistantEngine.js:263），此时缓存里的旧对象已死 —— 用它 send 的结果是
//   「send 返回成功、帧永远上不去」（正是真机上 cfg-query 17B 记了「已发帧」
//   却无人应答的原因之一）。instance() 是单例，现取开销可忽略。
function _resolveConn() {
  // ★★★ v1.16.408（2026-11-02 真机回归修复）：**回到 v1.16.395 的行为** —— 有缓存就返回缓存。
  //
  // 我把这里改成了「每次都 ic.instance() 现取，对象变了就重绑接收器」（v1.16.397），
  // 结果把 1.16.395 已跑通的 cfg 链路改坏了：
  //   `_cfgSend` 每发一帧都会调本函数（一帧 cfgp + 一帧 cfg-state = 两次），
  //   而 `instance()` 在 SDK 通道下并不保证每次返回同一个对象。
  //   一旦返回新对象，这里就 `_conn = cur` 并 `initBtReceiver()` 重绑 onmessage ——
  //   于是「发」用的对象不停换、「收」的监听器不停被换下来的旧对象接管，
  //   表现就是帧发出去了（send 成功）但对端收不到回应。
  // 教训：**发送路径不该承担接收器重绑的副作用**。重绑只在明确信号下做（probe 补调）。
  if (_conn) return _conn
  try {
    var ic = _getInterconnect()   // v1.16.418：改走模块级缓存，不重复 require
    var cur = ic.instance() || null
    if (cur) _conn = cur
    if (cur) return cur
  } catch (e) {}
  return _conn
}

// ★ data 必须传【对象】：框架会自动序列化成 JSON 文本送到手机。
//   传 JSON 字符串（JSON.stringify）会被框架 fail 回调拒绝、帧永远上不去
//   —— 2026-10-18 用自建探针应用 icprobe 实测实锤（string 形态 fail、object 形态 success）
function _cfgSend(obj) {
  // ★★★ v1.16.395（2026-11-01）：**对照实验**，一次定死「对象 vs 字符串」这个变量。
  //
  // 起因（宝宝指正）：SPP 时代 cfg 双向跑通过，手环端逻辑没改过 —— 那问题就该在
  //   通道差异上，而不是业务逻辑。翻 git 发现 SPP 时代能跑通的代码是：
  //     `_conn.send({ data: JSON.stringify(obj) })`   ← **字符串**
  //   而现在（为手环9 的 icprobe 结论改成了）：
  //     `_conn.send({ data: obj, success, fail })`    ← **对象 + 回调**
  //   项目铁律「data 必须传对象」来自手环 9 固件实测，但 S5 走的是 SDK 通道，
  //   两者是完全不同的投递层，不能直接套用。
  //
  // 因此同时发三条，看手机侧收到哪条就定性：
  //   cfgp-obj → 对象形态           cfgp-str → 字符串形态
  //   cfgp-cb  → 对象 + 带 success/fail 回调（现在的写法）
  // 结论无论哪条先到，都能把「投递形态」与「回调注册」两个假设分开。
  function raw(payload, label, withCb) {
    setTimeout(function () {
      try {
        var conn = _resolveConn()
        if (!conn) { _log('发送跳过(' + label + ')：拿不到实例', 'warn'); return }
        if (withCb) {
          conn.send({
            data: payload,
            success: function () { _log('送达(' + label + ')', 'success') },
            fail: function (res, code) { _log('失败(' + label + ') code=' + code + ' ' + (res && res.data ? res.data : ''), 'warn') }
          })
        } else {
          conn.send({ data: payload })
        }
      } catch (e) { _log('异常(' + label + '): ' + (e && e.message), 'warn') }
    }, 0)
  }
  var flat = { t: 'cfgp-obj', seq: 1 }
  raw(flat, 'obj', false)
  raw(JSON.stringify({ t: 'cfgp-str', seq: 1 }), 'str', false)
  raw({ t: 'cfgp-cb', seq: 1 }, 'cb', true)
  // 真正的 cfg-state 仍按现形态发（成功则手机端会解析成 CfgState）
  raw(obj, 'state', true)
}

function handleCfg(msg) {
  if (msg.t === 'cfg-query') {
    var installed = _entriesForCfg().map(function(en) { return { ds: _entryKey(en), name: en.name } })
    // ★★★ v1.16.454（2026-11-04）：把「收藏」作为**第 7 个可配置入口**一起下发给手机。
    //   宝宝要求「把收藏的图标也可以更换」——原来收藏项在 index.ux 的 visibleCats 里
    //   硬编码成 /common/icons/bookmark.png，配置里根本没有它 → 手机端看不到、换不了。
    //   现在用保留键 '__fav__' 暴露给配置面板（不与资料集的 dsId/groupId 冲突），
    //   手环端 _applyIconConfig 见到它即渲染收藏项、并按 cfg 里的 icon 换图。
    installed.push({ ds: FAV_KEY, name: '收藏', isFav: true })
    // ★ v1.16.392 二分：先发一个**最小扁平帧**，确认「这个模块到底能不能发出任何帧」。
    //   真机现状：handleCfg 被调用（有「收到帧 t=cfg-query」日志），但 _cfgSend 里
    //   success/fail/异常三条日志一条都不出 —— 连「拿不到实例」都没打。
    //   ping 帧能正常到手机，而 ping 是 AssistantEngine 用自己的 conn 发的。
    //   两者差异只在「哪个 conn 对象 + 帧结构」。先拆掉帧结构的干扰：
    //   发一个与 ping 同构的扁平帧，手机侧应看到 {t:'cfgp'}。
    _log('cfg-query 命中，_conn=' + (_conn ? '有' : '无') + ' installed=' + installed.length)
    _cfgSend({ t: 'cfgp', seq: 1 })
    _cfgSend({ t: 'cfg-state', ok: true, cur: (typeof global !== 'undefined' && global.homeIconCfg) || null, installed: installed, capacity: { pill: 2, rect: 4, max: 6 } })
    return
  }
  // cfg-home：校验 → storage 落盘 → 生效（脏标志 + 前台即时刷新钩子）→ 回执
  var ver = msg.ver
  var icons = msg.icons
  var curVer = (typeof global !== 'undefined' && global.homeIconCfg && global.homeIconCfg.ver) || 0
  var fail = function(code, extra) { _cfgSend({ t: 'cfg-ack', ok: false, ver: ver || 0, err: code + (extra ? (' | ' + extra) : '') }) }
  if (!Array.isArray(icons)) { fail('BAD_FIELD', 'icons 必须为数组'); return }
  if (typeof ver !== 'number' || ver <= curVer) { fail('BAD_VER', 'ver 必须大于当前 ' + curVer); return }
  if (icons.length > 6) { fail('TOO_MANY', '最多 6 个'); return }
  var byKey = {}
  _entriesForCfg().forEach(function(en) { byKey[_entryKey(en)] = en })
  for (var i = 0; i < icons.length; i++) {
    var k0 = icons[i] && String(icons[i].ds)
    // FAV_KEY 是虚拟入口（收藏），不在 byKey 里，单独放行
    if (k0 === FAV_KEY) continue
    if (!icons[i] || !byKey[k0]) { fail('BAD_DS', '未知资料集: ' + k0); return }
  }
  // v1.16.254 修复：去重（重复 ds 会渲染两个相同图标），保留首个出现的顺序
  var seen = {}
  var uniq = []
  icons.forEach(function(ic) {
    var k = String(ic.ds)
    if (!seen[k]) { seen[k] = true; uniq.push({ ds: k }) }
  })
  var cfgObj = { ver: ver, icons: uniq }
  // ★ v1.16.416 修复（模拟器实测 bug）：storage.set 的 success 回调在本机**稳定丢失**
  //   （5s 超时必触发，日志「storage.set 超时未回调」，但回读 storage 值已正确写入），
  //   而原实现把「更新 global + 刷新主界面」全放在 success 里 → 配置落盘成功却永不生效，
  //   手机端还会收到 STORE_FAIL 假失败回执。
  //   改为：**先无条件生效**（global 赋值 + 前台刷新 + cfg-ack 成功回执），storage.set
  //   只作为持久化副作用，回调只用于日志区分「已落盘 / 可能未落盘」。
  if (typeof global !== 'undefined') {
    global.homeIconCfg = cfgObj
    global.homeIconDirty = true
  }
  if (typeof global !== 'undefined' && typeof global._homeIconRefresher === 'function') {
    try { global._homeIconRefresher() } catch (e) {}
  }
  _cfgSend({ t: 'cfg-ack', ok: true, ver: ver })
  _log('主界面图标配置已生效: ver=' + ver + '，' + cfgObj.icons.length + ' 个（后台落盘中）', 'success')

  var settled = false
  var timer = setTimeout(function() {
    if (settled) return
    settled = true
    _log('storage.set 5s 未回调（本机已知现象）：配置已在内存生效，落盘结果未确认', 'warn')
  }, 5000)
  try {
    require('@system.storage').set({
      key: 'home_icon_config',
      value: JSON.stringify(cfgObj),
      success: function() {
        if (settled) return
        settled = true
        clearTimeout(timer)
        _log('图标配置已落盘: ver=' + ver, 'success')
      },
      fail: function(err, code) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        _log('图标配置落盘失败 code=' + code + '（内存已生效，重启后可能回默认）', 'error')
      }
    })
  } catch (e) {
    _log('图标配置落盘异常: ' + (e && e.message), 'error')
  }
}

// 单文件收齐即落盘并从内存释放（流式：审查中#7——原实现全部文件驻留内存到
// ds-end 才落盘，大资料集直接 OOM）。校验该文件分片连续（0..got-1 齐全）。
function finalizeFile(ds, fname, rec) {
  var missing = -1
  for (var ci = 0; ci < rec.got; ci++) {
    if (rec.chunks[ci] === undefined) { missing = ci; break }
  }
  if (missing !== -1) {
    _log('文件 ' + fname + ' 缺片#' + missing + '，拒绝落盘（请重新发送）', 'error')
    // v1.16.176（提交前审查修复 C4）：原实现只改 phase/error，没有终止传输 ——
    // 残留的 receiving 会让后续分片继续接收、ds-end 仍走校验与注册，
    // 甚至把 error 覆盖回 done（一边报错一边显示完成）。现显式终止本次传输。
    receiving = null
    transfer.phase = 'error'
    transfer.error = '资料 ' + fname + ' 传输不完整（缺片），请在手机端重发'
    return Promise.resolve(false)
  }
  return flushFile(ds, fname, rec.chunks).then(function() {
    _log('文件落盘: ' + fname + '（' + rec.got + ' 片）', 'success')
    return true
  }).catch(function(e) {
    _log('文件 ' + fname + ' 落盘失败: ' + (e && e.message), 'error')
    transfer.phase = 'error'
    transfer.error = '保存失败：' + fname
    return false
  })
}

// 应用级监听（app.ux onCreate 调一次；**可重试**，见下方 v1.16.388 说明）
// ⚠️ 包装链（审查修复）：AssistantEngine 也在这条通道上设 conn.onmessage（语音/AI 真链路），
// 直接赋值会互相覆盖（后设者赢，另一模块静默失效）。此处保留原 handler 并转发，
// 无论设置顺序如何，两个模块都能收到消息。
//
// ★★★ v1.16.388（2026-11-01 真机取证）：**必须可重试**。
//   故障现场：`app.ux:305` 的 onCreate 第一次调本函数时框架的 interconnect 往往还没就绪，
//   require 抛异常 → 落 catch → `registered` 保持 false，且此后【再无第二次调用】。
//   后果是这条回调链永久缺失：语音/心跳照常（走 AssistantEngine 自己的包装链），
//   但 **cfg-query / ds-* 帧没任何模块处理** —— 表现为「图标功能一律无反应」，
//   而链路看上去完全正常（ping/pong 一路通）。真机证据：`conn.log` 有
//   `已发帧 17B`（cfg-query 长度）却无 `cfg-state` 回帧，且手环 console 无一条 `[BT-DS]`。
//   → 本函数保持幂等，由 `AssistantEngine.probe()` 在 conn 真正就绪后补调一次。

// v1.16.416：启动读入手机下发的图标配置（无/坏 → global.homeIconCfg 为 null，主界面走默认）。
// 与监听器绑定解耦、只跑一次；原先内联在 initBtReceiver 的幂等 return 之后 → 第二次调用即跳过。
// ⚠️ 本机（Vela 模拟器 + 真机）@system.storage.get 的 success/fail **回调都可能完全丢失**
//    （实测：storage.set 5s 必超时但值已写入；storage.get 两回调皆无）。因此不能把「读到配置」
//    的唯一希望押在回调上 → 额外用 storage.get 的同步返回值（部分实现返回字符串）与
//    3 次重试（1.2s 间隔）兜底。三次都无回调就按「无配置」处理，不再阻塞启动。
// ★ 去重标记挂 global，不用模块级 var：本文件被 index 页与 btransfer 页各打包一份，
//   是**两个独立的模块实例**，各自的 var 不共享 → 会出现两次「已读入」重复日志与重复刷新。
var _iconCfgLoaded = false
var _iconCfgTries = 0
function _loadIconCfgOnce() {
  if (_iconCfgLoaded || (typeof global !== 'undefined' && global.__iconCfgLoaded)) return
  _iconCfgTries++
  var done = false
  function markDone() {
    _iconCfgLoaded = true
    try { if (typeof global !== 'undefined') global.__iconCfgLoaded = true } catch (e) {}
  }
  function apply(d) {
    if (done) return
    // ★ 回调时刻二次校验：index 与 btransfer 两份模块实例会在同一 tick 各发一次 storage.get，
    //   入口检查时两边都还没置位 → 必须在这里再判一次，否则回调回来时两边都会执行
    if (typeof global !== 'undefined' && global.__iconCfgLoaded) { done = true; return }
    done = true
    if (!d) {
      markDone()
      _log('图标配置: 无存储值，主界面走默认')
      return
    }
    markDone()
    try {
      global.homeIconCfg = JSON.parse(d)
    } catch (e) {
      global.homeIconCfg = null
      _log('图标配置解析失败: ' + (e && e.message), 'error')
      return
    }
    // 启动读取回调晚于 index.onInit 的 _applyIconConfig，置脏让 index 下次 onShow 补应用
    global.homeIconDirty = true
    _log('图标配置已读入: ver=' + (global.homeIconCfg && global.homeIconCfg.ver))
    // 主界面可能已在前台且不会再有 onShow → 立即刷新一次
    if (typeof global._homeIconRefresher === 'function') {
      try { global._homeIconRefresher() } catch (e) {}
      _log('图标配置已应用（前台刷新）')
    }
  }
  function retry() {
    if (done || _iconCfgLoaded) return
    if (_iconCfgTries >= 3) {
      markDone()
      _log('图标配置读取 3 次均无回调（本机 storage 回调丢失现象），主界面走默认', 'warn')
      return
    }
    setTimeout(function() { _loadIconCfgOnce() }, 1200)
  }
  try {
    var ret = require('@system.storage').get({
      key: 'home_icon_config',
      success: function(d) { apply(d) },
      fail: function() { retry() }
    })
    // 同步返回形态兜底（有实现直接给出 value）
    if (ret && typeof ret === 'string') apply(ret)
    else if (ret && ret.data !== undefined) apply(ret.data)
    else setTimeout(retry, 1500)
  } catch (e) {
    _log('图标配置读取异常: ' + (e && e.message), 'error')
    retry()
  }
}

function initBtReceiver() {
  try {
    var interconnect = _getInterconnect()   // v1.16.418：改走模块级缓存，不重复 require
    var conn = interconnect.instance()
    if (!conn) {
      _log('interconnect 实例为空，接收器延后重试（等 probe 补调）', 'warn')
      return false
    }
    _conn = conn
    // ★ v1.16.416 修复（模拟器实测 bug）：启动读配置原先放在幂等判据**之后**，
    //   而本函数在 app.ux 启动路径上被连调两次（第二次因 `conn.onmessage === _btHandler`
    //   直接 return true）→ 配置读取被整体跳过，`global.homeIconCfg` 永远 undefined，
    //   手机下发的图标配置只能靠 storage 落盘 + 重启才可能生效。
    //   改为独立的一次性读取，放在所有 return 之前，与监听器绑定解耦。
    _loadIconCfgOnce()
    // ★★★ v1.16.435：幂等判据改为「本模块是否已订阅 IcBus」，不再比较 conn.onmessage
    //   （读回恒 undefined，任何基于读回的判断都恒假）。
    if (_btHandler && _btSubscribed) return true
    if (!_btHandler) {
      // handler 只创建一次，身份恒定 —— 幂等判断要靠它
      _btHandler = function(data) {
        // ★ v1.16.431 诊断计数：区分「框架根本没调我们」与「调了但转发断了」。
        //   真机 rx 恒 0 且 btOwn=1，只有这两个计数器能判定到底断在哪一层。
        try { _rxBt = (_rxBt || 0) + 1; _rxBtLast = (typeof data === 'string') ? data.slice(0, 40) : 'obj' } catch (e) {}
        // ★ v1.16.435：不再需要「转发给 prev」与重入保护 —— IcBus 负责分发给所有订阅者，
        //   各订阅者互相独立，不存在 BT↔AE 的环。
        try { handleMessage(data) } catch (e) { _log('消息处理异常: ' + (e && e.message), 'error') }
      }
    }
    // ★★★ v1.16.428：onmessage 是**只读访问器属性**（真机实锤：赋值后立即读回 undefined），
    //   直接赋值静默失败 → 接收器看似「已就绪」其实一帧都收不到。
    //   按强度依次尝试，记录哪一种生效（bind 值会随日志打出来）。
    // ★★★ v1.16.435：交给 IcBus 统一持有 conn.onmessage，本模块只订阅。
    //   不再「保存上一个 handler 再转发」—— 那条路在 Vela 上根本不成立（读回恒 undefined）。
    if (IcBus && typeof IcBus.attach === 'function') {
      IcBus.attach(conn)
      IcBus.on('bttransfer', _btHandler)
      _btBind = 5
      _btSubscribed = true
    }
    _log('蓝牙资料接收器已就绪（IcBus 分发，订阅者含本模块）', 'success')
    return true
  } catch (e) {
    // ★ v1.16.388：这里原来只打「interconnect 不可用」，看不出是 require 失败还是
    //   instance() 失败 —— 而这两种的修法完全不同（前者等框架，后者等对端）。
    //   真机排障只有 console/内核日志一条路，所以把异常内容与字段名一起打出来。
    _log('接收器未启动：' + (e && e.message ? e.message : e), 'warn')
    return false
  }
}

// ★ v1.16.427：供 AssistantEngine 在诊断 ping 帧里报告「BT handler 是否仍在外层」
function isBtHandlerInstalled(conn) {
  if (!conn || !_btHandler) return false
  return conn.onmessage === _btHandler
}

function getRxDiag() {
  return {
    bt: _rxBt || 0, fwd: _rxFwd || 0, fwderr: _rxFwdErr || 0,
    noprev: _rxNoPrev || 0, drop: _rxDrop || 0, last: _rxBtLast || ''
  }
}

module.exports = {
  initBtReceiver: initBtReceiver,
  getRxDiag: getRxDiag,
  handleMessage: handleMessage,
  handleCfg: handleCfg,
  baseDir: baseDir,
  getTransferState: getTransferState,
  isBtHandlerInstalled: isBtHandlerInstalled
}
