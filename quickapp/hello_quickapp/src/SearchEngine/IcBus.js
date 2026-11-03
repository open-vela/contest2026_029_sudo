// IcBus —— interconnect 入站消息的**唯一持有者 + 多订阅者分发**
//
// ============================================================================
// 为什么必须这样写（2026-11-03 真机实锤，v1.16.435）
// ============================================================================
// `conn.onmessage` 是**只有 setter 的访问器属性**：
//   · 赋值 `conn.onmessage = fn`  → setter 把 fn 注册进原生层，**成功**
//   · 读回 `conn.onmessage`       → getter 没实现，**恒为 undefined**
//
// 这个特性直接判死了旧架构。旧代码靠「把上一个 handler 存下来再转发」串起
// AssistantEngine 与 BtTransfer：
//     var prevHandler = conn.onmessage      // ← 恒 undefined
//     conn.onmessage = function (data) { ...; prevHandler(data) }
// 于是后绑的那个模块读不到前者、也就永远不转发，链路静默断在中间。
// 真机诊断精确复现：直接赋值后 bt=4（框架确实投递到了 BtTransfer），
// 但 noprev=4、fwd=0、rx=0 —— 帧到了第一站就没了。
//
// 同一个坑还有第二个面：我曾把「读回是 undefined」误判成「赋值失败」，
// 于是上 `Object.defineProperty` 覆盖成普通数据属性 —— 那就**绕过了 setter**、
// 原生层根本没注册，框架一次都不投递（bt=0、rx=0、op=0）。
// 所以：**必须用普通赋值，且绝不能用读回值判断成败。**
//
// 本模块把「唯一持有 conn.onmessage」这件事收拢到一处，
// 其他模块通过 on() 订阅，谁也不碰 conn.onmessage。这样：
//   · 只有一处赋值，不存在互相覆盖
//   · 不依赖读回值，不存在转发链断开
//   · 订阅者增减不影响彼此，顺序确定（按注册先后）
// ============================================================================
'use strict'

var _conn = null        // 当前持有 onmessage 的 conn 对象
var _subs = []          // [{ name, fn }]
var _rx = 0             // 入站帧计数（诊断用）
var _last = ''          // 最近一帧（诊断用）
var _dispatching = false

/**
 * 取得 interconnect 的 conn 并安装分发器。
 * 幂等：同一对象重复调用不会重复安装（但会确认 onmessage 仍是我们的——不靠读回，
 * 靠「本模块自己记录的 _conn 是不是同一个对象」判断）。
 *
 * @param {object} conn   interconnect.instance() 的返回值
 * @returns {boolean}     是否成功安装（或已安装）
 */
function attach(conn) {
  if (!conn) return false
  if (_conn === conn) return true      // 已装过同一个对象
  _conn = conn
  try {
    // ★ 必须普通赋值 + 不看读回值（读回恒 undefined，见文件头）
    conn.onmessage = function (data) {
      _rx++
      try { _last = (typeof data === 'string') ? data.slice(0, 40) : 'obj' } catch (e) {}
      // 重入保护：某个订阅者在回调里又触发了入站（理论上不会，防框架重投）
      if (_dispatching) return
      _dispatching = true
      try {
        for (var i = 0; i < _subs.length; i++) {
          try { _subs[i].fn(data) } catch (e) {}
        }
      } finally {
        _dispatching = false
      }
    }
    return true
  } catch (e) {
    return false
  }
}

/**
 * 订阅入站消息。同一 name 重复订阅会覆盖（便于模块热重置）。
 * @param {string}   name  订阅者标识（排查用）
 * @param {function} fn    回调，参数与 conn.onmessage 一致
 */
function on(name, fn) {
  if (typeof fn !== 'function') return
  for (var i = 0; i < _subs.length; i++) {
    if (_subs[i].name === name) { _subs[i].fn = fn; return }
  }
  _subs.push({ name: name, fn: fn })
}

/** 取消订阅 */
function off(name) {
  for (var i = _subs.length - 1; i >= 0; i--) {
    if (_subs[i].name === name) _subs.splice(i, 1)
  }
}

/** 诊断快照：入站帧数、最近一帧、订阅者名单 */
function diag() {
  var names = []
  for (var i = 0; i < _subs.length; i++) names.push(_subs[i].name)
  return { rx: _rx, last: _last, hasConn: !!_conn, subs: names.join('|') }
}

module.exports = { attach: attach, on: on, off: off, diag: diag }
