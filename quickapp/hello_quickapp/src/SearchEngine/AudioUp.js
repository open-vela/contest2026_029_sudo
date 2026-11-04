/**
 * AudioUp —— 手表端录音与上传（流式版）
 *
 * ============================================================
 * 为什么是「流式帧回调」而不是「录到文件再读」
 * ============================================================
 * 官方给了两条录音路径：
 *
 *   A. 传 frameSize → 每录满一帧回调 record.onframerecorded(frameBuffer)
 *                     success 不再返回 uri，音频全部从回调拿到
 *   B. 不传 frameSize → success 返回 uri（internal://cache/audioXXXX.pcm），
 *                     录完再 readArrayBuffer 整段读
 *
 * ★★★ 2026-11-01 结论修正：A 路线在 S5 上完全可用，之前判死是探针自己的 bug。
 *
 * 曾经以为是「S5 不支持流式」，依据是 recprobe 探针报 `L3 结束判定: timeout(无帧无回调)`。
 * 真因在探针里这行：
 *     if (typeof rec.onframerecorded === 'function') { rec.onframerecorded = ... }
 * onframerecorded 是**事件属性**，注册前其值本来就是 undefined，typeof 判完就 false，
 * 于是回调从未注册，自然一帧都收不到。改成无条件赋值后实测（12:22:33）：
 *     L3 收到首帧 frame1 byteLength=640
 *     L3 结束判定: streaming frames=170 bytes=113280
 * 170 帧 / 113KB 全部正常到达 → A 路线成立，且比 B 路线好得多。
 *
 * B 路线每个环节都是坑（都是真机实测）：
 *   - record.stop() 在 S5 上会阻塞 JS 线程 0~15 秒（要等整段 PCM 落盘关句柄），
 *     期间声波动画停摆，系统判 ANR 强杀 —— 用户看到「语音条不动 + 应用卡退」。
 *   - readArrayBuffer 返回的 res.buffer 是「一字节一数字」的普通 JS 数组，
 *     要过 JS↔原生桥：3 秒 79360 字节能读，5 秒 160000 字节直接把线程卡死。
 *
 * A 路线把这两个坑全绕开：帧是引擎主动推上来的（每帧 640 字节），
 * 边收边发，全程没有 stop()、没有大文件读取、没有长阻塞。
 *
 * 上传节奏：640 字节一帧 ≈ 20ms 音频，若每帧发一次 = 每秒 50 次 send，
 * interconnect 扛不住（会堵）。所以内部再攒成 AUDIO_FRAME_BYTES = 3000 字节
 * 一片（≈94ms）才发一次，与手机端 AudioAssembler 约定一致。
 */

// ★★★ v1.16.452（2026-11-03 22:50）：改回官方默认的 8000Hz。
//
// 官方文档（@system.record）原文：
//   · `sampleRate` **默认 8000**，"建议使用 8000/16000/32000/44100/48000"
//   · 比特率参考表：16000Hz/单声道 = 256000 bp/s = **32000 B/s**
//
// 实测（手机 recv.log 的 audio_end.rawBytes ÷ 录音墙钟）：
//   4.35s → 29056B = 6680 B/s
//   6.03s → 39040B = 6474 B/s
// 只有 16000Hz 应有速率的 **21%**，且把 frameSize 从 640 改到 3200 完全不改变
// 这个速率（两版都是 ~6.7KB/s），说明瓶颈不在分片大小。
//
// 帧到达时间戳还证明 interconnect 不是瓶颈：结束瞬间 8 帧只用 263ms
// 发完（≈100KB/s），而中间 3.7 秒一帧都没有 —— 是**引擎没产出**，不是发不出去。
//
// 所以先按官方默认值 8000 试：数据量直接减半，若麦克风/引擎本就是 8k 档，
// 就能拿到 100% 覆盖；手机端再 2 倍上采样回 16k 喂给识别模型。
// ★★★ v1.16.453（2026-11-03 23:1x）最终定案：用官方默认的 8000Hz。
//
// 现场数据（全部来自手机 recv.log 的 audio_end.rawBytes ÷ 录音墙钟）：
//   正式代码（带 base64 + interconnect 发送）: 6400~7100 B/s
//   历史探针 recprobe（纯采集，无编码无发送）: 14160 B/s
//   官方文档 16000Hz/单声道应有值          : 32000 B/s
//
// 把两组实测换算成采样率：
//   14160 B/s ÷ 2 = 7080 采样/秒   ← 极其接近 8000（官方默认值）
//    6700 B/s ÷ 2 = 3350 采样/秒   ← 约 8000 的 42%，被 JS 处理拖走一半
//
// 结论：**引擎并不采纳我们传入的 sampleRate:16000，而是按默认 8000 在采。**
// 既然拿不到 16k，就接受 8000 并让手机端重采样回 16k（AsrEngine.kt:71 已支持
// 按 WAV 头自动 resample），同时数据量减半也让 JS 侧压力减半。
//
// 注意：不要把这里改回 16000 —— 那只会让「以为自己是 16k」的识别侧把音频
// 当成 2 倍速处理（流式路径写死 16k，尤其受影响）。
var AUDIO_SAMPLE_RATE = 8000
var AUDIO_FRAME_BYTES = 3000
// 录音时长上限。流式路线下这只是「最长录多久」，
// 真正的提前结束靠静音检测，所以可以给得比文件路线宽松。
var AUDIO_MAX_MS = 8000
// 停止说话多久算说完（毫秒）。实测自然语速句子间停顿 300~600ms，
// 800ms 既不会把一句话切两半，也不会让用户干等。
var AUDIO_SILENCE_MS = 900
// 每 20ms 一块算 RMS，峰值超过这个就当「说过话」。
// 正常说话 0.02~0.15，安静房间底噪 <0.005。
// 注意：这只是**下限**，实际阈值会按现场底噪自适应上调（见 voiceThreshold）。
var AUDIO_VOICE_RMS = 0.006
// ★ 一句话都没说就自动放弃的时间。
// 原来没有这一条：用户误触麦克风后要干等满 AUDIO_MAX_MS=8 秒才收到「没有听到声音」。
// 1.8 秒足够覆盖「点完麦愣一下再开口」的正常起手，又不会让人等得不耐烦。
var AUDIO_NOSPEECH_MS = 1800
// ★ v1.16.453：启动宽限。超过这个时间还一帧都没来 → 判「引擎没起来」，
//   与「起来了但没人说话」区分开（前者硬报占用，后者才说没听到声音）。
//   取 1200ms：正常情况首帧在 100ms 内就到，1200ms 足够覆盖启动抖动。
var AUDIO_START_GRACE_MS = 1200
// 已经在说话时的最长录制时间。到点就收，避免用户一直说、一直传、一直等。
var AUDIO_SPEECH_MAX_MS = 6000
// 自适应底噪：录开头几帧估一个环境噪声，说话阈值取「底噪 × 倍数」与下限的较大者。
// 这样在嘈杂处不会把噪声当人声，在安静处也不会因为阈值过高而「听不见」。
var AUDIO_NOISE_FRAMES = 5          // 用开头 5 帧（≈100ms）估底噪
var AUDIO_NOISE_FACTOR = 3.0        // 说话阈值 = 底噪 × 3
// ★★★ v1.16.383（用户反馈提的「没人声就别录，减小体积加快响应」）：
//   检出人声之前，只保留最近这么多毫秒的音频当「预热缓冲」。
//
//   为什么要留而不是一帧不留：人声开头（尤其清音 /p/ /t/ /k/、擦音 /s/ /f/）
//   能量很低，等 RMS 越过阈值那一刻，真正的字头已经过去几十甚至上百毫秒。
//   完全不留会把开头的字吃掉，识别出来变成「…库」而不是「资料库」。
//   300ms 足够覆盖这层损失，又远小于原来的「从头全留」。
//
//   省钱效果：点完麦到开口前的静音、以及说话中间的换气/思考空隙，
//   在首次检出人声之前**一帧都不上传**，只留这 300ms。
var AUDIO_PREROLL_MS = 300

function bytesToBase64(bytes) {
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  var len = bytes.length
  // ★★★ v1.16.451 性能修正（2026-11-03 22:04 实测定位）：
  //   原实现用字符串 `out += 'ABCD'` 拼接 —— 每帧 3000 字节 = 4000 字符，
  //   在 Vela 的 JS 引擎上字符串 += 会反复复制整串，单帧编码耗时高达数十毫秒，
  //   **直接把 record.onframerecorded 的回调节奏拖垮**，引擎等待期间丢弃音频：
  //     frameSize=640B(20ms)  实测回调间隔 90ms   → 采集率 22%
  //     frameSize=3200B(100ms) 实测回调间隔 469ms → 采集率 21%（比例不变！）
  //   两者比值恒为 ~4.5 倍，证明「回调间隔 = 我的处理耗时」，不是引擎的固定频率。
  //
  //   改为：先把 4 字符小块推进数组，最后一次 join —— 数组 push + join 只做
  //   一次大拼接，避免 O(n²) 的字符串复制。
  var parts = []
  var i = 0
  for (; i + 2 < len; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    parts.push(B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) +
               B64.charAt((n >> 6) & 63) + B64.charAt(n & 63))
  }
  var rest = len - i
  if (rest === 1) {
    var a = bytes[i] << 16
    parts.push(B64.charAt((a >> 18) & 63) + B64.charAt((a >> 12) & 63) + '==')
  } else if (rest === 2) {
    var b = (bytes[i] << 16) | (bytes[i + 1] << 8)
    parts.push(B64.charAt((b >> 18) & 63) + B64.charAt((b >> 12) & 63) +
               B64.charAt((b >> 6) & 63) + '=')
  }
  return parts.join('')
}

/**
 * 单块（16bit 小端）的平均 RMS，用于逐块判音量。**原地计算，不拷贝**。
 *
 * 为什么签名是 (bytes, from, to)：流式回调每 20ms 来一帧，若每帧先 `push` 进普通数组
 * 再算，每秒要做 64000 次 push + 64000 次数组下标读。真机上这类「逐字节 JS 循环」
 * 正是卡顿的来源。改成直接在原始类数组上按偏移算，一次遍历搞定。
 */
function frameRms(bytes, from, to) {
  var start = from || 0
  var end = (to === undefined || to === null) ? bytes.length : to
  var n = (end - start) >> 1
  if (n <= 0) return 0
  var sum = 0
  for (var i = 0; i < n; i++) {
    var lo = bytes[start + i * 2]
    var hi = bytes[start + i * 2 + 1]
    var v = (hi << 8) | lo
    if (v >= 32768) v -= 65536
    var f = v / 32768
    sum += f * f
  }
  return Math.sqrt(sum / n)
}

/**
 * 全段峰值 RMS：按 20ms（320 采样点 = 640 字节）分块，取各块最大值。
 * 为什么不用整体平均：用户点完麦克风常先愣一下再开口，起头静音会把整段平均拉低，
 * 从而误判「没有听到声音」。只要**任意一块**达到阈值就算说过话。
 */
function peakRms(arrayLike) {
  var len = (arrayLike && arrayLike.length) || 0
  if (!len) return 0
  var CHUNK = 640
  var best = 0
  for (var off = 0; off < len; off += CHUNK) {
    var end = off + CHUNK
    if (end > len) end = len
    var r = frameRms(arrayLike, off, end)
    if (r > best) best = r
  }
  return best
}

/**
 * 把一段类数组 PCM 切成 AUDIO_FRAME_BYTES 大小的片，逐片回调 onFrame(base64, index)。
 * 返回 { frames, bytes }。
 */
function emitFrames(arrayLike, onFrame) {
  var len = (arrayLike && arrayLike.length) || 0
  var frames = 0
  for (var off = 0; off < len; off += AUDIO_FRAME_BYTES) {
    var end = off + AUDIO_FRAME_BYTES
    if (end > len) end = len
    var slice = []
    for (var i = off; i < end; i++) slice.push(arrayLike[i])
    onFrame(bytesToBase64(slice), frames)
    frames++
  }
  return { frames: frames, bytes: len }
}

/**
 * ★★★ v1.16.438：录音会话串行化。
 *
 * S5 的 `@system.record` 是**单例引擎**，同一时刻只允许一个录音会话。
 * 真机链（2026-11-03 01:0x）：点麦克风 → 取消 → 立刻再点，
 * 新会话的 record.start 与上一会话的收尾撞车，结果一帧都收不到，
 * 界面统一报「没听见」。
 *
 * 处理：模块级记录当前活跃会话；下次 caputreVoice 时先硬停旧的，
 * 并保证与上次释放间隔 >= RELEASE_GAP_MS 再 start。
 */
var _activeSession = null
var _lastReleaseAt = 0
// ★ v1.16.453：从 300 提到 800。
//   原生 record.stop() 在 S5 上实测可能要几百毫秒才真正释放 socket；
//   300ms 太短，下一轮 start 仍会撞上未释放的引擎（表现为启动静默失败）。
var RELEASE_GAP_MS = 800
// 引擎被上一会话占用时 start 会被拒（S5 单例引擎）。
// ★ 真机 stop() 可能阻塞数秒，所以重试窗口按**时间预算**而不是次数：
//   只要还在 START_RETRY_BUDGET_MS 内就一直重试，超过才如实报错。
var START_RETRY_BUDGET_MS = 6000
var START_RETRY_GAP_MS = 250

function captureVoice(opts) {
  var onFrame = (opts && opts.onFrame) || function () {}
  var done = (opts && opts.done) || function () {}
  var log = (opts && opts.log) || function () {}

  var record = null
  try {
    record = require('@system.record')
  } catch (e) {
    done({ ok: false, reason: '本机不支持录音（record 模块不可用）' })
    return null
  }
  if (!record || typeof record.start !== 'function') {
    done({ ok: false, reason: '本机不支持录音（record.start 不是函数）' })
    return null
  }

  var st = {
    startedAt: 0,
    finished: false,
    // ★ 攒片缓冲改成「分段引用」而不是逐字节 push。
    //   原实现每 20ms 把 640 个字节逐个 push 进 pending，一秒 32000 次 push，
    //   收满后还要 splice(0, 3000) 搬移整个数组 —— 真机上这些逐字节 JS 循环
    //   就是「说完话界面卡一下」的来源。现在只存 (源数组, 起, 止) 三元组，
    //   到真正要发一帧时才做一次 3000 次遍历拼出整块。
    segs: [],
    pendingBytes: 0,
    frames: 0,
    bytes: 0,
    // ★ v1.16.450 诊断统计
    rawFrames: 0,
    rawBytes: 0,
    droppedFrames: 0,
    // ★ v1.16.383：检出人声前的预热缓冲（环形，只留最近 AUDIO_PREROLL_MS）
    preroll: [],
    prerollBytes: 0,
    // 音量与静音判定
    peak: 0,
    voiced: false,
    voicedAt: 0,
    lastVoiceAt: 0,
    // 自适应底噪：开头若干帧估环境噪声
    noiseSum: 0,
    noiseCount: 0,
    threshold: AUDIO_VOICE_RMS,
    timer: null,
    startTimer: null,
  }

  /** 已排队的异步 flush 句柄（一次 tick 只跑一次，合并多次请求） */
  var _flushTimer = null

  /**
   * 把 flush 推迟到下一个 tick 执行。
   *
   * 录音回调里调用它，让 `onframerecorded` 尽快返回 —— 引擎才会立刻回去采集，
   * 不会因为我们在同一个 tick 里编码 base64 而丢音频。
   * 用 busy 标志合并：连续多帧只触发一次 flush。
   */
  function scheduleFlush() {
    if (_flushTimer) return
    _flushTimer = setTimeout(function () {
      _flushTimer = null
      if (st.finished) return
      flush(false)
    }, 0)
  }

  /**
   * ★★★ v1.16.451 对照实验开关（临时）
   * true 时：flush 完全不编码、不发送，只把字节数累进 st.bytes。
   * 目的：录音回调里只剩一次 slice 拷贝，JS 侧负担降到最低。
   * 判据：若 rawBytes 从 ~6700B/s 跃升到 ~32000B/s（16kHz×2B），
   *       证明引擎一直在给 16kHz 数据、是我们处理太慢导致丢包；
   *       若仍是 ~6700B/s，证明引擎本身就以 ~3.2kHz 产出。
   */

  /** 把已攒够的整片发出去。 */
  function flush(force) {
    // ★★★ v1.16.453 关键修正（2026-11-03 23:1x）：
    //   原实现 `while (pendingBytes >= FRAME_BYTES)` 一次把**所有**积压帧都编码完。
    //   而积压本身就是「上一轮编码太慢」造成的 → 积压越多、这一轮阻塞越久、
    //   下一轮积压更多 —— 正反馈死循环，这解释了手机端看到的
    //   「中间 3.2 秒一帧都没有，最后 8 帧在 263ms 内全爆出来」。
    //
    //   修法：**一次只处理一帧**，处理完立刻 return，把控制权还给引擎去采集，
    //   下一 tick 再处理下一帧。宁可多发几个 tick，也不能长时间占着线程。
    var produced = false
    if (st.pendingBytes >= AUDIO_FRAME_BYTES) {
      // 拼出恰好一帧（3000 字节）。只有这里做一次遍历，其余时候全是引用。
      var out = []
      var need = AUDIO_FRAME_BYTES
      while (need > 0 && st.segs.length) {
        var s = st.segs[0]
        var avail = s.to - s.from
        var take = avail < need ? avail : need
        for (var i = 0; i < take; i++) out.push(s.src[s.from + i])
        if (take === avail) {
          st.segs.shift()
        } else {
          s.from += take
        }
        need -= take
      }
      st.pendingBytes -= AUDIO_FRAME_BYTES
      st.bytes += out.length
      onFrame(bytesToBase64(out), st.frames)
      st.frames++
      produced = true
    }
    // 还有积压 → 排一个 tick 继续，绝不在这里连做
    if (produced && st.pendingBytes >= AUDIO_FRAME_BYTES && !force) {
      scheduleFlush()
    }
    // 收尾时把尾巴也发出去（不足一片也算一帧）
    if (force && st.pendingBytes > 0) {
      var tail = []
      while (st.segs.length) {
        var t = st.segs.shift()
        for (var j = t.from; j < t.to; j++) tail.push(t.src[j])
      }
      st.pendingBytes = 0
      st.bytes += tail.length
      onFrame(bytesToBase64(tail), st.frames)
      st.frames++
    }
  }

  /** 收尾统一出口，只允许走一次。 */
  function finish(reason) {
    if (st.finished) return
    st.finished = true
    if (st.timer) { clearInterval(st.timer); st.timer = null }
    if (st.startTimer) { clearTimeout(st.startTimer); st.startTimer = null }
    // ★ v1.16.451：清掉挂起的异步 flush，否则收尾后它还会再跑一次 flush(false)
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }

    // ★★★ v1.16.453 真根因（2026-11-03 23:2x，独立诊断与代码核对）：
    //   **逻辑收尾后必须真正停掉原生录音，否则下一轮必然起不来。**
    //
    //   旧实现：finish() 只置自己的标志、`_activeSession = null`、记 _lastReleaseAt，
    //   但**从不调用 record.stop()** —— 原生会一直录到 `duration: 8000` 才自己停。
    //
    //   于是：用户这轮说了 4.35s 就收尾了，原生还剩 3.65s 在录；下一轮
    //   captureVoice() 只等 RELEASE_GAP_MS=300ms 就 record.start()，而引擎还被
    //   上一轮占着 → 启动静默失败 → 但无人声计时器照常跑满 AUDIO_NOSPEECH_MS=1800
    //   → 用户看到的就是「再点一次，两三秒后直接提示没听到声音，啥也没识别」。
    //
    //   这正是用户反馈报的「只有进入后第一次能说，之后每次都是 3 秒后提示未听到」。
    //
    //   修法：收尾就硬停引擎 + 摘回调（不阻塞：stop 放下一 tick），
    //   并把 _lastReleaseAt 记在**真正 stop 之后**，让下一轮的间隔判断有意义。
    _activeSession = null
    try { record.onframerecorded = null } catch (e) {}
    setTimeout(function () {
      var t1 = Date.now()
      try { record.stop({}) } catch (e) {}
      // 释放时刻按 stop 真正返回后再记，确保下一轮不会与旧引擎撞车
      _lastReleaseAt = Date.now()
      var cost = _lastReleaseAt - t1
      if (cost > 300) log('record.stop 收尾耗时 ' + cost + 'ms')
    }, 0)

    var ms = st.startedAt ? (Date.now() - st.startedAt) : 0

    if (!st.voiced) {
      // 区分三种情况，给不同提示才有用：
      //   ① 一帧都没收到 → 引擎根本没启动（麦克风被占用），别谎报「没听到声音」
      //   ② 有帧但峰值偏低 → 离得太远
      //   ③ 有帧且确实安静 → 用户没说
      var why
      if (st.frames === 0) {
        why = '录音未启动（麦克风可能被占用），请稍等一秒再试'
      } else if (st.peak > 0 && st.peak >= st.threshold * 0.5) {
        why = '声音太小，请靠近手表再说一次'
      } else {
        why = '没有听到声音，请靠近手表再说一次'
      }
      log('未检测到有效人声 峰值=' + st.peak.toFixed(4) +
          ' 阈值=' + st.threshold.toFixed(4) + ' 用时=' + ms + 'ms')
      done({ ok: false, reason: why })
      return
    }
    flush(true)
    if (!st.frames) {
      done({ ok: false, reason: '没有录到任何音频（可能是麦克风被占用）' })
      return
    }
    log('录音结束(' + reason + ') 帧=' + st.frames + ' 字节=' + st.bytes +
        ' 用时=' + ms + 'ms 峰值=' + st.peak.toFixed(4) +
        ' 阈值=' + st.threshold.toFixed(4))
    // ★ v1.16.450 诊断：把采集端统计一并带出去，经 audio_end 帧回传手机。
    //   本轮排查「录音 4 秒只拿到 700ms」需要知道：
    //     rawFrames = onframerecorded 实际回调了多少帧（引擎给了多少）
    //     rawBytes  = 引擎给的总字节
    //     voicedAt  = 第多久才判定出人声（preroll 之前丢弃时长的直接证据）
    //     dropped   = preroll 丢弃的帧数
    done({
      ok: true, frames: st.frames, bytes: st.bytes, ms: ms, reason: reason,
      rawFrames: st.rawFrames || 0,
      rawBytes: st.rawBytes || 0,
      voicedAt: st.voicedAt && st.startedAt ? (st.voicedAt - st.startedAt) : -1,
      dropped: st.droppedFrames || 0,
      peak: st.peak, threshold: st.threshold
    })
  }

  // ★★★ 必须无条件赋值。
  // onframerecorded 是事件属性，注册前是 undefined；
  // 若先判断 typeof 是不是函数再赋值，判断永远为 false，回调永远收不到帧。
  try {
    record.onframerecorded = function (data) {
      if (st.finished) return
      var buf = (data && data.frameBuffer) || null
      if (!buf) return
      var len = buf.length || buf.byteLength || 0
      if (!len) return
      st.rawFrames++
      st.rawBytes += len

      // 直接在原始类数组上算 RMS，不再先 push 成普通数组。
      var r = frameRms(buf, 0, len)
      if (r > st.peak) st.peak = r

      // 自适应底噪：开头几帧取平均，说话阈值 = 底噪 × 倍数（不低于下限）。
      // 嘈杂环境自动抬阈值，安静环境保持灵敏。
      if (!st.voiced && st.noiseCount < AUDIO_NOISE_FRAMES) {
        st.noiseSum += r
        st.noiseCount++
        if (st.noiseCount === AUDIO_NOISE_FRAMES) {
          var noise = st.noiseSum / st.noiseCount
          var adaptive = noise * AUDIO_NOISE_FACTOR
          st.threshold = adaptive > AUDIO_VOICE_RMS ? adaptive : AUDIO_VOICE_RMS
        }
      }

      if (r >= st.threshold) {
        if (!st.voiced) {
          st.voiced = true
          st.voicedAt = Date.now()
          log('检测到人声 峰值=' + r.toFixed(4) + ' 阈值=' + st.threshold.toFixed(4))
        }
        st.lastVoiceAt = Date.now()
      }

      // 只存引用三元组，不逐字节拷贝（见 st.segs 上方说明）。
      // ★ 但必须先**整块拷一份**：frameBuffer 可能是引擎复用的同一块内存，
      //   直接存引用的话，还没发出去的旧帧会被后到的帧覆盖 → 音频中间夹噪音，
      //   而且这种 bug 只在长录音下偶发，极难查。
      //   用 slice 一次性拷 640 字节（原生实现，比逐字节 push 快一个数量级）。
      var copy
      try {
        copy = Array.prototype.slice.call(buf, 0, len)
      } catch (e) {
        copy = []
        for (var k = 0; k < len; k++) copy.push(buf[k])
      }

      // ★★★ v1.16.383：检出人声之前**不上传**，只在环形缓冲里留最近
      //   AUDIO_PREROLL_MS 的音频。首次越过阈值时把这段预热缓冲一次性补进
      //   上传队列，之后恢复正常直传。
      //
      //   改之前：点完麦到开口前的静音照样一帧帧发出去（1.8s 无人声＝19 帧
      //   ≈75KB base64 纯白传）。改之后这段只留 300ms（≈4 帧）。
      //   收益不只是省流量：每帧都是一次 interconnect 往返，少发即少阻塞，
      //   手机端也要少 base64 解码、少攒内存，整条链更快出结果。
      if (!st.voiced) {
        st.preroll.push({ src: copy, to: len, t: Date.now() })
        st.prerollBytes += len
        // 丢弃超出预热窗口的旧帧（按时间判，不按字节数——帧长并不恒定）
        while (st.preroll.length > 1 &&
               Date.now() - st.preroll[0].t > AUDIO_PREROLL_MS) {
          var drop = st.preroll.shift()
          st.prerollBytes -= drop.to
          st.droppedFrames++
        }
        return   // ← 关键：未检出人声，不入 segs、不 flush、不发送
      }
      // 刚刚检出人声：先把预热缓冲补进来，否则字头会被吃掉
      if (st.preroll.length) {
        for (var pi = 0; pi < st.preroll.length; pi++) {
          var pf = st.preroll[pi]
          st.segs.push({ src: pf.src, from: 0, to: pf.to })
          st.pendingBytes += pf.to
        }
        log('补发预热缓冲 ' + st.preroll.length + ' 帧 / ' + st.prerollBytes + ' 字节')
        st.preroll = []
        st.prerollBytes = 0
      }

      st.segs.push({ src: copy, from: 0, to: len })
      st.pendingBytes += len
      // ★★★ v1.16.451 真根因（2026-11-03 22:04 实测）：**绝不能在这里同步做编码**。
      //
      //   引擎是「等回调返回才继续采集」的：回调里做的事（拼帧 + base64 + 发送）
      //   全部计入下一次回调的间隔，期间的音频直接丢弃。实测：
      //     frameSize=640B(20ms)   → 回调间隔  90ms → 采集率 22%
      //     frameSize=3200B(100ms) → 回调间隔 469ms → 采集率 21%
      //   比值恒为 ~4.5 倍，说明间隔完全由「我的处理耗时」决定。
      //
      //   修法：回调里只做一次 slice 拷贝（必须，引擎复用同一块内存），
      //   把拼帧/base64/发送**全部推迟到下一个 tick**，让引擎立刻回去采集。
      scheduleFlush()

      // 说过话之后又安静了 AUDIO_SILENCE_MS 就认为说完了，提前收尾。
      // 这一条是「说完立刻出结果」的关键：不用干等到 duration 上限。
      if (st.voiced && st.lastVoiceAt &&
          Date.now() - st.lastVoiceAt > AUDIO_SILENCE_MS) {
        finish('检测到静音')
      }
    }
  } catch (e) {
    done({ ok: false, reason: '注册录音回调失败：' + ((e && e.message) ? e.message : String(e)) })
    return null
  }

  /** 硬释放引擎：摘回调 + 尽力 stop，不阻塞调用方。v1.16.438 */
  function releaseEngine() {
    try { record.onframerecorded = null } catch (e) {}
    // stop 放下一 tick：cancel()/captureVoice() 本身要立刻返回，别被 stop 拖住。
    setTimeout(function () {
      var t0 = Date.now()
      try { record.stop({}) } catch (e) {}
      var cost = Date.now() - t0
      if (cost > 300) log('record.stop 释放耗时 ' + cost + 'ms')
    }, 0)
    _activeSession = null
    _lastReleaseAt = Date.now()
  }

  // ★ v1.16.438：记录首次 start 时刻，供重试的时间预算计算。
  st.firstAttemptAt = Date.now()

  // ★★★ v1.16.438：起新会话前确保上一会话引擎已松开。
  if (_activeSession) {
    log('检测到上一录音会话未释放，先硬停')
    try { _activeSession.cancel() } catch (e) {}
  }
  var _gap = Date.now() - _lastReleaseAt
  if (_gap < RELEASE_GAP_MS) {
    // 引擎可能仍在收尾：延后 RELEASE_GAP_MS 再 start，避免与旧会话撞车。
    log('距上次释放仅 ' + _gap + 'ms，延后 ' + (RELEASE_GAP_MS - _gap) + 'ms 再起录音')
    st.startTimer = setTimeout(function () {
      st.startTimer = null
      if (!st.finished) doStart()
    }, RELEASE_GAP_MS - _gap)
  }

  function doStart() {
  try {
    record.start({
      duration: AUDIO_MAX_MS,
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: 1,
      format: 'pcm',
      // 关键：传 frameSize 才会走 onframerecorded。
      //
      // frameSize：实测它对**吞吐率没有任何影响**，只改变单帧大小与回调次数。
      // （640B→回调间隔 90ms；3200B→间隔 469ms；样本率都是 ~3400/s）
      // 所以别指望靠调它提升采集量 —— 真正的瓶颈见本文件顶部与 flush/finish 处的注释。
      frameSize: 640,
      success: function (res) {
        // 流式模式下 success 通常是「录满 duration，引擎自己停了」。
        // ★★★ v1.16.423 真机根因（2026-11-02 21:54 实测）：
        //   旧判断 `st.frames > 0 || st.voiced || elapsed > AUDIO_MAX_MS - 500`
        //   里 `st.frames > 0` 是致命的 —— 帧从录音开始就一直在来，
        //   而 success 会在**启动后约 100ms** 就回调（此时已收 5 帧），
        //   条件立刻成立 → 100ms 就 finish，用户刚张嘴就被掐断。
        //   实测证据：voice.log「音频已就绪 字节=3200」= 5×640 = 100ms，
        //   然后 identify 报「没有识别到内容」。
        //   现在只认「时长真的接近上限」这一种收尾信号；
        //   「说完了」由 onframerecorded 的静音检测负责，
        //   「引擎卡死」由定时器第 ③ 条兜底，不需要 success 参与判定。
        var elapsed = st.startedAt ? (Date.now() - st.startedAt) : 0
        if (elapsed > AUDIO_MAX_MS - 500) {
          log('record.start 回调（录满时长，引擎收尾）用时=' + elapsed + 'ms 帧=' + st.frames)
          finish('引擎结束')
        } else {
          log('record.start 已启动（用时=' + elapsed + 'ms，继续等帧）')
        }
      },
      fail: function (d, code) {
        if (st.finished) return
        var msg = (d && (d.errMsg || d.message)) || ''
        // ★★★ v1.16.438：引擎可能还在上一会话收尾 → start 会被拒。
        //   这类失败不该直接报给用户（用户看到的就是「点了没反应/没听见」），
        //   先短重试几次，真的起不来才报错。
        st.startAttempts = (st.startAttempts || 0) + 1
        var waited = Date.now() - (st.firstAttemptAt || Date.now())
        if (waited < START_RETRY_BUDGET_MS && !st.frames) {
          if (st.startAttempts === 1) log('录音启动被拒（' + (msg || 'busy') + '），在 ' +
                                          START_RETRY_BUDGET_MS + 'ms 预算内继续重试')
          setTimeout(function () { if (!st.finished) doStart() }, START_RETRY_GAP_MS)
          return
        }
        log('录音启动失败：重试 ' + st.startAttempts + ' 次、累计 ' + waited + 'ms 仍未成功')
        st.finished = true
        if (st.timer) { clearInterval(st.timer); st.timer = null }
        done({ ok: false, reason: '麦克风被占用（已重试 ' + waited + 'ms），请稍后再试' })
        return
        st.finished = true
        if (st.timer) { clearInterval(st.timer); st.timer = null }
        done({ ok: false, reason: '录音失败（code=' + code + (msg ? ' ' + msg : '') + '）' })
      },
    })
    st.startedAt = Date.now()
  } catch (e) {
    st.finished = true
    done({ ok: false, reason: '开始录音异常：' + ((e && e.message) ? e.message : String(e)) })
    return
  }
  }  // doStart 结束

  // 没有延后时立即起录；延后时由上面的 setTimeout 触发 doStart。
  if (!(_gap < RELEASE_GAP_MS)) doStart()

  // ★ 定时器承担三件事：没人说话就早点放弃、说太久就收、引擎卡住兜底。
  // 注意：这里绝不调 record.stop() —— S5 上它会阻塞 JS 线程十几秒（见文件头说明）。
  // 所以「提前结束」只能是自己停止收帧并向上回结果，让引擎按 duration 自然收尾。
  st.timer = setInterval(function () {
    if (st.finished) return
    // v1.16.438：延后启动期间 startedAt 还是 0，now-0 会是天文数字，
    // 看门狗第 ③ 条会立刻判「到时长上限」→ 0 帧收场 → 界面报「没听见」。
    if (!st.startedAt) return
    var now = Date.now()
    var elapsed = now - st.startedAt
    // ★★★ v1.16.453 真根因（2026-11-03 23:2x）：必须把「引擎没起来」与
    //   「起来了但没人说话」分开，否则前者会被误判成后者。
    //
    //   旧逻辑只有下面第 ① 条：1.8 秒没人声就 finish('未检测到人声')。
    //   而引擎被上一轮占用时 record.start() 是**静默不生效**的（不报 fail），
    //   一帧都不会来 → voiced 恒 false → 1.8 秒后必然判「未检测到人声」。
    //   看到的「再点一次，两三秒后直接提示没听到声音，啥也没识别」
    //   就是这个 —— 时长也对得上（1800ms + 200ms 定时器粒度）。
    //
    //   现在：超过 GRACE 还**一帧都没有**，说明是启动问题，不是没声音。
    //   先硬释放引擎并如实报「麦克风被占用」，让用户知道该等一下，
    //   而不是骗他说「没听到声音」。
    if (st.frames === 0 && elapsed > AUDIO_START_GRACE_MS) {
      log('录音引擎未产出任何帧（' + elapsed + 'ms），判定为启动被占用')
      finish('引擎未启动')
      return
    }
    // ① 一句话都没说：1.8 秒就放弃，不让用户干等 8 秒
    if (!st.voiced && elapsed > AUDIO_NOSPEECH_MS) { finish('未检测到人声'); return }
    // ② 已经在说且说太久：收，避免一直传
    if (st.voiced && elapsed > AUDIO_SPEECH_MAX_MS) { finish('超过最长说话时长'); return }
    // ③ 引擎彻底不动了的兜底
    if (elapsed > AUDIO_MAX_MS + 500) finish('到时长上限')
  }, 200)

  var handle = {
    // ★★★ v1.16.438（2026-11-03 01:0x 真机）：取消必须真正释放录音引擎。
    //   旧实现只置 finished + 清定时器，**既没摘掉 record.onframerecorded，
    //   也没让引擎停下来**。后果链：
    //     · 原生引擎继续录到 duration 上限（8s），上一次的回调仍挂在 record 单例上；
    //     · 用户再点麦克风时 _activeSession 已空，captureVoice 立刻 record.start()，
    //       而引擎还在被上一会话占用 → 新会话一帧都收不到；
    //     · 于是「取消之后，无论说什么都回答没听见」。
    cancel: function () {
      if (st.finished) return
      st.finished = true
      if (st.timer) { clearInterval(st.timer); st.timer = null }
      if (st.startTimer) { clearTimeout(st.startTimer); st.startTimer = null }
      try { record.onframerecorded = null } catch (e) {}
      log('用户取消录音，释放引擎（已收 ' + st.frames + ' 帧）')
      releaseEngine()
    },
    stop: function () { finish('用户结束') },
  }
  // v1.16.438：登记为当前活跃会话，供下一次 captureVoice 检测未释放的旧会话。
  _activeSession = handle
  return handle
}

export { bytesToBase64, frameRms, peakRms, captureVoice, AUDIO_SAMPLE_RATE }
