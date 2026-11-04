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
// 请求（手环→手机）：{ type: 'ai_chat', qid: <自增序号>, question: '<文本>',
//                     sources: [{ title: '<条目名>', gid: <全局条目id>, tag: '<资料集>' }] }
//                     // sources v1.16.311 新增：手环端先本地检索命中的条目（最多 3 条），
//                     // 手机端据此在 prompt 中注入库内参考并要求模型优先采用，作答后原样回填。
// 应答（手机→手环）：{ type: 'ai_chat_result', qid: <对应序号>, ok: true,
//                    answer: '<完整回答文本（兜底/概要）>',
//                    card: { summary: '<一句话结论>',
//                            sections: [{ name: '<小节名>', items: ['<要点1>', '<要点2>'] }],
//                            note: '<尾注（如免责声明）>' },   // 结构化作答卡，可选；手环无 card 时渲染 answer 纯文本
//                    sources: [{ title: '<条目名>', gid: <全局条目id>, tag: '<资料集>' }] }
// ⚠️ 拒绝流式：手机端必须等大模型回答完毕后【一次性】回包；手环端不做分片拼接。
// ⚠️ qid 自增匹配：应答 qid ≠ 当前挂起序号时直接丢弃（防旧答案污染新问题）。
// ⚠️ 超时 12s：手机无回包 → 自动降级本地模拟回答（_simChat，保证任何环境可用）。

// ★★★ v1.16.355：录音模块（手表自己录音，S5 是官方唯一支持录音的机型）。
//   小米手环 9 的 @system.record 是空壳（start 不是函数），但 Xiaomi Watch S5 实测
//   start 成功、能拿到 16k / 单声道 / 16bit PCM 帧。用户明确要求「手表录、手机识别」，
//   所以这条链路只在录音真的可用时才走，拿不到就如实报错，绝不拿手机麦克风冒充。
import { captureVoice } from './AudioUp.js'
// ★ v1.16.388：用于在 probe() 拿到 conn 后补调接收器（见 probe 内注释）。
//   这里用 ES import 建立静态依赖，避免运行时 require 的时序不确定性。
import { initBtReceiver } from './BtTransfer.js'
// ★★★ v1.16.435：interconnect 入站只有 IcBus 一个持有者（见 IcBus.js 文件头）。
//   旧架构靠「保存上一个 handler 再转发」串模块，而 conn.onmessage 读回恒 undefined，
//   转发链根本建立不起来 —— 真机 noprev=4/fwd=0/rx=0 实锤。
import IcBus from './IcBus.js'

// ★★★ v1.16.418（2026-11-02 模拟器实测）：**require 一次就缓存**。
//   前因：60 秒实测（emulator-5554）抓到的每条心跳周期固定 5 行日志，其中
//   **4 行由两次 require 产生**，只有 1 行是真正的 send 失败：
//     [__app_require:106] Try find feautre in old manager: system.interconnect   ← require
//     [__app_require:69]  app_require feature: @app-module/system.interconnect   ← require
//     [__miwear_send:277] [interconnect] status is not connected, send failed    ← 真实失败
//     [FEATURE] [findFeature:727] can't find description for native feature …    ← require
//     [FEATURE] [findFeature:93]  can not find feature: system.interconnect      ← require
//   两次的来源：① probe() 里 require 一次；② probe 成功拿到 conn 后补调
//   initBtReceiver()（v1.16.388）内部又 require 一次。
//   `@system.*` 在 Vela 上是全局单例模块，重复 require **不必要**，却每次都要走
//   完整的 __app_require → findFeature 查找链，拿不到 feature 时固定打印上面 4 行。
//   心跳 5s 一次 → 每秒近 1 行纯框架噪声，而业务层无法从自己的 console 关掉它。
//   缓存后每周期只剩 send 那 1 行（那条是「蓝牙确实没连」的真实信号，应保留）。
//   注意：只缓存**成功**返回的模块对象。require 真抛异常时不缓存，下次照常重试。
var _icModule = null
// ★ v1.16.435：入站 handler 的模块级引用（由 _bindReal 定义、由 IcBus 分发）。
//   旧实现是 _bindReal 内的局部变量 + 包装链，包装链断裂后它就再也没被调用过。
var _aeHandlerRef = function () {}
function getInterconnect() {
  if (_icModule) return _icModule
  _icModule = require('@system.interconnect')
  return _icModule
}

var MODE = {
  REAL: 'real',        // 真机：interconnect 通道（手机 App 应答）
  SIM: 'sim'           // 模拟：本地模拟源（模拟器演示 / 无对端）
}

var SIM_LATENCY = 1500          // 模拟识别延迟（ms）：贴近真实语音识别耗时
var SIM_AI_LATENCY = 900        // 模拟 AI 思考延迟（ms）
// ★★★ v1.16.463（2026-11-04 设计定案「本地开始算，但是AI在上面会比本地先算完，
//   然后显示在那里」）：2500 → 500。
//   2500 是按「小爱式准备回答」的观感定的，但它必然晚于本地检索（实测几百 ms），
//   于是现场看到的是「本地结果先铺满、AI 卡最后才顶上来」——与要演示的「AI 秒答」相反。
//   500ms 让 AI 卡先于本地结果出现，顺序变成：出字 → AI 答案（顶部）→ 本地结果接在下面。
var SIM_CHAT_LATENCY = 500      // 模拟 AI 问答延迟（ms）：要早于本地检索完成
var CHAT_TIMEOUT = 12000        // 真链路 ai_chat 应答超时（ms）：超时降级本地模拟

// v1.16.311 检索增强（用户反馈答辩前定案）：AI 作答前先在本地库跑一次检索，
// 命中的真实条目作为「来源」随作答一并返回——
//   · 模拟链路：sources 直接由本地检索结果填充，回答页「来源」可点回原文；
//   · 真链路：同批条目随 ai_chat 下发手机端，由手机端喂进 prompt（要求优先采用库内条目）
//     并原样回填 sources，保证两端口径一致。
// 上限 3 条：手环内存红线 ~1.6MB，蓝牙单包也不宜过大。
var SOURCES_MAX = 3


// ============ 模拟 AI 问答库（v1.16.100 定案；v1.16.311 增补本地来源）============
// AI 搜索的定位：AI 依据【自身模型知识 / 联网搜索】作答，广度与权威性优于离线检索；
// 同时（v1.16.311 起）本地检索命中的条目会作为「出处」一并返回，回答页可点回原文。
// 真机：问题经 ai_chat 协议交手机端大模型（可联网）作答，以下预置仅用于模拟器演示——
// 模拟器无手机对端时，答案取预置文案，但 sources 仍是本地检索的真实命中条目。
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
  [/(带孩子|育儿|用户反馈)/, '育儿']
]

function Assistant() {
  this.mode = null
  this.conn = null
  this._voiceCb = null
  this._aiCb = null
  this._simTimer = null
  this._probeDone = false
  // ★ v1.16.325 链活判定状态机（真机反馈「断开后再连上仍显示未连接」）：
  //   旧实现把「连没连」判成了「interconnect 能不能实例化」——可它是单例，
  //   手机断开后照样返回对象 → 一旦探测成 REAL 就永久 REAL，状态再也不会变。
  //   改为靠**手机回 pong** 判活：ping 出去 TIMEOUT 没回 pong 即判断连。
  this._alive = false        // 最近一次 ping 是否收到 pong
  this._pingSeq = 0          // ping 序号（pong 回显，防旧回包误判）
  // ★★★ v1.16.381：连续失败计数。S5 卡顿严重，回包偶发超过 3s 超时线，
  //   单次超时就翻转状态会造成「显示已断开，紧接着又收到 pong」的自相矛盾日志
  //   （真机 13:26 实测：`链活变化：已断开` 之后仍收到 pong seq=8）。
  //   改为连续 2 次超时才判断连 —— 单次抖动不打扰用户，真断开最多多等一个心跳周期。
  this._pingFail = 0
  this._pingTimer = null     // 单次 ping 超时
  // ★★★ v1.16.424：按 seq 保存「本次 ping 的回调」，收到 pong 时才回调 true。
  //   旧实现里 cb 只在三条失败路径被调用（无 conn / 超时 / send 抛异常），
  //   **成功路径一次都没调过** —— 于是所有「等 ping 结果再决定」的调用方
  //   （checkBtStatus / recognize）在链路完全正常时也会一路等到超时，
  //   表现就是用户反馈报的「手机显示已连、手表还是显示未连接」。
  //   用 map 按 seq 存而不是单个字段：心跳 5s 一次、UI 状态检查与语音入口
  //   都会并发发 ping，单字段会互相覆盖、把前一次的回调永久丢失。
  this._pingCbs = {}
  // ★ v1.16.424：定时器同样按 seq 存。旧实现是单字段 `_pingTimer`，
  //   后发起的 ping 会 `clearTimeout` 掉前一个 —— 前一个既不会收 pong 回调
  //   （被后一个的 seq 覆盖）也不会超时回调，它就永久挂住了。
  this._pingTimers = {}
  this._pingSettles = {}   // seq → settled 标记（finish 幂等判据）
  this._hbTimer = null       // 心跳周期
  this._btCb = null          // 蓝牙状态变化回调（UI 订阅）
  this._voiceWaitTimer = null // 语音请求等待看门狗（v1.16.331）
  // 手表录音上传（v1.16.355）：seq 让手机端区分每次录音的分片归属，
  // cancel 用于用户中途退出聆听时及时停麦（否则会一直录到时长上限）。
  this._audioSeq = 0
  this._audioCancel = null
  // v1.16.419：录音上传排空轮询的句柄（原为实现内的局部变量 t，取消语音时清不掉）
  this._uploadTimer = null
  // 语音阶段（v1.16.378）：listen / upload / recognize，用于让页面显示实时状态
  this._voicePhase = ''
  this.onVoicePhase = null
  // ai_chat（v1.16.90）：_chatSeq=自增序号（即协议 qid）；_chatDone=本次请求已消费
  //（超时降级后迟到回包、旧 qid 回包都靠它+序号比对拦截，防双重回调/旧答案污染）
  this._chatCb = null
  this._chatSeq = 0
  this._chatDone = false
  this._chatTimer = null
  // ★★★ v1.16.417 负缓存：require('@system.interconnect') 失败后不再每心跳重试。
  //   v1.16.296 之前 probe 靠「instance() 能拿到对象」判真链路，v1.16.331 改成
  //   _ping 超时就 `conn=null; _probeDone=false`（为修「手机重连后仍显示未连接」），
  //   两者叠加的副作用：**在拿不到 interconnect 的环境（模拟器/老固件）里，
  //   每 5 秒心跳都会重新走一次 require → 每轮抛一次异常**，日志被
  //   「can not find feature: system.interconnect」「Try find feautre in old manager」
  //   「status is not connected, send failed」刷满（实测 25 秒 26 条，约 1 条/秒）。
  //   处理：require 抛异常时记下时间戳，之后按 _probeBackoff 指数退避（上限 64 个心跳）；
  //   期间 probe 直接走 SIM 分支、不再碰 require。退避只为「省日志与省解析开销」，
  //   不影响真机——真机上 require 成功压根不会进这条分支。
  //   任何用户动作（点语音/发 AI/重连蓝牙）都会调 resetProbeBackoff() 立刻重试。
  this._probeFailAt = 0      // 上次 require 失败的时刻（Date.now）
  this._probeBackoff = 1     // 当前退避倍数（心跳周期数）
}

// 探测通道：真链路优先（interconnect 就绪），否则模拟。结果缓存（连接状态变化时 reprobe）。
// ★★★ v1.16.325 链活判定（替代「instance() 能拿到 = 已连接」的旧判据）
//
// 真机反馈（2026-10-30）：手环连上手机时显示正常；手机主动断开后再连回来，
// 蓝牙状态仍一直显示「未连接」；断连时点麦克风也不提示未连接 —— **状态卡死**。
//
// 根因：`interconnect.instance()` 是**单例且连接自动建立**（官方文档），
//       手机断开后它照样返回对象。旧判据一旦探成 REAL 就永久 REAL。
//
// 新判据：**ping/pong 往返**。手环每 HEARTBEAT_MS 发一帧 {type:'ping',seq}，
// 手机端必须回 {type:'pong',seq}；超时 PING_TIMEOUT_MS 没等到 → 判断连。
// 这是唯一能反映「此刻对端在不在」的信号，且不依赖框架未实现的那三个 API。
var HEARTBEAT_MS = 5000
var PING_TIMEOUT_MS = 3000
// ★ v1.16.385：链路诊断日志总开关。
//   原先「收到帧」「ping fail」两处 console.log 是**无条件**打印的：
//     · 蓝牙未连时每 5s 一条 ping fail，一直刷；
//     · _bindReal 为了打前 80 字符，对**每一帧**都做一次完整 JSON.stringify，
//       而 console 在真机走串口同步写，这本身就是可观开销。
//   排查链路时改回 true 即可恢复全部明细。
var DEBUG_LINK = false
// 语音请求的最长等待：手机端链路 ≤10s（BandSession 上限）→ 这里 11s 先给原因，
// 页面里 12s 的「强制退出聆听」只是界面兜底，不负责报错。
// v1.16.355：改为**手表自己录音 + 上传 + 手机识别**，整链比旧方案多出
// 「录音时长 + 分片上传」两段，故放宽到 20s（录音最多 6s + 上传约 2s + 识别约 8s + 余量）。
// 35 秒：这个看门狗要覆盖「录音 3s + record.stop() 阻塞 12s + 上传 ~0.5s + 手机识别 ~1s」。
// ★ v1.16.372：原 20000 不够 —— S5 的 record.stop() 实测同步阻塞 12 秒（等 PCM 刷盘），
//   加上录音本身 3s 就吃掉 15s，上传与识别再占 1.5s，20s 会在识别结果回来前就超时。
var VOICE_WAIT_MS = 35000

/**
 * 探一次活：发 ping，等 pong。结果同时更新 this._alive 并回调。
 * 不缓存——每次调用都是一次真实往返，这正是修复的关键。
 */
Assistant.prototype._ping = function (cb) {
  var self = this
  // ★★ 关键：conn 可能还没拿到。心跳在 app.ux.onCreate 就启动，那一刻框架的
  //   interconnect 往往尚未就绪 → instance() 返回空 → 旧实现直接判「断开』，
  //   而且心跳的 tick 只调 _ping、不调 probe，于是**永远拿不到 conn**，
  //   表现为「手环一条 ping 都发不出去」（真机实测 launch.log 为 0 字节）。
  //   这里先确保 conn 存在：没有就借 probe() 再拿一次（probe 内部幂等）。
  if (!this.conn) {
    this.probe(function () {})
  }
  var conn = this.conn
  if (!conn) {
    // ★ v1.16.355 诊断：区分「conn 拿不到」与「conn 有但发不出去」。
    //   之前只看到「语音入口拦截：蓝牙未连接」，无法判断是 interconnect.instance()
    //   返回空，还是 ping 发出去了但没有 pong 回来 —— 两种情况修法完全不同。
    // ★ v1.16.385：加次数上限。蓝牙一直不可用时这里每 5s 触发一次，
    //   原先会永久刷同一条日志（_vlog 同时写 console 与 runtime log）。
    //   前 3 次足够定位「开机瞬间拿不到」还是「一直拿不到」，之后不再重复。
    this._noConnLog = (this._noConnLog || 0) + 1
    if (this._noConnLog <= 3) {
      this._vlog('ping 失败：interconnect 未就绪（instance() 返回空）第' + this._noConnLog + '次')
    }
    // 同样走连续失败计数：框架刚启动时 instance() 可能短暂返回空，
    // 一次拿不到就判断开会让界面在开机瞬间闪红。
    this._pingFail++
    if (this._pingFail >= 2) this._setAlive(false)
    cb(false); return
  }
  var seq = ++this._pingSeq
  // ★★★ v1.16.424：本次 ping 的收尾全部挂在 seq 上，不再共用单字段。
  //   finish 自带幂等（_pingSettles[seq]）：超时 / send 异常 / pong 三条路径
  //   谁先到谁生效，其余全部空转，不会出现「先回 true 再回 false」把状态拽回去。
  var self2 = self
  function finish(ok) {
    if (self2._pingSettles[seq]) return
    self2._pingSettles[seq] = true
    delete self2._pingCbs[seq]
    var t = self2._pingTimers[seq]
    if (t) { clearTimeout(t); delete self2._pingTimers[seq] }
    if (self2._pingWaiter === seq) self2._pingWaiter = 0
    try { cb(ok) } catch (e) {}
  }
  this._pingCbs[seq] = finish
  this._pingSettles[seq] = false
  var prevTimer = this._pingTimers[seq]
  if (prevTimer) clearTimeout(prevTimer)
  this._pingTimers[seq] = setTimeout(function () {
    delete self._pingTimers[seq]
    if (self._pingSettles[seq]) return
    if (self._pingWaiter === seq) self._pingWaiter = 0
    // ★★★ v1.16.331 关键修复（真机反馈「手机重连后手环仍显示未连接」）：
    //   超时即**丢掉缓存的 conn**。手机主动断开后框架会销毁这条连接，
    //   而 `instance()` 给的是已死对象；旧实现把 conn 永久缓存
    //   （probe 里 `if (this._probeDone && this.conn) return`），于是手机重连后
    //   我们还在往死对象 send，pong 永不回来 → 界面永久卡在「未连接」。
    //   置空后下一次 _ping 会重新 instance() + 重新 _bindReal，
    //   手机重新连上时第一次心跳就能自动恢复。
    // ★★★ v1.16.422 修复：这里原先写成 `this._vlog`。本行位于
    //   `setTimeout(function () {...})` 回调体内，回调是被宿主以无接收者方式调用的，
    //   `this` 既不是 Assistant 实例也不是 window，而是 undefined →
    //   抛 `TypeError: cannot read property '_vlog' of undefined`（真机 dmesg 实锤，4 次）。
    //   危害远不止少一条日志：异常打断回调，导致紧随其后的
    //   `self.conn = null` / `self._probeDone = false` / `self._setAlive(false)`
    //   全部不执行 —— 恰好把 v1.16.331「超时丢弃缓存 conn，手机重连后自动恢复」的
    //   自愈逻辑整段废掉，表现为手机重连后手环可能永久停在「未连接」。
    //   同一回调内的其它调用（self._pingTimer、self._pingFail、self._setAlive）本来就
    //   已经写成 self.，只有这一行漏了。
    if (seq <= 3) self._vlog('ping 超时：已发出但未收到 pong seq=' + seq)
    // ★★★ v1.16.424：**不再无条件丢弃 conn**。
    //   旧实现每次超时都执行 `self.conn = null` + `_probeDone = false`，
    //   而并发 ping（心跳 5s / 首页 checkBtStatus / 语音入口）会互相把对方的
    //   conn 清掉再各自重新 instance() —— 产生大量「新鲜但陌生」的 conn 对象，
    //   这些对象上的 onmessage 是否已绑好完全不确定，正是「手机一直在回 pong、
    //   手表却收不到」的重要成因之一。现在只在**连续失败到阈值**时才丢弃，
    //   与下面「单次抖动不判断连」的既有策略保持同一口径。
    // ★★★ v1.16.381：单次超时不判断连。
    //   S5 卡顿会让 pong 迟到超过 3s，旧实现立刻翻转 → 日志出现
    //   「链活变化：已断开」紧跟「收到 pong」，界面闪一下又变回来。
    //   连续 2 次收不到才认作真断开：单次抖动被吸收，真断开最多多等一个心跳周期。
    self._pingFail++
    if (self._pingFail >= 2) {
      self.conn = null
      self._probeDone = false
      self._setAlive(false)
    } else if (seq <= 3) {
      self._vlog('ping 超时一次，暂不判断连（连续失败=' + self._pingFail + '）')
    }
    finish(false)
  }, PING_TIMEOUT_MS)
  try {
    // ★ v1.16.362 诊断：确认 ping 真的发出去了。计时器超时分支只写「未收到 pong」，
    //   无法区分「send 抛异常/被拒」与「发出去了但对端没回」，两者修法完全不同。
    //   只打前 3 次：S5 本身卡，每 5s 一条会污染日志并增加 IPC 开销。
    if (seq <= 3) this._vlog('发送 ping seq=' + seq)
    conn.send({
      // ★ v1.16.436：临时诊断字段已随 IcBus 修复撤除（rx/busrx/subs/bt/fwd 等）。
      //   保留一个极轻的 rx 计数，用于将来一眼判断「下行还活着吗」——
      //   它随 ping 上行，不额外占帧（ping 本来每 5s 一帧）。
      data: { type: 'ping', seq: seq, rx: (this._rxCount || 0) },
      // ★★ fail 回调【不可作为断连判据】——真机实测（icprobe 1.1.1，2026-10-31 01:13）：
      //     手环发了 125 条遥测，手机端**全部收到**（launch.log 有完整 JSON），
      //     而手环侧统计是 soFail=116 / soOK=9 / soCode="undefined" ——
      //     即 fail 被大量误触发。若拿 fail 当断连判据，链路明明是通的也会一直显示未连接。
      //     唯一的真实判据是**收到 pong**。
      fail: function (e) {
        // 不判定失败，只提前结束等待（fail 也可能在 pong 到达前触发）
        // v1.16.363：把错误内容完整打出来。只打空串等于没诊断 ——
        //   interconnect 的 fail 参数里带 code/data，是区分「权限不足」「对端不在」
        //   与「框架内部错误」的唯一线索。
        // ★ v1.16.385：改为受 DEBUG_LINK 控制。蓝牙未连时这里每 5s 触发一次，
        //   原先无条件打印会持续刷串口日志；且每次都要 JSON.stringify 整个错误对象。
        if (!DEBUG_LINK) return
        try {
          var d = ''
          try { d = JSON.stringify(e) } catch (x2) { d = String(e) }
          console.log('[VOICE] ping fail seq=' + seq + ' detail=' + (d || '(空)'))
        } catch (x) {}
      }
    })
  } catch (e) {
    // 抛异常说明这条 conn 本身已不可用（对象被销毁/参数非法）——
    // 与超时同样处理：作废缓存，下次重新 instance()。
    // 是否判断连交给连续失败计数，避免一次异常就闪成断开。
    // ★ v1.16.424：不再用局部 `settled` 判幂等（它已随按-seq 改造移除），
    //   统一交给 finish() 内部的 _pingSettles[seq] —— 三条路径共用一套幂等。
    self.conn = null
    self._probeDone = false
    self._pingFail++
    if (self._pingFail >= 2) self._setAlive(false)
    finish(false)
  }
}

/** 更新链活状态，变化时通知 UI（避免同一状态反复触发重渲染） */
Assistant.prototype._setAlive = function (alive) {
  var changed = (this._alive !== alive)
  this._alive = alive
  this.mode = alive ? MODE.REAL : MODE.SIM
  if (!changed) return
  var cb = this._btCb
  if (typeof cb === 'function') { try { cb(alive) } catch (e) {} }
}

/** 订阅蓝牙状态变化（UI 用；只保留一个订阅者，后订覆盖先订） */
Assistant.prototype.onBtChange = function (cb) {
  this._btCb = cb
}

/**
 * 起心跳：登录后周期探活，界面无需自己轮询。
 *
 * ★★★ v1.16.331 修正：**去掉「断连时放慢到 2 倍周期」**。
 *   旧逻辑断连后改成 10s 一探，用意是省电，实际代价是「手机重新连上后
 *   界面要多等 10s 才变回已连接」—— 真机反馈正是「手机再连上一遍，
 *   上面还是显示蓝牙未连接」。手环上这个应用只在前台跑，5s 一次 ping
 *   的功耗可以忽略；状态跟随的快慢才是用户唯一能感知的东西。
 *   现在恒定 HEARTBEAT_MS（5s）：断开最迟 3s(超时)+5s = 8s 内反映，
 *   重连最迟 5s 内恢复。
 */
Assistant.prototype.startHeartbeat = function () {
  var self = this
  if (this._hbTimer) return
  function tick() {
    self._ping(function () {})
  }
  this._hbTimer = setInterval(tick, HEARTBEAT_MS)
  tick()
}

Assistant.prototype.stopHeartbeat = function () {
  if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null }
  if (this._pingTimer) { clearTimeout(this._pingTimer); this._pingTimer = null }
  // ★ v1.16.424：按 seq 的定时器与回调也要一并清，否则停止心跳后
  //   残留的 setTimeout 仍会在 3s 后把 conn 置空、把状态判成断开。
  var k
  if (this._pingTimers) { for (k in this._pingTimers) { if (this._pingTimers[k]) clearTimeout(this._pingTimers[k]) } this._pingTimers = {} }
  this._pingCbs = {}
  this._pingSettles = {}
  this._pingWaiter = 0
  this._pingFail = 0
}

// ★★ v1.16.296 关键修复（2026-10-18 icprobe 探针实测实锤）：
//    手环 9 框架上 getReadyState / diagnosis / getApkStatus 【均未实现】——
//      · getReadyState → 抛异常（雷词 "not a function"）
//      · diagnosis     → 抛 "throw:not a function"
//      · getApkStatus  → 回调超时（'TIMEOUT'）
//    旧实现把 getReadyState 当唯一判据：抛异常 → 落 catch → 永远判 MODE.SIM
//    →【真链路永远不启用，ai_chat 从未发出】。这正是蓝牙功能"看起来没连上"的根因。
//    实测唯一可用的 API 是 conn.send（success 回调正常，电脑侧确实收到 subtype=9）。
//    → 改为「interconnect 能实例化即按 REAL 试，发送失败/静默则由 _sendReal 降级 SIM」。
Assistant.prototype.probe = function (onReady) {
  var self = this
  // 已拿到 conn 并绑过回调 → 直接用【当前】链活状态，不重复 bind
  if (this._probeDone && this.conn) { onReady(this._alive ? MODE.REAL : MODE.SIM); return }
  // ★★★ v1.16.417 退避窗口：上次 require 失败且退避期未过 → 直接按 SIM 返回，不碰 require。
  //   退避换算成真实时间：_probeBackoff 个心跳周期（HEARTBEAT_MS）。
  //   首次失败后 _probeBackoff 变 2 → 窗口 10s，之后 4/8/16/32/64 周期（20s→320s）。
  //   足够把「无 interconnect 环境」的日志从约 1 条/秒压到接近静默；
  //   真机插上手机后最坏 5 分钟内也会自己重试成功，用户点语音/发 AI 更是立即重置。
  var backoffMs = HEARTBEAT_MS * (this._probeBackoff || 1)
  if (this._probeFailAt && (Date.now() - this._probeFailAt) < backoffMs) {
    this.mode = MODE.SIM
    onReady(this.mode)
    return
  }
  try {
    // ★ v1.16.418：走模块级缓存（getInterconnect），避免每 5s 重走 require 查找链
    var interconnect = getInterconnect()
    this.conn = interconnect.instance()
    // ★ v1.16.425 诊断：instance() 每次是不是给同一个对象？
    //   若每次都是新对象，而 send 用的新对象、onmessage 挂在旧对象上，
    //   就会精确表现成「上行通、下行零收帧」（rx 永远 0）。
    try {
      this._instCount = (this._instCount || 0) + 1
      if (this.conn) {
        if (!this.conn.__aeConnId) { try { this.conn.__aeConnId = 'c' + this._instCount } catch (e) {} }
        this._connId = this.conn.__aeConnId || '?'
      }
    } catch (e) {}
    if (this.conn) {
      this._probeBackoff = 1   // v1.16.417：require 成功即清零退避
      this._bindReal(this.conn)
      // ★★★ v1.16.388：补调 BtTransfer 的接收器。
      //   app.ux 在 onCreate 就调 initBtReceiver()，那一刻框架的 interconnect
      //   往往还没就绪 → 它落 catch 后**再没人调第二次** → cfg-query / ds-* 帧
      //   永久无人处理（语音/心跳却正常，因为它们走本文件这条包装链）。
      //   真机现象正好对上：cfg-query 帧发出去了（conn.log 有 17B 的「已发帧」），
      //   手环却一条 [BT-DS] 日志都没有，cfg-state 永不回来。
      //   放在这里是因为此刻 conn 一定非空、且 probe 幂等（_probeDone 为真时不会重入）。
      try { initBtReceiver() } catch (e) {}
    }
  } catch (e) {
    // 模拟器上 interconnect 通常不可 require 或无对端 → 连接不可用
    this.conn = null
    // ★ v1.16.417：记下失败时刻并抬退避倍数（指数增长，上限 64 个心跳周期）。
    this._probeFailAt = Date.now()
    this._probeBackoff = Math.min((this._probeBackoff || 1) * 2, 64)
  }
  this._probeDone = true
  // ★ mode 不再由「能否实例化」决定：instance() 是单例，对端断开了也照样给对象。
  //   先按「未活」起步，由心跳/首次 ping 的真实往返来翻转。
  this.mode = this._alive ? MODE.REAL : MODE.SIM
  onReady(this.mode)
}

// ★★★ v1.16.417：用户动作触发的退避重置。
//   负缓存（_probeFailAt + _probeBackoff）只压「无 interconnect 环境」的日志噪声，
//   但它的退避窗口最长 320s —— 如果用户此刻正要点语音/发 AI（或刚连上手机），
//   等窗口过完才重试显然不可接受。所以凡是有明确用户意图的入口，先清零退避再走 probe。
//   影响面：真机上 require 本来就成功、_probeFailAt 恒为 0，调用只是空操作。
Assistant.prototype.resetProbeBackoff = function () {
  this._probeFailAt = 0
  this._probeBackoff = 1
}

// 真链路发送 + 自动降级。
// ★ 判据只用 send 的【fail 回调】与【抛异常】——它们是确定性的失败信号。
//   ⚠️ 不要用「N 秒内无 success」当失败：send 的 success 回调在部分框架版本上可能
//   迟迟不来/不来（icprobe 实测：object 形态实际送达且电脑侧收到 subtype=9，
//   但应用侧 success 回调时序不可依赖）。若用超时判失败，会把正常的真链路
//   误打成 SIM（ai_chat 是异步应答，更会被误判）。链路是否可用由业务层超时兜底。
// 说明：官方契约 data 必须传【对象】（框架自动序列化为 JSON 文本）；
//      传 JSON 字符串会被 fail 拒绝 —— icprobe 实测：string 形态失败、object 形态成功。
Assistant.prototype._sendReal = function (payload, simFallback) {
  var self = this
  var conn = this.conn
  function degrade() {
    self.mode = MODE.SIM
    try { simFallback() } catch (e) {}
  }
  if (!conn) { degrade(); return }
  try {
    conn.send({
      data: payload,
      // ★★ fail 回调不可信，不能据此降级 —— 真机实测（icprobe 1.1.1，2026-10-31）：
      //     手环侧 soFail=116 / soOK=9，而手机端实际上**完整收到**了这些帧。
      //     旧实现在 fail 时立刻 degrade 到 SIM，会让「链路明明通」也重返模拟答案
      //     （用户看到的就是「只模拟、不真识别」）。
      //     真失败由业务层超时兜底，不在这里猜。
      fail: function () {}
    })
  } catch (e) {
    // 只有 send 本身抛异常（连 conn 都没有、参数非法）才降级
    degrade()
  }
}

// 绑定真链路消息（手机 App 的应答）
// ⚠️ 包装链（审查修复）：BtTransfer（蓝牙资料接收）也在这条通道设 conn.onmessage，
// 直接赋值会互相覆盖。保留原 handler，非本模块消息转发过去，两模块都能收到。
Assistant.prototype._bindReal = function (conn) {
  var self = this
  // ★★★ v1.16.435：不再自己挂 conn.onmessage（会与 BtTransfer 抢，且读回恒 undefined
  //   导致转发链断裂）。改为把 conn 交给 IcBus 统一持有，本模块只订阅。
  try {
    IcBus.attach(conn)
    IcBus.on('assistant', function (data) { _aeHandlerRef(data) })
  } catch (e) {}
  if (conn.__aeBusBound === true) { /* 已订阅过 */ }
  try { conn.__aeBusBound = true } catch (e) {}
  // ★★★ v1.16.435：本函数只**定义** handler 并交给 IcBus 分发，不再碰 conn.onmessage。
  //   旧实现（包装链）有两个致命前提，在真机上都不成立：
  //     ① `var prevHandler = conn.onmessage` —— 读回恒 undefined（只有 setter）；
  //     ② 担心「被别的模块覆盖」—— 现在由 IcBus 统一持有，不存在覆盖。
  //   真机诊断 noprev=4/fwd=0/rx=0 就是 ① 的直接后果。
  if (conn.__aeDispBound === true) return
  try { conn.__aeDispBound = true } catch (e) {}
  _aeHandlerRef = function (data) {
    var handled = false
    // ★ v1.16.425 接收侧计数（诊断用，见 ping 帧里的 rx/pongs/last）
    try {
      self._rxCount = (self._rxCount || 0) + 1
      self._rxLast = (typeof data === 'string') ? data : JSON.stringify(data)
    } catch (e) {}
    // v1.16.176（提交前审查修复 C3）：双兼容 —— 官方互联层可能以 {data:'<json>'} 包装投递，
    // 也可能直接投递裸字符串/对象（同通道的 BtTransfer 已按此兼容）。原实现只解析包装形态，
    // 裸投递时语音/AI 结果会完全收不到（真链路静默失败）。
    var payload = data
    if (data && typeof data === 'object' && typeof data.data === 'string') payload = data.data
    // ★ v1.16.363 诊断：确认手环到底有没有收到任何帧。
    //   此前只加了「发送 ping」日志，看到 ping fail 却无法区分
    //   「手机没回」与「回了但手环没收到」—— 后者说明是投递链路的问题，不是业务层。
    // ★ v1.16.385：改为受 DEBUG_LINK 控制。这行对**每一帧**都先做一次
    //   JSON.stringify 再切前 80 字符，链路正常通信时是纯浪费；
    //   而且 pong 每 5s 一帧，日志会一直刷。
    if (DEBUG_LINK) {
      try {
        var _dbg = (typeof payload === 'string') ? payload.slice(0, 80) : JSON.stringify(payload).slice(0, 80)
        console.log('[VOICE] 收到帧: ' + _dbg)
      } catch (e) {}
    }
    if (payload) {
      var msg = null
      try { msg = (typeof payload === 'string') ? JSON.parse(payload) : payload } catch (e) { msg = null }
      // ★ pong = 手机对 ping 的应答，是「此刻链路是否真正连通」的唯一可信信号
      if (msg && msg.type === 'pong') {
        try { self._rxPongs = (self._rxPongs || 0) + 1 } catch (e) {}
        // ★★★ v1.16.424：**按 seq 唤醒对应的等待回调**，这是本次真修复的核心。
        //   旧实现在这里只做 _setAlive(true)，从不调用 _ping 的回调；
        //   而 _ping 的三条失败路径都调 cb(false) —— 于是调用方只有「失败」与
        //   「永不回调直到看门狗」两种结果，链路明明正常也报未连接。
        //   必须按 seq 取，不能取「当前唯一回调」：心跳(5s)、首页状态检查、
        //   语音入口三处会并发发 ping，用单字段会张冠李戴。
        var woke = false
        if (self._pingCbs && self._pingCbs[msg.seq]) {
          var fn = self._pingCbs[msg.seq]
          delete self._pingCbs[msg.seq]
          try { fn(true) } catch (e) {}
          woke = true
        }
        if (self._pingWaiter && msg.seq === self._pingWaiter) {
          self._pingWaiter = 0
          if (self._pingTimer) { clearTimeout(self._pingTimer); self._pingTimer = null }
          self._pingFail = 0     // ★ v1.16.381：收到 pong 即清零连续失败计数
          self._noConnLog = 0    // v1.16.385：链路恢复后重置「拿不到 conn」的日志配额
          self._setAlive(true)
        } else if (!self._pingWaiter || woke) {
          // 迟到的 pong（对应已被判超时的那次 ping，或另有并发 ping 在等）。
          // 它证明链路其实是活的，所以也要把状态与失败计数拉回来 ——
          // 否则会出现「判了断开、其实一直通」。
          self._pingFail = 0
          self._noConnLog = 0
          self._setAlive(true)
        }
        handled = true
      } else if (msg && msg.type === 'voice_partial') {
        // ★★★ v1.16.446 流式识别（2026-11-03）：手机边识别边把已出的字回传，
        //   手表上就能看到字在长，而不是等录完再等整段识别。
        //   这条帧不算链路铁证（它是业务流的一部分），但能证明链路活着，
        //   所以同样把心跳失败计数清零。
        self._pingFail = 0
        self._noConnLog = 0
        if (self._pingTimer) { clearTimeout(self._pingTimer); self._pingTimer = null }
        self._pingWaiter = 0
        self._setAlive(true)
        var ptext = (msg.text || '').trim()
        if (ptext && self._voicePhase === 'listen') {
          // 还在录就在出字了 → 切到「实时识别」阶段，页面据此把字幕显示出来
          self.setVoicePhase('partial', ptext)
        }
        handled = true
      } else if (msg && msg.type === 'voice_result') {
        // 能收到回包本身就是链活铁证（无需等下一次心跳）
        self._pingWaiter = 0
        if (self._pingTimer) { clearTimeout(self._pingTimer); self._pingTimer = null }
        self._pingFail = 0
        self._noConnLog = 0
        self._clearVoiceWait()   // v1.16.331：回包到了，撤掉「手机没有响应」看门狗
        self._setAlive(true)
        if (self._voiceCb) {
          // ★★★ v1.16.331：text 为空 = 识别失败（手机端不再用「未识别」占位）。
          //   旧实现无条件回 ok:true，于是「未识别」被当成搜索词拿去搜索。
          var vtext = msg.text || ''
          if (vtext) {
            self._voiceCb({ ok: true, text: vtext, mode: MODE.REAL })
          } else {
            self._voiceCb({ ok: false, reason: msg.reason || '没听清，请再说一次' })
          }
        }
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
  }
}

// v1.16.114 蓝牙状态实时查询（首页提示块的连接指示用）：
// ★ v1.16.296 修复：旧实现用 conn.getReadyState 判定，而手环 9 框架【未实现该 API】（抛 "not a function"）
//   → 旧实现永远走 catch → cb(false) → 首页永远显示"未连接"。
//   改为「interconnect 可用 + 最近一次 send 未失败」即视为已连接。
// ★★ v1.16.324 修复（真机反馈「连上了也显示蓝牙未连接」）：
//   `this.mode` 初值是 null，而 probe() 只在「点语音/AI」时才跑 —— 首页在用户
//   还没用过语音前就调 checkBtStatus，读到 null → 必然 cb(false)。
//   interconnect 是单例且「连接自动建立」（官方文档），能实例化即说明对端链路存在，
//   所以这里没探测过就按 probe 的同一判据现探一次，而不是读一个可能还没赋值的字段。
Assistant.prototype.checkBtStatus = function (cb) {
  var self = this
  // ★★★ v1.16.325：**每次都真实探活**（ping → 等 pong），不再读缓存的 mode。
  //   旧实现读的是「探测过一次的结论」，而 interconnect.instance() 在对端断开后
  //   仍返回对象 → 状态一旦成 REAL 就永久 REAL，这就是「断开再连仍显示未连接」的根因。
  this.probe(function () {
    self._ping(function (alive) { cb(alive) })
  })
}

// ============ 语音搜索 ============
// 唯一真实链路（v1.16.331 起没有模拟链路）：向手机发 voice_search →
// 手机用系统识别服务录手机麦克风做 ASR → 回 voice_result{text}。
// 手环侧 @system.record 实测 `start 不是函数`（小米手环 9 官方也不支持），
// 因此「手环自己录音」这条路不存在，只能由手机收音。
Assistant.prototype.recognize = function (cb) {
  var self = this
  this._voiceCb = cb
  // ★ v1.16.417：用户点了语音 → 立即清掉 interconnect 负缓存退避，马上重试真链路
  this.resetProbeBackoff()
  // ★★★ v1.16.378：语音阶段回调。原来整段流程对用户是黑盒 —— 点完麦到出结果
  //   中间十几秒，界面只有一句静止的提示，用户不知道是在录、在上传、还是在识别。
  //   现在每进入一个阶段就通知页面一次，页面把文案换掉（听→上传→识别）。
  this._voicePhase = 'listen'
  this._emitPhase()
  this.cancelSim()
  // ★★★ v1.16.331：本端等待看门狗。页面里还有 12s 的「强制退出聆听」兜底，
  //   但它只关界面**不回调** —— 于是「手机收到请求却没回包」时用户只看到界面
  //   自己消失、没有任何原因说明。这里主动回调失败原因，让提示条能显示出来。
  //   v1.16.355 放宽到 20s：链路改成「手表录音 3s → 上传 → 手机识别」，
  //   旧的 11s 是按「手机麦克风录音 ≤9.5s」估的，不适用了。
  if (this._voiceWaitTimer) { clearTimeout(this._voiceWaitTimer); this._voiceWaitTimer = null }
  this._voiceWaitTimer = setTimeout(function () {
    self._voiceWaitTimer = null
    if (!self._voiceCb) return
    self._voiceCb = null
    cb({ ok: false, reason: '手机没有响应，请检查 App 是否在前台' })
  }, VOICE_WAIT_MS)

  this.probe(function () {
    // ★★★ v1.16.325：未连通时**不再用固定词表假装识别**。编造识别结果比不答更坏。
    // ★★★ v1.16.334：心跳已判定连通时直接发，不再白等一次 ping（3s）。
    if (self._alive === true) { startCapture(); return }
    self._ping(function (alive) {
      if (!alive) {
        self._clearVoiceWait()
        self._voiceCb = null
        cb({ ok: false, reason: '蓝牙未连接，请先在手机 App 内连接手环' })
        return
      }
      startCapture()
    })
  })

  // ---------- 手表录音 → 分片上传 → 等手机识别结果 ----------
  function startCapture() {
    var seq = ++self._audioSeq
    self._audioCancel = null
    var frames = 0
    // 帧排队再发：录音回调里同步连发几十帧会把 interconnect 堵住，
    // 而且 send 的 fail 回调本身不可信（见 _sendReal 注释），只能靠节奏控制。
    var pq = []
    var draining = false
    // ★★★ v1.16.445 真机根因（2026-11-03 09:2x，mock 复现）：
    //   用户「录音中取消」时，drain 队列里还有若干未发出的分片，
    //   而 cancelVoice 只置 _audioCancel=null、并不清这个队列，
    //   drain 的递归 setTimeout 也不看有没有被取消 ——
    //   于是下一段录音一开始，**上一段的残余分片与新的分片交错发出去**。
    //   手机端 AudioAssembler 见 seq 变了就重建会话并丢弃已收片，
    //   结果是新录音只剩零星几片能拼上（mock 实测 6 片只拼到 2 片），
    //   识别必然拿不到可用音频 → 用户看到的还是「没听见」。
    //   修法：给每段录音一个 token，drain 逐步检查；取消时立刻清空队列。
    var cancelToken = { cancelled: false }
    self._audioDrain = {
      cancel: function () {
        cancelToken.cancelled = true
        pq.length = 0
        draining = false
      },
    }
    function drain() {
      if (draining) return
      draining = true
      var next = function () {
        // 已取消：立刻停，不把残余分片发给手机。
        if (cancelToken.cancelled) { draining = false; pq.length = 0; return }
        if (!pq.length) { draining = false; return }
        var f = pq.shift()
        self._sendReal({ type: 'audio', seq: seq, i: f.i, data: f.data }, function () {})
        setTimeout(next, 15)
      }
      next()
    }

    self._audioCancel = captureVoice({
      log: function (m) { self._vlog('录音: ' + m) },
      onFrame: function (b64, idx) {
        frames++
        pq.push({ i: idx, data: b64 })
        if (pq.length === 1) drain()
      },
      done: function (r) {
        self._audioCancel = null
        if (!self._voiceCb) return
        if (!r.ok) {
          self._clearVoiceWait()
          self._voiceCb = null
          cb({ ok: false, reason: r.reason || '录音失败' })
          return
        }
        // 等到队列排空再发 audio_end，否则手机会先收到结束帧、把后到的数据当新会话
        self.setVoicePhase('upload')
        var waited = 0
        // ★ v1.16.419：句柄存到 this._uploadTimer，别用局部变量 ——
        //   原来这里的 t 是闭包局部变量，cancelVoice() 完全看不到它：
        //   用户中途取消语音后这个 100ms 轮询仍会空转到 8 秒截止才自己退出，
        //   期间每 100ms 白跑一次（含一次 drain 条件判断）。
        //   存句柄后 cancelVoice / _clearVoiceWait 能立刻清掉，取消即停。
        self._uploadTimer = setInterval(function () {
          waited += 100
          if (pq.length > 0 && !draining) drain()
          if (pq.length > 0 && waited < 8000) return
          if (self._uploadTimer) { clearInterval(self._uploadTimer); self._uploadTimer = null }
          if (!self._voiceCb) return
          self._vlog('录音上传完成 帧=' + frames + ' 字节=' + r.bytes)
          self.setVoicePhase('recognize')
          // audio_end 之后手机做识别，回包仍是 voice_result（复用既有分支）
          // ★ v1.16.450 诊断：把采集端统计塞进 audio_end 回传（手机侧只读取不参与逻辑）
          self._sendReal({ type: 'audio_end', seq: seq, frames: frames, bytes: r.bytes,
            rawFrames: r.rawFrames, rawBytes: r.rawBytes, voicedAt: r.voicedAt,
            dropped: r.dropped, peak: r.peak, threshold: r.threshold }, function () {
            self._clearVoiceWait()
            self._voiceCb = null
            cb({ ok: false, reason: '发送失败，链路可能已断开' })
          })
        }, 100)
      },
    })
    if (self._audioCancel === null) {
      // captureVoice 同步失败时已经调过 done()，这里不必再做事
    }
  }
}

/**
 * 设置语音阶段并通知页面。
 * 阶段：listen（正在听）/ upload（正在上传）/ recognize（正在识别）
 * 页面拿到后把提示文案换掉，用户就知道现在卡在哪一步、还要不要等。
 */
Assistant.prototype.setVoicePhase = function (p, text) {
  // partial 是内容态，允许同 phase 反复更新（文本在长）
  if (p === 'partial') { this.setVoicePartial(text); return }
  if (this._voicePhase === p) return
  this._voicePhase = p
  this._emitPhase()
}

Assistant.prototype._emitPhase = function () {
  var fn = this.onVoicePhase
  if (typeof fn !== 'function') return
  var map = {
    listen: '正在聆听，请对着手表说话',
    upload: '正在上传录音…',
    recognize: '正在识别…',
  }
  try { fn(this._voicePhase, map[this._voicePhase] || '') } catch (e) {}
}

/**
 * 推送实时识别文本（流式 partial）。
 * 与 setVoicePhase 分开：phase 用于状态机，partial 是内容，会连续变化。
 */
Assistant.prototype.setVoicePartial = function (text) {
  this._voicePartial = text || ''
  var fn = this.onVoicePhase
  if (typeof fn !== 'function') return
  try { fn('partial', this._voicePartial) } catch (e) {}
}

/** 语音链路日志：走应用统一日志（app.ux 的 addRuntimeLog），拿不到就静默 */
Assistant.prototype._vlog = function (msg) {
  // ★ v1.16.362：同时打 console。原因：addRuntimeLog 只写进 UI 的运行时日志面板，
  //   不会进 console，而真机排障唯一能远程拿到的是 CDP 的 console 通道
  //   （IDE MQTT 的 Runtime.consoleAPICalled）。只写 UI 日志等于黑盒。
  try { console.log('[VOICE] ' + msg) } catch (e) {}
  try {
    if (typeof global !== 'undefined' && global.addRuntimeLog) {
      global.addRuntimeLog('语音 ' + msg, 'info')
    }
  } catch (e) {}
}

/** 用户中途退出聆听时停麦并清掉上传状态（不回调结果，由调用方自己决定 UI） */
Assistant.prototype.cancelVoice = function () {
  if (this._audioCancel) {
    try { this._audioCancel.cancel() } catch (e) {}
    this._audioCancel = null
  }
  // ★ v1.16.445：取消时必须把未发完的分片队列一起作废 ——
  //   否则残余分片会与下一段录音交错发出，手机端 AudioAssembler 反复切会话、
  //   新录音只剩零星几片能拼上（mock 实测 6 片只拼到 2 片）。
  if (this._audioDrain) {
    try { this._audioDrain.cancel() } catch (e) {}
    this._audioDrain = null
  }
  // v1.16.419：连上传排空轮询一起清 —— 取消后队列不会再有新帧，
  // 留着这个 100ms 轮询只会空转到 8 秒截止，纯烧电。
  if (this._uploadTimer) { clearInterval(this._uploadTimer); this._uploadTimer = null }
  this._clearVoiceWait()
}

/** 清掉语音等待看门狗（成功/失败/取消都要清，否则会误杀下一轮） */
Assistant.prototype._clearVoiceWait = function () {
  if (this._voiceWaitTimer) { clearTimeout(this._voiceWaitTimer); this._voiceWaitTimer = null }
}

// ============ AI 搜索 ============
// 真链路：把问题发到手机 App（云端大模型应答）
// 模拟链路：本地"问答理解"（同义词归一）→ 真实搜索引擎检索 → 模板摘要生成回答。
//          回答内容由检索结果真实拼出，问题不同则回答不同，非固定文案。
Assistant.prototype.answer = function (question, searchFn, cb) {
  var self = this
  this._aiCb = cb
  // ★ v1.16.417：用户发 AI 搜索 → 清负缓存退避，马上重试真链路
  this.resetProbeBackoff()
  this.cancelSim()
  this.probe(function (mode) {
    if (mode === MODE.REAL) {
      self._sendReal({ type: 'ai_search', q: question }, function () { self._simAI(question, searchFn, cb) })
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
// v1.16.99 AI 式作答（设计定案）：不再「共找到 N 条资料：1.标题 2.标题」式罗列，
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
  // ★ v1.16.417：用户发 AI 问答 → 清负缓存退避，马上重试真链路
  this.resetProbeBackoff()
  this._chatSeq++            // qid 自增：新问题新序号，旧应答按序号失配丢弃
  var qid = this._chatSeq
  var seq = qid              // 闭包序号：探测回调返回时校验请求未被更新的替换
  var keyword = this._understand(question)
  this.cancelSim()
  if (this._chatTimer) { clearTimeout(this._chatTimer); this._chatTimer = null }
  this.probe(function (mode) {
    if (seq !== self._chatSeq) return   // 期间又发起了新问题，过期探测直接丢弃
    if (mode === MODE.REAL) {
      // 12s 超时降级：手机端未一次性回包（大模型超时/断连）→ 走本地模拟，保证任何环境可用
      function chatFallback() {
        if (self._chatDone || seq !== self._chatSeq) return
        if (self._chatTimer) { clearTimeout(self._chatTimer); self._chatTimer = null }
        self._chatDone = true   // 置位后迟到的 ai_chat_result 在分发处被拦截，不会双重回调
        self._simChat(question, searchFn, cb)
      }
      // v1.16.311：先本地检索取来源，再随 ai_chat 一并下发手机端
      //（手机端把条目喂进 prompt，并要求模型优先采用库内条目作答、原样回填 sources）。
      // 检索失败/超时 → sources 传空数组，链路照常发出，不影响作答。
      fetchSources(searchFn, keyword, function (sources) {
        if (self._chatDone || seq !== self._chatSeq) return   // 检索期间已被取消/替换
        // ★ data 传对象（框架自动序列化）；send 失败/静默 → 走同一降级
        self._sendReal({ type: 'ai_chat', qid: qid, question: question, sources: sources }, chatFallback)
        self._chatTimer = setTimeout(function () {
          self._chatTimer = null
          if (self._chatDone || seq !== self._chatSeq) return
          self._chatDone = true   // 置位后迟到的 ai_chat_result 在分发处被拦截，不会双重回调
          self._simChat(question, searchFn, cb)
        }, CHAT_TIMEOUT)
      })
    } else {
      self._simChat(question, searchFn, cb)
    }
  })
}

// 本地检索取来源（v1.16.311）：跑一次资料库检索，把命中条目映射成协议 sources 结构。
// searchFn 由调用方注入（index.ux 传 global.searchHistory），返回 Promise<{results:[...]}>。
// 任何异常/超时都吞掉并返回空数组——AI 问答不能因为检索失败而整体失败。
// gid 即全局条目 id（跨集路由键），回答页 openSource 用它 push 详情页。
var SOURCE_TIMEOUT = 4000        // 本地检索取来源超时（ms）：超时即当作无来源，不阻塞作答

function toSources(result) {
  var list = []
  if (!result || !result.results) return list
  var rows = result.results
  for (var i = 0; i < rows.length && list.length < SOURCES_MAX; i++) {
    var r = rows[i]
    if (!r) continue
    var gid = (r._id !== undefined && r._id !== null) ? r._id : r.id
    if (gid === undefined || gid === null) continue
    var title = r.title || ''
    if (!title) continue
    // 去掉结果标题里的序号前缀（如「1. 」），来源列表只保留条目名
    title = String(title).replace(/^\s*\d+[.、]\s*/, '').trim()
    if (!title) continue
    // 去重：同一 gid 只留一条
    var dup = false
    for (var j = 0; j < list.length; j++) { if (list[j].gid === gid) { dup = true; break } }
    if (dup) continue
    list.push({ title: title, tag: r.datasetTag || '', gid: gid })
  }
  return list
}

// 统一入口：先本地检索（带超时兜底），拿到 sources 后交给 done(sources)
function fetchSources(searchFn, keyword, done) {
  var finished = false
  var timer = null
  function finish(sources) {
    if (finished) return
    finished = true
    if (timer) { clearTimeout(timer); timer = null }
    done(sources)
  }
  if (typeof searchFn !== 'function' || !keyword) { finish([]); return }
  timer = setTimeout(function () { timer = null; finish([]) }, SOURCE_TIMEOUT)
  var ret
  try {
    ret = searchFn(keyword)
  } catch (e) {
    finish([]); return
  }
  if (!ret || typeof ret.then !== 'function') { finish([]); return }
  ret.then(function (result) {
    var sources = []
    try { sources = toSources(result) } catch (e) { sources = [] }
    finish(sources)
  })['catch'](function () { finish([]) })
}

Assistant.prototype._simChat = function (question, searchFn, cb) {
  var self = this
  var keyword = this._understand(question)
  if (!keyword) { cb({ ok: false, reason: 'empty' }); return }
  var t0 = Date.now()
  // v1.16.100：按关键词命中预置 AI 问答（模拟器无手机对端时的答案来源）；
  // v1.16.311：回答文本仍取预置，但 sources 改为本地检索的真实命中条目——
  // 「答案来自模型/预置，出处来自本地库」两条链路口径一致，回答页可点回原文。
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
  // 先取来源再回包：sources 有内容时回答页才渲染「来源」块（否则降级为无来源）
  fetchSources(searchFn, keyword, function (sources) {
    var payload = { ok: true, answer: answer, card: card, sources: sources, mode: MODE.SIM }
    // 补齐 2500ms 节奏；定时器挂 _simTimer——cancelSim 可中途取消（准备态滑动取消用）
    var wait = Math.max(0, SIM_CHAT_LATENCY - (Date.now() - t0))
    self._simTimer = setTimeout(function () {
      self._simTimer = null
      if (self._chatCb !== cb) return   // 已被取消/新请求取代，过期结果丢弃
      cb(payload)
    }, wait)
  })
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

// ★★★ v1.16.331：`_pickSimWord`（固定词表 ['感冒','急救',…]）已删除。
// 用户明确要求「不使用固定词表，假如手机连上蓝牙，它才能使用语音输入麦克风，而不是只模拟」。
// 手环没有录音能力（@system.record 实测 start 不是函数），语音链路只可能是
// 「手环发 voice_search → 手机麦克风录音识别 → 文本回包」这一条真实路径。
// 保留随机词表只会制造「看起来识别成功」的假象，故连死代码一起清掉。

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
  // 语音等待看门狗（v1.16.331）：取消后必须清，否则到点会拿旧 cb 回调，
  // 把「用户主动取消」误报成「手机没有响应」。
  this._clearVoiceWait()
  // ★ v1.16.355：用户中途退出必须停麦。旧实现在这里只清回调，
  //   而手表还在录、上传队列还在跑 —— 白耗电且会把上一段音频混进下一次请求。
  if (this._audioCancel) {
    try { this._audioCancel.cancel() } catch (e) {}
    this._audioCancel = null
  }
  // ★ v1.16.445：同上，队列必须一起作废，否则污染下一轮。
  if (this._audioDrain) {
    try { this._audioDrain.cancel() } catch (e) {}
    this._audioDrain = null
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
