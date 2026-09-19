# 代码审查报告（Claude Code · 2026-09-17）

> 由 Claude Code v2.1.233 对《资料库》v1.16.57 执行只读审查生成；
> 所有问题的修复见 v1.16.58（velaPro commit）。

---

- BtTransfer：`typeof data === 'string' ? JSON.parse(data) : data` —— 假定消息是裸 JSON 字符串或已是对象。

两者监听的是同一个通道，对同一帧数据的形态假设不同。若真机传包装对象，BtTransfer 收到的 `msg.t` 恒为 `undefined`，**蓝牙接收整条链路从根上不通**；若传裸字符串，则 AssistantEngine 的真链路应答永远解析不出。建议在接入真实设备（如决赛样机）时以日志确认实际形态后统一两处。

## 中严重度

**【src/pages/index/index.ux:698-722】【中】语音识别真链路无超时/失败兜底，聆听态可无限卡死**
真链路只发 `voice_search` 后等手机回 `voice_result`；手机端不回或回非 ok 时 `_voiceCb` 永不触发（AssistantEngine.js:88 只处理 `ok:true` 路径），`voiceActive` 恒 true，用户只能手动取消。且 `r.ok` 为 false 的回调分支根本没处理（`if (r && r.ok && r.text)` 之外什么都不做）。
**修复**：`startVoiceSearch` 加 10-15s 超时（存入可清理的 timer），超时后 `exitVoiceSearch` + 提示；回调里补 `else` 分支提示识别失败。

**【src/pages/index/index.ux:769-816】【中】goCategory 进入资料视图/大类时不作废在途搜索，旧结果会写进新视图**
`goCategory` 清了 `displayList`/`searched` 等，但没 `this.searchSeq++`。此前搜索的 `loadPage`（index.ux:1148）仍在途且 seq 未变，await 返回后把**旧关键词的结果**写入新资料视图的 `displayList`。对比 `clearSearch`/`resetAndSearch` 都做了 `searchSeq++`，这里是遗漏点。
**修复**：`goCategory` 与 `enterDatasetView`、`exitDsView` 中补 `this.searchSeq++`。

**【src/SearchEngine/DatasetManager.js:184-231】【中】单集 8s 超时后败者任务继续运行，污染聚合结果**
`Promise.race` 超时后内层 async 并不终止，之后仍会执行 `merged.push(it)`、`total +=`、`initFailed = true`。若败者在 `Promise.all` resolve 前后的微任务窗口完成，会污染本次返回；蓝牙动态集文件较大时 8s 超时并非罕见路径。
**修复**：race 外包一层 `settled` 标志，超时后丢弃败者写入；或败者写入前检查代际号。

**【src/SearchEngine/BtTransfer.js:33-52, 60-94】【中】分片协议无完整性校验，丢帧即静默产生坏文件**
- 拼装按 `while (parts[i] !== undefined)` 顺序取，**任一分片丢失/乱序到达则文件被静默截断**，无告警照常落盘；
- `ds-begin` 记录的 `total`（文件数）从未与实收文件数比对；每文件也无分片总数/校验和；
- interconnect 本身不保证可靠有序，协议层必须自校验。
**修复**：`ds-begin`/`ds-chunk` 帧携带每文件分片总数与全量 hash，`ds-end` 时先校验齐套再落盘，缺片回 Nak 或整体放弃。

**【src/SearchEngine/BtTransfer.js:70-73】【中】`ds-file` 帧未校验 `msg.f`，空文件名导致整批落盘失败**
`ds-chunk` 有 `if (!fname) return`，`ds-file` 没有。`fname2` 为空串时 `flushFile` 对 `dir + ''`（即目录本身）writeText → fail → 整条 chain reject → 已收资料全部不落盘。
**修复**：补同款空名校验。

**【src/app.ux:347-362 + DatasetManager.js:102-122】【中】蓝牙动态集注册后首页入口清单不刷新**
`global.datasetEntries`/`groupEntries` 只在 `onCreate` 生成一次；`registerDynamicDataset` 只改 `DATASETS`。传输完成后动态集搜索可达（`searchAllAsync` 遍历 `DATASETS`），但首页分类行**看不到入口**，直到应用重启。
**修复**：`registerDynamicDataset` 成功后重算并覆盖 `global.datasetEntries`（index 在 `onInit` 已会重读）。

**【src/pages/index/index.ux:410 vs 315-316】【中】分类横滑吸附参数固定 rect 尺寸，手环9 上吸附错位**
`snapParams = { iconW: 58, spacing: 17, padLeft: 8.5, ... }` 是 rect 基准；pill 屏 @media 下实际 `cat-item` 95px、间距 55px、padding 28px。手环9 上 `snapCatScroll`（index.ux:655）按错误步长吸附，图标永远对不到屏幕中心。
**修复**：`adjustForScreen` 按 `screentype` 重设 `snapParams`。

**【src/app.ux:5】【中】APP_VERSION '1.16.34' 与 manifest '1.16.57' 不同步**
注释明确要求两处一起改，已落后 23 个版本；设置页/日志里显示的版本号是错的。
**修复**：同步为 1.16.57（长期可让构建脚本从 manifest 注入）。

## 低严重度

**【src/SearchEngine/DatasetManager.js:240-243】【低】`titleSize` 死代码**
`cardSize` 从 `merged[mi].titleSize` 取值，但 `titleSize` 在整个代码库从未被赋值，`cardSize` 恒为 `'medium'` 且调用方（app.ux `searchHistory`）根本不读它。整段可删。

**【src/app.ux:162-172】【低】`yearIndexCache` / `keywordIndexCache` 两个空读死代码**
两个 `storage.get` 只做 `checkDone()`，读到的数据不用于任何逻辑，属凑数遗留。删掉并把 `total` 改 5。

**【src/pages/index/index.ux:460, 568, 727-729】【低】`voiceTimer` / `voiceText` 残留**
波形动画删除后 `voiceTimer` 无人赋值，`exitVoiceSearch`/`onDestroy` 的清理是死分支；`voiceText` 恒为 `'请输入'` 不再更新（语音态搜索框永远显示「请输入」而非识别中状态）。建议一并清掉或让 `voiceText` 承担状态展示。

**【src/pages/index/index.ux:815 + 900-905】【低】`enterSearch(item)` 遗留路径不可达且若可达会出 "[object Object]搜索"**
`displayCats` 现在全部带 `isGroup`/`isDataset`，`enterSearch(item)` 的分类对象分支永不执行；但它 `baseTitle = category + '搜索'`、`global.searchCategory = item`（对象入 global），一旦回退启用就是脏数据。建议删除该分支。

**【src/pages/index/index.ux:1170-1172】【低】10s 超时结果未检查 `timedOut`**
超时按空结果处理，但 UI 显示「共 0 条结果」而非错误提示——用户无法区分“真没搜到”和“卡死兜底”。补一个 `if (result.timedOut) this.searchError = true`（文案可区分）。

**【src/pages/index/index.ux:686-692】【低】资料视图内点「AI搜索」语义错乱**
`goSearch` 清了 `activeDatasetId`，但 `dsViewActive` 仍 true → `enterSearch` 走 ds 分支，标题显示「集名搜索」而实际是全局搜索。
**修复**：`goSearch` 中若 `dsViewActive` 先 `exitDsView`。

**【src/pages/index/index.ux:236】【低】`.search-btn-row` margin-top 声明两次**
`margin-top: 86px` 被同规则内后面的 `margin-top: 20px` 覆盖，删除前一个。

---

## 专项核对结论

- **a. 死代码/残留**：`quotes`/波形动画本体已清干净（`meta.json:50` 的 `quotes.txt` 是数据文件清单，正当引用）；残留为 `voiceTimer`、`voiceText`、`titleSize/cardSize`、app.ux 空读、`enterSearch(item)` 分支，均已列出。
- **b. 模板拼接类名**：✅ 合规。所有 class 均为「固定 + 纯变量插值」（如 `class="cat-icon {{$item.colorClass}}"`）或 DatasetManager 预拼完整类名（`yearClass/titleClass/catClass`），无 `class="a {{expr}}"` 拼接表达式。注意 index.ux:60 `class="{{$item.cls}}"` 是纯变量、无固定类——与 v1.16.49 注释记载的「纯变量整类名丢类」教训相抵，实测若标签底色偶发丢失，此处是嫌疑点。
- **c. 滚动帧写响应式字段**：✅ 基本合规。`onPageScroll`/`onCatScroll` 高频写 `_lastPageY`/`_lastCatScrollX`（非响应式），`curPage` 仅翻页时才写。遗留三处动态 `style`（screen1H/dotsTop，index.ux:12/125/151）但只在 `adjustForScreen` 一次性写入，不在滚动帧，可接受。
- **d. 定时器泄漏**：✅ 无泄漏。`timeTimer/pageScrollTimer/catScrollTimer/searchTimer/voiceTimer` 均在 `onDestroy` 清理；`openKeyboardDelayed` 的裸 `setTimeout` 有 `isDestroyed` 守卫。唯一缺口是语音真链路无超时 timer（见中#1）。
- **e. 逻辑漏洞**：见 中#2（seq 竞态）、中#3（超时败者）、中#5（动态集入口）、低#3/#4。
- **f. 蓝牙协议**：两个高严重度问题（onmessage 互相覆盖、消息形态矛盾）+ 完整性校验缺失（中#4/#5）都集中在这一块，**是本次改动最薄弱的部分**，建议接入真实设备前优先解决。

## 总体评价

**6/10。** UI 层（index.ux）经过多轮模拟器实测迭代，状态复位、代际号防竞态、布局节流等细节可见明显打磨，注释与历史教训记录详实，模板类名与滚动帧纪律执行到位——这部分质量是高的。但两条「新增链路」问题严重：① 凑数清理引入了 `ver` 未定义回归，会让**每次完整加载以失败告终**，属于一跑就能发现的低级失误，说明清理后没有跑过一次全量加载验证；② 蓝牙接收器与 AssistantEngine 对 `onmessage` 单槽的抢占和消息形态的互相矛盾，说明两个模块是各写各的、从未在同一次运行中同时验证过。建议合并前必须处理 3 个高严重度项，并补一次「设置→重新加载 + 蓝牙传输 + 语音搜索」的端到端回归（模拟器）。
SessionEnd hook ["python3" "/c/Users/Qt/.claude/contest-shared/snapshot_core.py" --tool claude-code] failed: /usr/bin/bash: line 1: python3: command not found

