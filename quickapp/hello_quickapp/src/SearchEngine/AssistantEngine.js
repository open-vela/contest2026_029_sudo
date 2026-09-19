// AssistantEngine —— 语音搜索 / AI 搜索的统一引擎（真链路 + 可运行模拟链路）
//
// 官方链路（真机）：手表快应用 @system.interconnect ←→ 手机 App（xms-wearable SDK）
//   const conn = interconnect.instance()
//   conn.onmessage = (data) => {...}     // 收手机数据
//   conn.send({ data: 'xxx' })          // 发到手机
//   conn.getReadyState({...})           // 查连接状态
//   ⚠️ 约束：需配套手机 App、两端证书一致（官方 FAQ：通信前检查签名）。
//
// 模拟链路（模拟器/无手机对端）：interconnect 不可用或未就绪时自动启用。
//   设计原则：只有「声学识别 / 云端大模型」被替换为本地模拟源，
//   其余全部真实运行 —— 识别结果会真实填入搜索框并触发本地搜索引擎；
//   AI 回答由本地检索 + 模板摘要真实生成，绝非写死的假文案。
//
// 依赖：零（纯 ES5；interconnect 按需 require，失败即走模拟）
//
// ============ AI 问答蓝牙协议（ai_chat，v1.16.90 AI 提问页专用） ============
// 请求（手环→手机）：{ type: 'ai_chat', qid: <自增序号>, question: '<文本>' }
// 应答（手机→手环）：{ type: 'ai_chat_result', qid: <对应序号>, ok: true,
//                    answer: '<完整回答文本（兜底/概要）>',
//                    card: { summary: '<一句话结论>',
//                            sections: [{ name: '<小节名>', items: ['<要点1>', '<要点2>'] }],
//                            note: '<尾注（如免责声明）>' },   // 结构化作答卡，可选；手环无 card 时渲染 answer 纯文本
//                    sources: [{ title: '<条目名>', gid: <全局条目id> }] }
// ⚠️ 拒绝流式：手机端必须等大模型回答完毕后【一次性】回包；手环端不做分片拼接。
// ⚠️ qid 自增匹配：应答 qid ≠ 当前挂起序号时直接丢弃（防旧答案污染新问题）。
// ⚠️ 超时 12s：手机无回包 → 自动降级本地模拟回答（_simChat，保证任何环境可用）。

var MODE = {
  REAL: 'real',        // 真机：interconnect 通道（手机 App 应答）
  SIM: 'sim'           // 模拟：本地模拟源（模拟器演示 / 无对端）
}

var SIM_LATENCY = 1500          // 模拟识别延迟（ms）：贴近真实语音识别耗时
var SIM_AI_LATENCY = 900        // 模拟 AI 思考延迟（ms）
var SIM_CHAT_LATENCY = 2500     // 模拟 AI 问答延迟（ms）：用户指定的小爱式"准备回答"节奏
var CHAT_TIMEOUT = 12000        // 真链路 ai_chat 应答超时（ms）：超时降级本地模拟


// ============ 模拟 AI 问答库（v1.16.100 主人定案） ============
// AI 搜索的定位：AI 依据【自身模型知识 / 联网搜索】作答——更权威、广度更大，
// 【不参考】本地资料库（库内检索是离线搜索的业务，两者互相独立）。
// 真机：问题经 ai_chat 协议交手机端大模型（可联网）作答，以下预置仅用于模拟器演示。
// 覆盖模拟识别词表（感冒/急救/睡眠/唐朝/运动/早餐/绿植/理财/记忆/秦/宋朝）等常见问题。
var SIM_AI_ANSWERS = [
  { keys: ['感冒', '发烧', '咳嗽'], text: '感冒多由病毒引起，通常 7 天左右自愈，重点在缓解症状和观察危险信号。',
    card: { summary: '感冒多由病毒引起，通常 7 天左右自愈，重点在缓解症状和观察危险信号。',
      sections: [
        { name: '居家护理', items: ['多喝温水，保证充足休息', '体温超过 38.5℃ 可酌情使用退烧药', '鼻塞可用生理盐水洗鼻'] },
        { name: '需要及时就医', items: ['持续高热超过 3 天', '出现呼吸困难、剧烈头痛或胸痛'] } ],
      note: '以上内容由 AI 生成，仅供参考，不能替代医生诊断。' } },
  { keys: ['急救', '心肺复苏', 'cpr', '心脏骤停'], text: '心脏骤停后的黄金 4 分钟，高质量的心肺复苏和尽早除颤是关键。',
    card: { summary: '心脏骤停后的黄金 4 分钟，高质量的心肺复苏和尽早除颤是关键。',
      sections: [
        { name: '操作步骤', items: ['确认环境安全，拍肩呼叫判断意识', '无反应立即呼救、拨打 120 并取来 AED', '胸外按压：两乳头连线中点，深度 5~6 厘米，频率 100~120 次/分', '按压与人工呼吸按 30:2 配合'] },
        { name: '注意事项', items: ['尽早使用 AED，按设备语音提示操作', '持续按压，直到专业人员接手'] } ],
      note: '以上内容由 AI 生成，仅供参考；系统学习请参加专业急救培训。' } },
  { keys: ['睡眠', '失眠', '睡不着'], text: '改善睡眠的核心是固定作息和减少睡前刺激。',
    card: { summary: '改善睡眠的核心是固定作息和减少睡前刺激。',
      sections: [
        { name: '作息与环境', items: ['固定作息，每天同一时间上床和起床', '卧室保持安静、黑暗、约 18~22℃', '午睡不超过 30 分钟'] },
        { name: '睡前习惯', items: ['睡前 1 小时远离手机等强光屏幕', '下午 3 点后避免咖啡因', '躺下约 20 分钟睡不着，就起身放松一会再回床'] } ],
      note: '以上内容由 AI 生成，仅供参考；长期失眠请咨询医生。' } },
  { keys: ['运动', '锻炼', '健身'], text: '科学运动＝规律的有氧＋力量训练，循序渐进最关键。',
    card: { summary: '科学运动＝规律的有氧＋力量训练，循序渐进最关键。',
      sections: [
        { name: '训练建议', items: ['每周至少 150 分钟中等强度有氧（快走、慢跑、游泳）', '每周 2 次力量训练', '运动前热身 5~10 分钟，运动后拉伸'] },
        { name: '安全提示', items: ['循序渐进，及时补水', '有心血管基础疾病请先咨询医生'] } ],
      note: '以上内容由 AI 生成，仅供参考。' } },
  { keys: ['早餐'], text: '健康早餐的公式：优质碳水＋优质蛋白＋新鲜果蔬。',
    card: { summary: '健康早餐的公式：优质碳水＋优质蛋白＋新鲜果蔬。',
      sections: [
        { name: '推荐搭配', items: ['优质碳水：全麦面包、燕麦', '优质蛋白：鸡蛋、牛奶、豆浆', '果蔬：一份时令水果或蔬菜'] },
        { name: '注意', items: ['避免高糖高油', '早餐热量约占全天的 25%~30%'] } ],
      note: '以上内容由 AI 生成，仅供参考。' } },
  { keys: ['绿植', '养花', '多肉'], text: '家庭养绿植，把握光照、浇水、通风三点即可。',
    card: { summary: '家庭养绿植，把握光照、浇水、通风三点即可。',
      sections: [
        { name: '三个要点', items: ['光照按习性：喜阴植物避开暴晒，开花植物保证充足光照', '浇水见干见湿、宁少勿多，多数植物死于浇水过多', '保持通风，春秋每月施一次薄肥'] } ],
      note: '以上内容由 AI 生成，仅供参考。' } },
  { keys: ['理财', '省钱', '存钱'], text: '理财先理清收支，再谈增值。',
    card: { summary: '理财先理清收支，再谈增值。',
      sections: [
        { name: '入门四步', items: ['先记账 1~2 个月，看清钱的去向', '攒出 3~6 个月生活费的应急金', '参考「50/30/20」分配必要开支/想要/储蓄投资', '远离承诺高收益的产品，不懂的不要投'] } ],
      note: '以上内容由 AI 生成，仅供参考，不构成投资建议。' } },
  { keys: ['记忆', '背单词', '记不住'], text: '记忆效率的关键是间隔重复和主动回忆。',
    card: { summary: '记忆效率的关键是间隔重复和主动回忆。',
      sections: [
        { name: '方法', items: ['间隔重复：学完当天、第 2 天、第 7 天、第 15 天各复习一次', '主动回忆：合上书自测，比反复阅读有效得多', '联想与图像化，把信息编码成画面'] },
        { name: '基础保障', items: ['保证睡眠——记忆巩固主要发生在睡眠中'] } ],
      note: '以上内容由 AI 生成，仅供参考。' } },
  { keys: ['唐朝', '唐代'], text: '唐朝（618—907）是中国历史上最强盛的王朝之一。',
    card: { summary: '唐朝（618—907）是中国历史上最强盛的王朝之一。',
      sections: [
        { name: '概况', items: ['贞观之治与开元盛世时期国力鼎盛', '长安是当时世界上最大的城市之一', '诗歌达到巅峰：李白、杜甫、白居易等名家辈出', '对东亚文化影响深远'] } ],
      note: '以上内容由 AI 生成，仅供参考。' } },
  { keys: ['宋朝', '宋代'], text: '宋朝（960—1279）以经济繁荣和文化昌盛著称。',
    card: { summary: '宋朝（960—1279）以经济繁荣和文化昌盛著称。',
      sections: [
        { name: '概况', items: ['商业与城市经济高度发达，出现世界最早的纸币"交子"', '科技领先：活字印刷、指南针、火药广泛应用', '宋词与山水画成就极高'] } ],
      note: '以上内容由 AI 生成，仅供参考。' } },
  { keys: ['秦朝', '秦代', '秦始皇'], text: '秦朝（前 221—前 207）是中国历史上第一个大一统王朝。',
    card: { summary: '秦朝（前 221—前 207）是中国历史上第一个大一统王朝。',
      sections: [
        { name: '概况', items: ['秦始皇统一六国后推行郡县制', '统一文字、货币与度量衡，修筑长城', '虽二世而亡，但奠定此后两千余年的政治格局'] } ],
      note: '以上内容由 AI 生成，仅供参考。' } }
]

// 未命中预置词时的兜底作答（如实提示模拟能力边界，不编造内容）
var SIM_AI_FALLBACK = '这是个有意思的问题。离线演示模式下我暂时只能回答常见的生活知识类问题，比如：感冒怎么办、心肺复苏步骤、如何改善睡眠、健康早餐搭配等。联网或连接手机后，我可以为你搜索更全面、更权威的答案。'

// —— 同义词扩展（本地问答理解）：把口语问题映射到资料库词 ——
var SYNONYMS = [
  [/(怎么|如何|怎样).*(急救|救急|处理)/, '急救'],
  [/(怎么|如何|怎样).*(感冒|发烧|发热)/, '感冒'],
  [/(怎么|如何|怎样).*(入睡|失眠|睡不着)/, '睡眠'],
  [/(减肥|瘦身)/, '运动'],
  [/(背单词|记单词|学英语)/, '记忆'],
  [/(血压|血糖)/, '血压'],
  [/(做菜|做饭|烹饪)/, '烹饪'],
  [/(养花|浇花|绿植)/, '绿植'],
  [/(省钱|理财|存钱)/, '理财'],
  [/(带孩子|育儿|宝宝)/, '育儿']
]

function Assistant() {
  this.mode = null
  this.conn = null
  this._voiceCb = null
  this._aiCb = null
  this._simTimer = null
  this._probeDone = false
  // ai_chat（v1.16.90）：_chatSeq=自增序号（即协议 qid）；_chatDone=本次请求已消费
  //（超时降级后迟到回包、旧 qid 回包都靠它+序号比对拦截，防双重回调/旧答案污染）
  this._chatCb = null
  this._chatSeq = 0
  this._chatDone = false
  this._chatTimer = null
}

// 探测通道：真链路优先（interconnect 就绪），否则模拟。结果缓存（连接状态变化时 reprobe）。
Assistant.prototype.probe = function (onReady) {
  var self = this
  if (this._probeDone && this.mode) { onReady(this.mode); return }
  try {
    var interconnect = require('@system.interconnect')
    var conn = interconnect.instance()
    conn.getReadyState({
      success: function (data) {
        if (data && data.status === 1) {
          self.mode = MODE.REAL
          self.conn = conn
          self._bindReal(conn)
        } else {
          self.mode = MODE.SIM
        }
        self._probeDone = true
        onReady(self.mode)
      },
      fail: function () {
        self.mode = MODE.SIM
        self._probeDone = true
        onReady(self.mode)
      }
    })
  } catch (e) {
    // 模拟器上 interconnect 通常不可 require 或无对端 → 模拟链路
    this.mode = MODE.SIM
    this._probeDone = true
    onReady(this.mode)
  }
}

// 绑定真链路消息（手机 App 的应答）
// ⚠️ 包装链（审查修复）：BtTransfer（蓝牙资料接收）也在这条通道设 conn.onmessage，
// 直接赋值会互相覆盖。保留原 handler，非本模块消息转发过去，两模块都能收到。
Assistant.prototype._bindReal = function (conn) {
  var self = this
  var prevHandler = conn.onmessage
  conn.onmessage = function (data) {
    var handled = false
    // v1.16.176（提交前审查修复 C3）：双兼容 —— 官方互联层可能以 {data:'<json>'} 包装投递，
    // 也可能直接投递裸字符串/对象（同通道的 BtTransfer 已按此兼容）。原实现只解析包装形态，
    // 裸投递时语音/AI 结果会完全收不到（真链路静默失败）。
    var payload = data
    if (data && typeof data === 'object' && typeof data.data === 'string') payload = data.data
    if (payload) {
      var msg = null
      try { msg = (typeof payload === 'string') ? JSON.parse(payload) : payload } catch (e) { msg = null }
      if (msg && msg.type === 'voice_result' && self._voiceCb) {
        self._voiceCb({ ok: true, text: msg.text || '', mode: MODE.REAL })
        handled = true
      } else if (msg && msg.type === 'ai_result' && self._aiCb) {
        self._aiCb({ ok: true, answer: msg.answer || '', results: msg.results || [], mode: MODE.REAL })
        handled = true
      } else if (msg && msg.type === 'ai_chat_result') {
        // ai_chat 应答（v1.16.90）：qid 必须等于当前挂起序号（自增匹配），且本次请求
        // 尚未消费（超时降级后迟到回包在此拦截）——其余一律丢弃，防旧答案污染新问题。
        // 无论是否命中都按已消费处理（本协议消息不转发 prevHandler，BtTransfer 无此类型）。
        if (self._chatCb && msg.qid === self._chatSeq && !self._chatDone) {
          self._chatDone = true
          if (self._chatTimer) { clearTimeout(self._chatTimer); self._chatTimer = null }
          self._chatCb(msg.ok
            ? { ok: true, answer: msg.answer || '', card: msg.card || null, sources: msg.sources || [], mode: MODE.REAL }
            : { ok: false, reason: 'remote_error' })
        }
        handled = true
      }
    }
    if (!handled && typeof prevHandler === 'function') {
      try { prevHandler(data) } catch (e) {}
    }
  }
}

// v1.16.114 蓝牙状态实时查询（首页提示块的连接指示用）：每次真查 getReadyState，
// 不走 probe 的会话缓存（连接状态会变化，指示器必须实时）
Assistant.prototype.checkBtStatus = function (cb) {
  try {
    var interconnect = require('@system.interconnect')
    var conn = interconnect.instance()
    conn.getReadyState({
      success: function (data) { cb(!!(data && data.status === 1)) },
      fail: function () { cb(false) }
    })
  } catch (e) { cb(false) }
}

// ============ 语音搜索 ============
// 真链路：向手机发送语音搜索请求（手机端做 ASR 后回传文本）
// 模拟链路：从资料集高频词中抽一个词作为"识别结果"（延迟 SIM_LATENCY），
//          走与真链路完全相同的回调 —— 后续填词/搜索/出结果全部真实执行。
Assistant.prototype.recognize = function (cb) {
  var self = this
  this._voiceCb = cb
  this.cancelSim()
  this.probe(function (mode) {
    if (mode === MODE.REAL) {
      try {
        self.conn.send({ data: JSON.stringify({ type: 'voice_search' }) })
      } catch (e) {
        // 真链路发送失败 → 降级模拟（保证任何环境都能跑完流程）
        self._simVoice(cb)
      }
    } else {
      self._simVoice(cb)
    }
  })
}

Assistant.prototype._simVoice = function (cb) {
  var self = this
  var word = this._pickSimWord()
  this._simTimer = setTimeout(function () {
    self._simTimer = null
    cb({ ok: !!word, text: word, mode: MODE.SIM })
  }, SIM_LATENCY)
}

// ============ AI 搜索 ============
// 真链路：把问题发到手机 App（云端大模型应答）
// 模拟链路：本地"问答理解"（同义词归一）→ 真实搜索引擎检索 → 模板摘要生成回答。
//          回答内容由检索结果真实拼出，问题不同则回答不同，非固定文案。
Assistant.prototype.answer = function (question, searchFn, cb) {
  var self = this
  this._aiCb = cb
  this.cancelSim()
  this.probe(function (mode) {
    if (mode === MODE.REAL) {
      try {
        self.conn.send({ data: JSON.stringify({ type: 'ai_search', q: question }) })
      } catch (e) {
        self._simAI(question, searchFn, cb)
      }
    } else {
      self._simAI(question, searchFn, cb)
    }
  })
}

Assistant.prototype._simAI = function (question, searchFn, cb) {
  var self = this
  var keyword = this._understand(question)
  if (!keyword) { cb({ ok: false, reason: 'empty' }); return }
  var t0 = Date.now()
  searchFn(keyword).then(function (result) {
    var items = (result && result.results) || []
    var total = (result && result.total) || 0
    // 摘要生成：由检索结果真实拼出（与 _simChat 共用 _composeAnswer，不复制粘贴）
    var answer = self._composeAnswer(keyword, items, total)
    // 保证回答至少延迟 SIM_AI_LATENCY（模拟"思考"节奏），检索更快则补齐
    var wait = Math.max(0, SIM_AI_LATENCY - (Date.now() - t0))
    setTimeout(function () { cb({ ok: true, answer: answer, keyword: keyword, results: items, total: total, mode: MODE.SIM }) }, wait)
  }).catch(function () {
    cb({ ok: false, reason: 'search_error' })
  })
}

// 摘要生成：由检索结果真实拼出（取前 2 条的标题与正文首句）——
// _simAI（首页内嵌 AI 搜索）与 _simChat（AI 提问页）共用；回答内容随问题/检索结果变化，非固定文案
// v1.16.99 AI 式作答（主人定案）：不再「共找到 N 条资料：1.标题 2.标题」式罗列，
// 改为「查库作答」——开场白（三种轮换防千篇一律）+ ①②③ 条目名:正文要点（pointTexts
// 来自 _fetchPointTexts 拉取的详情正文首句，内容全部真实来自资料库）+ 收尾引导。
// 真机连手机时本方法不被调用（走 ai_chat 真链路，由手机端大模型作答）。
Assistant.prototype._composeAnswer = function (keyword, items, total, pointTexts) {
  if (!items || !items.length) {
    return '资料库里暂时没找到与「' + keyword + '」直接相关的内容。换个说法试试，比如用更常见的名称或症状词。'
  }
  this._ansSeq = (this._ansSeq || 0) + 1
  var opens = [
    '关于「' + keyword + '」，我在本地资料库中检索了 ' + total + ' 条相关内容，要点整理如下：',
    '「' + keyword + '」相关的资料共 ' + total + ' 条，重点如下：',
    '已在离线资料库中查到「' + keyword + '」相关 ' + total + ' 条，为你整理要点：'
  ]
  var out = [opens[this._ansSeq % 3]]
  var upper = items.length < 3 ? items.length : 3
  var nums = ['①', '②', '③']
  for (var i = 0; i < upper; i++) {
    var it = items[i]
    var head = (it.title || '').split(/[，。,.]/)[0]
    var body = (pointTexts && pointTexts[i]) ? String(pointTexts[i]) : ''
    out.push(nums[i] + ' ' + head + (body ? '：' + body : ''))
  }
  out.push('以上要点由本地资料库整理；点下方「来源」可查看完整条目。')
  return out.join('\n')
}

// 取前 2 条条目的详情正文首句（AI 式作答的要点素材）：
// 优先取最长字段（通常为正文/方法），退化 cause/impact；单条 4s 超时兜底（读文件回调丢失防护）
Assistant.prototype._fetchPointTexts = function (items) {
  var self = this
  var tasks = []
  var n = items.length < 2 ? items.length : 2
  for (var i = 0; i < n; i++) {
    (function (it) {
      var gid = (it.id !== undefined) ? it.id : it._id
      tasks.push(new Promise(function (resolve) {
        var done = false
        var timer = setTimeout(function () { if (!done) { done = true; resolve('') } }, 4000)
        var finish = function (v) { if (done) return; done = true; clearTimeout(timer); resolve(v) }
        try {
          if (typeof global !== 'undefined' && typeof global.getItemById === 'function') {
            global.getItemById(gid).then(function (doc) {
              finish(self._firstSentenceOf(doc))
            }).catch(function () { finish('') })
          } else { finish('') }
        } catch (e) { finish('') }
      }))
    })(items[i])
  }
  return Promise.all(tasks)
}

// 详情正文首句提取：最长字段优先 → cause/impact 兜底 → 去转义换行/压缩空白 → 截首句（≤54 字）
Assistant.prototype._firstSentenceOf = function (doc) {
  if (!doc) return ''
  var raw = ''
  if (doc.details && doc.details.length) {
    for (var i = 0; i < doc.details.length; i++) {
      var v = String((doc.details[i] && doc.details[i].value) || '')
      if (v.length > raw.length) raw = v
    }
  }
  if (!raw) raw = String(doc.cause || doc.impact || '')
  raw = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
  var s = raw.split(/[。；;！!？?]/)[0] || ''
  if (s.length > 54) s = s.slice(0, 54) + '…'
  return s
}

// ============ AI 问答（v1.16.90 AI 提问页 /pages/ai/ai 用） ============
// 真链路：发 ai_chat 到手机 App（云端大模型一次性回包，qid 自增匹配）；12s 无回包降级 _simChat。
// 模拟链路：_simChat —— 同义词归一 → 注入的 searchFn 真实检索 → _composeAnswer 模板摘要，
//          固定 2500ms 节奏（用户指定）。与 answer() 双链路结构一致，互不影响。
Assistant.prototype.chat = function (question, searchFn, cb) {
  var self = this
  this._chatCb = cb
  this._chatDone = false
  this._chatSeq++            // qid 自增：新问题新序号，旧应答按序号失配丢弃
  var qid = this._chatSeq
  var seq = qid              // 闭包序号：探测回调返回时校验请求未被更新的替换
  this.cancelSim()
  if (this._chatTimer) { clearTimeout(this._chatTimer); this._chatTimer = null }
  this.probe(function (mode) {
    if (seq !== self._chatSeq) return   // 期间又发起了新问题，过期探测直接丢弃
    if (mode === MODE.REAL) {
      try {
        self.conn.send({ data: JSON.stringify({ type: 'ai_chat', qid: qid, question: question }) })
        // 12s 超时降级：手机端未一次性回包（大模型超时/断连）→ 走本地模拟，保证任何环境可用
        self._chatTimer = setTimeout(function () {
          self._chatTimer = null
          if (self._chatDone || seq !== self._chatSeq) return
          self._chatDone = true   // 置位后迟到的 ai_chat_result 在分发处被拦截，不会双重回调
          self._simChat(question, searchFn, cb)
        }, CHAT_TIMEOUT)
      } catch (e) {
        // 真链路发送失败 → 降级模拟（与 answer()/recognize() 同款兜底）
        self._simChat(question, searchFn, cb)
      }
    } else {
      self._simChat(question, searchFn, cb)
    }
  })
}

Assistant.prototype._simChat = function (question, searchFn, cb) {
  var self = this
  var keyword = this._understand(question)
  if (!keyword) { cb({ ok: false, reason: 'empty' }); return }
  var t0 = Date.now()
  // v1.16.100：AI 作答不基于本地库——按关键词命中预置 AI 问答（模拟器演示用），
  // 未命中给出能力边界提示；sources 为空（回答来自模型知识/联网，非库内条目）
  var answer = SIM_AI_FALLBACK
  var card = null
  for (var i = 0; i < SIM_AI_ANSWERS.length; i++) {
    var item = SIM_AI_ANSWERS[i]
    for (var k = 0; k < item.keys.length; k++) {
      if (keyword.indexOf(item.keys[k]) !== -1 || item.keys[k].indexOf(keyword) !== -1) {
        answer = item.text
        card = item.card || null      // v1.16.101 结构化作答卡（手机端 AI 按同 schema 填）
        break
      }
    }
    if (answer !== SIM_AI_FALLBACK) break
  }
  var payload = { ok: true, answer: answer, card: card, sources: [], mode: MODE.SIM }
  // 补齐 2500ms 节奏；定时器挂 _simTimer——cancelSim 可中途取消（准备态滑动取消用）
  var wait = Math.max(0, SIM_CHAT_LATENCY - (Date.now() - t0))
  self._simTimer = setTimeout(function () {
    self._simTimer = null
    if (self._chatCb !== cb) return   // 已被取消/新请求取代，过期结果丢弃
    cb(payload)
  }, wait)
}

// 本地问答理解：同义词归一 → 抽取 2 字以上中文词 / 英文词（最长者优先）
Assistant.prototype._understand = function (q) {
  var s = String(q || '').trim()
  if (!s) return ''
  for (var i = 0; i < SYNONYMS.length; i++) {
    if (SYNONYMS[i][0].test(s)) return SYNONYMS[i][1]
  }
  var m = s.match(/[a-zA-Z]{3,}/)
  if (m) return m[0].toLowerCase()
  m = s.match(/[\u4e00-\u9fa5]{2,}/g)
  if (m && m.length) {
    var best = ''
    for (var j = 0; j < m.length; j++) { if (m[j].length > best.length) best = m[j] }
    return best
  }
  return s
}

// 模拟语音识别的"结果词"：从内置高频演示词表抽取（均来自资料集真实标题词，保证必命中）
Assistant.prototype._pickSimWord = function () {
  var words = ['感冒', '急救', '睡眠', '唐朝', '唐朝', '运动', '早餐', '绿植', '理财', '记忆', '秦', '宋朝']
  return words[Math.floor(Math.random() * words.length)]
}

Assistant.prototype.cancelSim = function () {
  if (this._simTimer) {
    clearTimeout(this._simTimer)
    this._simTimer = null
  }
}

Assistant.prototype.cancel = function () {
  this.cancelSim()
  // ai_chat 在途清理（v1.16.90 新增字段）：12s 超时定时器与回包回调一并作废
  if (this._chatTimer) {
    clearTimeout(this._chatTimer)
    this._chatTimer = null
  }
  this._chatCb = null
  this._voiceCb = null
  this._aiCb = null
}

Assistant.prototype.getMode = function () { return this.mode || MODE.SIM }

// —— 单例 ——
var _instance = null
function getAssistant() {
  if (!_instance) _instance = new Assistant()
  return _instance
}

export { getAssistant }   // MODE 仅引擎内部使用，未导出（2026-09-17 审查清理死导出）
