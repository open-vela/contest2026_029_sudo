// BtTransfer.js —— 蓝牙动态资料集接收器（v1.16.46 主人需求）
// ─────────────────────────────────────────────────────────────────
// 【触发逻辑】应用级全局生效：app.ux onCreate 调 initBtReceiver() 挂 interconnect
// 监听，任何界面收到传输都会触发（不是特定页面触发）。
//
// 【传输协议】（手机 App / ble_tools → 手环 interconnect onmessage，JSON 文本帧）：
//   {t:'ds-begin', ds:'<集目录名>', name:'<显示名>', total:<文件数>}
//   {t:'ds-chunk', ds, f:'<文件名>', i:<分片号>, last:0|1, data:'<文本片段>'}   // 大文件分片拼装
//   {t:'ds-end',   ds}                                                        // 全部就绪 → 触发加载
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

var receiving = null // { ds, name, total, files: {fname: {chunks:{i:data}, got, last}} }

// v1.16.66 传输状态（主人需求：专门蓝牙传输界面）：
// 供 pages/btransfer 轮询显示——phase: idle/receiving/saving/done/error/aborted
var transfer = { phase: 'idle', ds: '', dsId: '', name: '', total: 0, done: 0, currentFile: '', error: '' }
function getTransferState() { return transfer }
function _resetTransfer() { transfer = { phase: 'idle', ds: '', dsId: '', name: '', total: 0, done: 0, currentFile: '', error: '' } }
var registered = false

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

// 处理一条 interconnect 消息（JSON 帧，见头部协议）
// ⚠️ 消息形态双兼容（审查修复）：官方互联层可能以 {data:'<json>'} 包装投递
//（AssistantEngine 即按 data.data 解析），也可能直接投递裸字符串/对象——
// 两种形态都兜住，真机联调无需再改。
function handleMessage(data) {
  var payload = data
  if (data && typeof data === 'object' && typeof data.data === 'string') payload = data.data
  var msg
  try { msg = typeof payload === 'string' ? JSON.parse(payload) : payload } catch (e) { return }
  if (!msg || !msg.t) return

  if (msg.t === 'ds-begin') {
    // v1.16.120：尊重「设置 → 蓝牙接收」开关（此前只写不读 = 假开关，审查报告 #2）。
    // undefined 视为开启（保持默认行为不变）；关闭时直接忽略，不跳传输页。
    var _btAllowed = true
    try { if (typeof global !== 'undefined' && global.bluetoothReceive === false) _btAllowed = false } catch (e) {}
    if (!_btAllowed) { _log('蓝牙接收已关闭，忽略 ds-begin: ' + msg.ds); return }
    receiving = { ds: String(msg.ds || ''), name: String(msg.name || msg.ds || ''), total: msg.total || 0, files: {}, okCount: 0, failCount: 0 }
    // 进入专门传输界面（无退出入口，只能手机端停止或传完）
    transfer = { phase: 'receiving', ds: receiving.ds, dsId: '', name: receiving.name, total: receiving.total, done: 0, currentFile: '', error: '' }
    try { require('@system.router').replace({ uri: '/pages/btransfer' }) } catch (e) {}
    _log('开始接收资料集: ' + receiving.ds + '（' + receiving.total + ' 个文件）')
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
      var DatasetManager = require('./DatasetManager.js')
      var dsObj = DatasetManager.registerDynamicDataset({ dirName: ds, name: name })
      transfer.phase = 'done'
      transfer.dsId = String(dsObj.id)
      transfer.done = declared > 0 ? okTotal : (okTotal + names.length)
    }).catch(function(e) {
      transfer.phase = 'error'
      transfer.error = '保存失败：' + (e && e.message ? e.message : '未知')
      _log('落盘失败: ' + (e && e.message), 'error')
    })
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

// 应用级监听（app.ux onCreate 调一次；重复调用幂等）
// ⚠️ 包装链（审查修复）：AssistantEngine 也在这条通道上设 conn.onmessage（语音/AI 真链路），
// 直接赋值会互相覆盖（后设者赢，另一模块静默失效）。此处保留原 handler 并转发，
// 无论设置顺序如何，两个模块都能收到消息。
function initBtReceiver() {
  if (registered) return false
  try {
    var interconnect = require('@system.interconnect')
    var conn = interconnect.instance()
    var prevHandler = conn.onmessage
    conn.onmessage = function(data) {
      try { handleMessage(data) } catch (e) { _log('消息处理异常: ' + (e && e.message), 'error') }
      // 转发给此前的监听者（如 AssistantEngine 的语音/AI 应答处理）
      if (typeof prevHandler === 'function') {
        try { prevHandler(data) } catch (e) {}
      }
    }
    registered = true
    _log('蓝牙资料接收器已就绪（应用级全局监听）', 'success')
    return true
  } catch (e) {
    _log('interconnect 不可用，接收器未启动（模拟器/无蓝牙环境自动静默）', 'warn')
    return false
  }
}

module.exports = { initBtReceiver: initBtReceiver, handleMessage: handleMessage, baseDir: baseDir, getTransferState: getTransferState }
