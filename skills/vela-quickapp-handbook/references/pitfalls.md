# 完整坑档案（真实报错原文与处置）

按「报错/现象原文 → 根因 → 处置」记录，供快速检索。

## 1. 搜索全挂 / 块魔数

| 项 | 内容 |
|---|---|
| 现象 | 所有搜索返回空 |
| 根因 | build 重写版用 `buffer.write('BLOK')`（ASCII）写魔数，引擎按 `readUInt32LE` 读期望 `0x424C4F4B`（大端直觉陷阱：'B'=0x42 在最低位） |
| 处置 | `buffer.writeUInt32LE(0x424C4F4B, offset)`；桶内 posting id 必须 **排序+去重**（引擎二分查找前提） |

## 2. 引擎 init 崩溃

| 项 | 内容 |
|---|---|
| 现象 | BUILT_IN_META 更新后 init 直接崩 |
| 根因 | 替换脚本写了 `JSON.stringify(JSON.stringify(meta))` 双包裹，`JSON.parse` 收到对象而非字符串 |
| 处置 | 内嵌常量 = `'  BUILT_IN_META = ' + json.dumps(compact_json_string)` 单次转义；改后必须先 Node 模拟引擎解析链（eval 字面量 → JSON.parse）验证 |

## 3. 同 id 两条 → 引擎 Map 错位

| 项 | 内容 |
|---|---|
| 现象 | 搜「活板」返回「折桂令·西湖」（id 对、标题错） |
| 根因 | 合并脚本续号起点抄了任务书旧值（53547），与上批已入库区间重号；主库校验只查行数与字段数，未查 id 唯一性 |
| 处置 | ① 合并脚本 `nid` 必须**实时读主库末行 id + 1**；② 每次合并后 `assert len(ids)==len(set(ids))`；③ 已污染库用「按行序保留首次出现、重复行重新分配尾部 id」重建 |

## 4. 安装 rpk 报 -19

| 项 | 内容 |
|---|---|
| 现象 | `onInstallResult: /data/x.rpk(Failed to deal with rpkpackage -19)` |
| 根因 | **`/data` 分区空间不足**（2026-10 实测更正；原记「同 versionCode 覆盖被拒」不准确）。模拟器 `/data` 仅 255M，长期实验后常只剩 8~10MB，装 1.8MB 包 + 首启建索引缓存即失败 |
| 处置 | ① `df -h` 看 `/data` 余量；② 卸载历史实验残留包（如 `vela.HistorySearch.test*` 系列），实测 8.6M→49M；③ 再 `pm install`。判据：腾空间前后同一个包从 `-19` 变 `success 0`，且 22KB 已知好包能正常装（证明模拟器健康） |

## 5. 模拟器截图为空 / 保存失败

| 项 | 内容 |
|---|---|
| 现象 A | `NO_WINDOW` |
| 根因 A | qemu 进程 MainWindowTitle 为空（窗口句柄异常）或按进程名过滤误抓（进程名是 `qemu-system-armel`，不是 emulator） |
| 现象 B | `GDI+ 中发生一般性错误` |
| 根因 B | 输出路径含空格（`E:\shi vela\...`）经 bash→PowerShell 参数传递被拆 |
| 处置 | 先 `Save` 到 `C:\Temp\x.png` 再 `cp`；窗口最小化时先 `ShowWindow(handle, 9)`；`PrintWindow(handle, hdc, 2)` 免前台截图 |

## 6. 手环蓝牙部署失败

| 报错 | 根因 | 处置 |
|---|---|---|
| `connect fail err=10048` | 蓝牙 RFCOMM 通道瞬时占用/残留 | 直接**再 ping 一次**，第二次常成功 |
| `pairing: ! device not reachable (band must be advertising/connectable)` | 手环与手机运动健康保持连接中，不对外广播 | 手机端断开连接 / 手环重启，然后立刻重跑脚本（配对窗 30 秒内点「配对」） |
| MCP 安装 4MB+ 超时 | SPP 上传速率限制（~10 分钟上限） | 用独立 python 脚本（bleak+SPP，无超时）后台跑：`python install_wsg_v66.py`（bleak 只在该解释器环境） |

## 7. 模板/渲染类（静默失败）

- **for 内变量漏 `$`**：整块不渲染、无报错。全项目 grep 模板变量，对照现有正确写法（`{{$item.title}}`）。
- **absolute 无宽高**：元素"消失"（auto 算 0）。
- **无 class div 默认横排**：卡片/标签排成一行超屏。
- **emoji 空框**：手环字体缺字形；换 PNG 图标。
- **image 虚线占位框**：源 PNG 没打进 rpk（解包验证）或安装不完整（重装）。
- **放大渲染(scale>1) 下负 margin 触发布局 bug**：改用显式尺寸/定位。

## 8. 图标生成类

- **alpha 恒低（如 21）淡成虚线**：采样循环变量遮蔽外层缩放系数（见 SKILL.md 5.1），线段坐标被乘采样序号。
- **描边断裂**：距离带法在高曲率区失真 → 双实心差集法。
- **差集环恒空**：坐标映射乘反（应 `R/Ri` 放大映射到内心坐标系）。
- **Read 工具看不见白/透明图标**：合成黑底预览再查看（python 手写 PNG 合成，注意 chunk CRC 要算 `typ+data`，漏 typ 会导致 PNG 无法渲染）。

## 9. 配置覆盖类

- **CONFIG 残留值覆盖 `||` 默认**：`this.x = config.x || 3`，若 config 里是 `2`（旧值），改代码默认值无效 —— **改性能参数时全项目 grep 旧值**。
- **detail 定位公式**：多片 map 后 detail 片号 = `mapId × mapChunkSize + 片内下标`，缺全局偏移会导致多片后详情全部错位。

## 10. 手环 9 固件崩溃类（《资料库》项目实机专案，固件 3.1.32）

现象都是「瞬间重启、无任何报错」；模拟器同代码只告警不崩，**模拟器全绿不能推出手环能跑**。

| # | 现象 | 根因（验证方式） | 处置 |
|---|---|---|---|
| 1 | 蓝牙传输完成、安装瞬间手环重启 | manifest `minAPILevel` 字段（**构建工具注入，源文件里没有**）触发安装器兼容检查崩溃；`:4`、`:3` 都崩，删字段安装成功（minitest 二分 m14/m15 单变量实锤） | 构建后处理：解 zip → 删 manifest 的 minAPILevel → 重打（仅 debug 自装包；重打包破坏签名） |
| 2 | 安装成功、点开瞬间手环重启 | **动态内联 style 绑定**（`style="{{x}}px"`）——同结构写死能开、动态绑定崩（Y3a/Y3b 对照实锤）；**动态 class 绑定（纯变量插值）安全** | 全工程 grep `style="{{` 清零；改「@media 固化常数 + computed 返回完整类名（禁三元）」；动态高度需求改内部 scroll |
| 3 | 同上 + 模拟器刷 `Unsupported type for setDomAttributes: 0/2` | for 内 class 拼接插值（`class="a sz-{{$item.x}}"`）等 DOM 属性绑定类型问题；另导致编译期样式匹配丢失（卡片字变灰） | 数据层预拼完整类名，模板只写 `class="{{$item.cls}}"` |
| 4 | 打开重启（CSS 二分支线） | 小数 px（`27.5px`）、`lines`/`text-overflow` 属性、`border-radius` ≥ 盒子尺寸一半（48px 高配 r48）——删除后恢复（Y2g：删 7 条 border-radius 能开） | 小数取整；lines/text-overflow 全删（文本截断改 JS 截字符串）；radius 控制在尺寸一半以内 |
| 5 | 装什么应用都失败 | **手环安装功能进入病态**（重启手环后自愈）——病态期实验结论全部作废（血泪教训） | 每轮二分实验前先装 22KB 已知好包（minitest）确认设备健康，结论才有效 |
| 6 | 打开重启（存疑支线） | JS 全量加载内存压力假设：正式包 534KB vs 极简包 9KB（**假设，未最终实锤**，四分包验证被中断） | 降载荷：减 router.pages、懒加载、缩小最大页面 bundle、首启不预热全量缓存、memoryLevel 降级 |

**排查方法论**：22KB 极简包（同包名）确认能装能开 → 逐项加回正式工程内容（script → CSS 块 → 模板块 → 数据），崩了即锁定，再对半切到行；全程先卸后装。

## 11. 模块实例类

- **webpack 双实例**：同一模块被以不同相对路径导入（页面 `../../X.js` vs app.ux `./X.js`）→ 两个实例、状态不互通，表现为「写了的数据另一处读不到/入口不显示」。对策：跨页面共享只在 app.ux import 并挂 `global`，页面统一从 global 取。
- **export 残留未知符号**：`export { a, 不存在的符号 }` → 模块求值中断 → 所有 import 拿 undefined，**无报错**。对策：模块首行放一条日志，「日志没打印」即求值中断实锤，查 export 名单。
- **★ import 了「没被 export 的符号」→ 静默 undefined（比上一条更阴，只在真机首装暴露）**：
  **现象**（2026-10《资料库》实测）：函数在模块里**明明定义了**，但 `export { ... }` 列表**漏写它**；
  调用方 `import { thatFn } from './Mod.js'` → 拿到 **`undefined`**（ES 模块规范：不存在的导出不报错），
  一调用即抛 `TypeError`，若外层有 `try/catch` 就被**完全吞掉**。
  **后果可极严重且难查**：本例中 `isCacheBuilt`（首装判断缓存是否已建）拿不到 → 首装**永远不跳加载页
  → 缓存一个字节都不建** → 首次搜索时引擎临时建索引（数十秒）→ 卡死/点不动；建索引内存峰值飙升
  → 手环内存紧张 → **直接重启**；即便返回也「什么都搜不到」。
  **为什么长期没被发现**：本平台**卸载重装不清 storage** → 开发/模拟器验证时 storage 里早有缓存，
  「跳不跳加载页」**看不出差别**；**只有真机首装（storage 真空白）才暴露**。
  **排查手法（产物级，最快）**：解包 rpk，在产物 JS 里搜该函数的**独有字符串**（本例是它拼的缓存探测键
  `search_engine_map__ds0v2_0`）——修复前**全包 0 处**、修复后出现在 6 个 chunk 中；也可搜
  `xxx.fnName=function` 形式的**定义体**是否存在。**光看源码看不出来，必须查产物。**
  **对策**：① 新增/改动导出后，逐条核对「被 import 的符号都在 export 列表里」；
  ② 交付前对 rpk 做一次「定义体是否存在于产物」抽查；
  ③ 首装路径必须在**清空 storage** 的条件下验证（`rm -rf /data/quickapp/system/<包名>`）。
- **详情页数据张冠李戴**：多数据集共用 localId，路由只传 localId 会打开错误集的同 ID 条目。对策：全局 ID 位编码（`datasetId << 20 | localId`），详情/收藏全链路传全局 ID。
- **详情字段名英文裸排**：物化 meta 的字段名是英文（source/content），直接当 UI 标题显示。对策：物化时就写中文，或读取端加 `FIELD_NAME_MAP` 中文兜底。

## 11.5 ★★★ 构建器不做 tree-shaking：每个页面各背一份模块副本（2026-11-01《资料库》实证）

**现象**：rpk 里只有「各种页面命名」的 `.jsc` 加一个 `app.jsc`，**没有任何独立模块文件**。
`SearchEngine.js`(64KB)、`DatasetManager.js`(34KB)、`AssistantEngine.js`(55KB) 被内联进每个引用它的页面，同一模块在包里存在 N 份**互不共享的副本**。

**判定（两条命令，别绕弯）**：
```bash
unzip -l dist/*.rpk | grep -E "\.jsc$"                        # 只有 pages/**/x.jsc 与 app.jsc → 全内联
unzip -l dist/*.rpk | grep -iE "SearchEngine|DatasetManager"   # 命中 0 → 确认无独立模块
```
确认某页是否真带引擎，**不要 grep 源码，要 grep 字节码字符串表**（jsc 里中文查不到，ASCII 标识符保留）：
```bash
unzip -p dist/*.rpk pages/index/index.jsc > /tmp/i.jsc
strings /tmp/i.jsc | grep -c "_loadChunkFromFileText"   # 1=内联 0=已剥离
```
⚠️ 必须用**模块独有的长字符串**（`search_engine_map__ds0v2_0`、`_loadChunkFromFileText`）；
用 `getSearchEngine`/`maxLoadedChunks` 这类通用符号会**误报**（多处同名）。

**真实账单（1.16.387 基线）**：首页只调用 `isCacheBuilt` 6 次，背了 267,466B 闭包；
设置页只为 `clearAllCaches` 一个函数，背了 41,472B；`btransfer.jsc` 43,777B。

**★★ 根因往往不在页面自己的 import —— `require()` 同样被当静态依赖**：
```
index.ux → AssistantEngine.js:39 `import { initBtReceiver } from './BtTransfer.js'`
        → BtTransfer.js:184 `require('./DatasetManager.js')`
        → DatasetManager.js:5 `import { ... } from './SearchEngine.js'`
```
只删页面那行 `import { isCacheBuilt }` **完全无效**，必须切断中间层的相对 `require`。
排查用的依赖树脚本（能一眼看出谁把引擎拖进来）：
```js
// node -e 跑：从入口递归找所有 './xxx' 与 '../xxx' 的相对 import/require
const re=/(?:import\s+[^;]*?from\s+|require\()\s*'(\.[^']+)'/g;
```

**对策**：把叶子能力挂到 `global`，让中间层不再有指向引擎的静态引用。
```js
// app.ux（onCreate 先于任何页面，且本就 import 完整引擎）
import { isCacheBuilt, clearAllCaches, registerDynamicDataset } from './SearchEngine/DatasetManager.js'
global.isCacheBuilt = isCacheBuilt
global.clearAllCaches = clearAllCaches
global.registerDynamicDataset = registerDynamicDataset
// 页面侧删掉 import，改 global.xxx()
// BtTransfer 侧把 require 改 global.registerDynamicDataset(...)
```

**⚠️⚠️ 注释里也不能出现那个相对 require 的完整字面量**：打包器/依赖扫描是**文本级**的，
注释中的 `require('./DatasetManager.js')` 一样会把依赖算进去。**第一次改完体积没降就是这个原因**，
极容易漏、极难想到。

**实测收益**：settings.jsc 35,560→6,467B(−82%)、btransfer.jsc 43,777→15,508B(−65%)、
index.jsc 163,757→142,410B(−13%)、包总 1,932,536→1,899,942B。

**为何 global 方案不增加内存**：`app.ux` 是应用级脚本，它挂 `global` 的东西**启动即常驻直到退出**；
所以让 app.ux 承担引擎是「一次加载、全局共享」，页面各自 import 是「各自加载、互不共享」——
后者纯属重复，删掉零损失。**运行时实例本身早已通过 `global.searchEngine` 共享**（loading 页 init 完就覆盖全局），
页面里那几份副本从未被用来建实例。

**可继续拆（未做，路线）**：搜索逻辑单独成页、首页只留键盘；各入口用参数区分（`from=home`/`from=dataset`），
返回 `router.back()`。注意：省的是「首页体积与解析耗时」，**不是包总大小**（代码只是从 index.jsc 搬到 search.jsc）。


## 11.7 ★★ 图片素材按「真实物理像素」定尺寸，否则白占解码堆（2026-11-02《资料库》实证）

**症状**：包体压了 4% 体感无改善；内存却在几 MB 的配额里被两张图吃掉近 600KB。

**★ 两个公式**
1. 解码内存 = `宽 × 高 × 4`（RGBA）。**与磁盘编码字节无关** —— 压 PNG 只减包体，不减堆。
2. 需要的物理像素 = `逻辑尺寸 × (物理宽 / 逻辑宽)`。各形态倍率实测：

| 形态 | 物理宽 | 逻辑宽 | 倍率 |
|---|---|---|---|
| rect 方屏 | 336 | 300 | 1.1200 |
| circle 圆屏 | 466 | 300 | 1.5533 |
| pill 胶囊 | 192 | 300 | **0.6400**（缩小） |

胶囊屏倍率 < 1，按逻辑尺寸出图反而是 1.56 倍冗余。

**实测案例**（`ask-btn-200x72.png` / `ask-btn-184x130.png`）
| 素材 | 原尺寸 | 解码 | 改后 | 解码 | 真实需求 |
|---|---|---|---|---|---|
| ask-btn-200x72 | 400×144 | 225KB | 260×94 | **95KB** | rect 224×81 / circle 242×65 |
| ask-btn-184x130 | 368×260 | 373KB | 130×92 | **46KB** | pill 118×83 |

省 457KB 堆，包体 −27,814 B。

**做法**
```python
from PIL import Image
im = Image.open(p).convert('RGBA')
w, h = im.size
th = round(h * tw / w)          # 保持原宽高比！显示尺寸由 CSS 强制，比例不变才不引入变形
im.resize((tw, th), Image.LANCZOS).save(p, 'PNG', optimize=True)
```
⚠️ **必须保持原宽高比**：显示尺寸由 CSS（`.search-icon { width: 200px; height: 72px }` 等）强制拉伸。原图 400×144 = 2.778，rect 显示 200×72 = 2.778 正好匹配；圆屏 156×42 = 3.714 本就是横向拉伸，改后同样拉伸，观感才一致。

**验收判据（逐像素对比）**
```python
diff = ImageChops.difference(crop_old, crop_new)
# 统计 max(r,g,b) > 12 的像素占比，< 3% 视为无视觉退化（差异集中在边缘抗锯齿）
```
实测 2.98%，肉眼无差。

**排查顺序**：`find src -name "*.png" -size +8k` → 算 `w*h*4` → 查目标形态 CSS 显示尺寸 → 超需求即重采样。小图（<8KB）通常不值得动。


## 11.6 ★★★ 进页慢的真根因：`@media` 块内每条规则各求值一次（2026-11-02《资料库》实证）

**现象**：包体从 1,932,536 B 压到 1,856,570 B（−4%）后，用户体感**毫无改善**，仍抱怨「进页面才加载」。
→ 结论：**包体大小不是进页慢的主因**，别把体积优化当成速度优化。

**测法（外部截图轮询不可靠，必须应用内埋点）**：
跳转前 `global._navT0 = Date.now()`，目标页 `onInit` 与 `onShow` 各取一次时间，分「路由派发」与「建树+首帧渲染」两段。
首测即分清责任：**路由 96ms · 建树 953ms → 94% 在建树**。
- ⚠️ 埋点必须落在**观测终点之后**：曾把结果写在 `onShow` 里，而 `device.getInfo` 异步回调的整树重建在 `onShow` 之后 → 窗口没覆盖，误判「改初值没差异」。
- ⚠️ 外部测法的坑：tap 前不在首页恒得 `-1ms`（画面与基准同）；`swipe` 的 y 太靠底触发系统退出手势；`am start` 后画面可能停在表盘。

**根因**：引擎对 `@media` 块内**每条规则**单独求值一次媒体查询，成本是块外规则的 4~9 倍。
分档实测（同一基线逐项删减）：

| 规则位置 | 条数 | 耗时 | 单条成本 |
|---|---|---|---|
| 基础（`@media` 外） | ~77 | 87ms | 1.1ms |
| `@media (shape: pill-shaped)` | 49 | 225ms | 4.6ms |
| `@media (shape: circle)` | 59 | 555ms | 9.4ms |

**修法：摊平（flatten）—— 去外壳、内容原地展开，语义等价**
```python
# ★ 只在 <style> 段内操作！这串字在 JS 注释里也大量出现，
#   不限定范围会从注释处开始吞掉大段脚本（实测 index.ux 被吃 2,620B、锚点全失效）
si = text.find('<style>'); ei = text.find('</style>', si)
head, css, tail = text[:si + 7], text[si + 7:ei], text[ei:]
# 对 css 内每个 '@media (shape: circle)'，括号深度匹配找到配对的 {...}，
# 只删外壳、内容原样留在原位 → 层叠顺序与「条件永真」时严格一致
```
因为块内容位置未动，**不需要重新验证布局**（仍建议目检一次）。

**严格配对 A/B 实测**（圆屏 466×466，各 2 轮；每轮 `pm uninstall` → `install` → `reboot` → 轮询等首页 → 点击）：
- 含 `@media` 外壳：建树 **895 / 1026ms**
- 摊平后：建树 **161 / 143ms** ← **−84%**，整页进页 ~1053ms → ~215ms

**适用前提（不可盲目套用）**：只在「该 `@media` 条件在目标机型上恒真」时摊平。
三形态共存的包（同一 rpk 给方屏/胶囊屏/圆屏共用）**必须**保留媒体查询；
只能针对特化派生包（按圆屏派生出的包）摊平。主线保留原样、副线派生时摊平 —— 干净的分工。

**顺带证伪**：产品代码的注释不一定对。曾有注释断言「键盘组件 800+ 行三形态分支是页面打开耗时最大头」，
实测删掉整个键盘区建树 590→638ms（噪声级）——进页时 `showKeyboard || searchActive` 都是 false，组件根本没实例化。
**注释里的因果判断必须实测验证。**

## 12. 图标（<image>）的尺寸与「渐变按钮面」技法 ★ 2026-10 结论已更正

### 12.1 ⚠️ 旧结论已推翻，勿再沿用

**曾记录（错误）**：「`<image>` 不应用类选择器的 width/height；渲染恒为 PNG 自然尺寸 ÷ 2；素材 144px 会渲染碎裂。」

**2026-10 重新实测（同一工程、同一运行时）**：
- 用一次诊断构建把 **96 / 144 / 192 / 240 / 312 px** 五个渐变测试图同时渲染到页面上 → **192 / 240 / 312 全部正常显示，无任何碎裂**。
- 把同一图标素材从 96px 换成 **224px**、CSS 仍写 `width: 48px` → 实测渲染 **46.4 ≈ 48 逻辑**；若真按「自然尺寸 ÷ 2」应为 112。**证明 CSS 的 width/height 确实生效。**

**旧结论的成因（重要教训）**：当时素材正好 96px、CSS 正好 48px，两者恰好 **2 : 1**，于是「CSS 生效」被误读成「按自然尺寸减半渲染」。**巧合伪装成了规律** —— 单一数值样本不足以支撑一条运行时结论，换一个尺寸就能证伪。

### 12.2 ✅ 正确认知与由此得到的关键技法

- CSS 的 `width` / `height` 对 `<image>` **正常生效**（本运行时 width/height 均为 border-box）。
- 素材可以出到 **至少 312px**（实测），渲染清晰、不碎裂。
- **★ 由此得到本项目最重要的一条绕行手段**：本运行时 CSS **不支持** `linear-gradient` / `radial-gradient` / `box-shadow` / `filter`（见第 3 节），但 `<image>` 能正常渲染带渐变的 PNG → **把「渐变 + 高光 + 内描边 + 图标」整体烘进一张 PNG 当按钮背景**，即可实现纯 CSS 做不到的视觉效果。

  实操（《资料库》主界面入口按钮 v1.16.300 实装）：
  - 素材出 **按钮逻辑尺寸 × 2**（方屏 112 → 224px，胶囊 156 → 312px），CSS 写 `width/height` = 按钮逻辑尺寸 → 高清且像素级对齐；
  - 按钮本体 `background-color: transparent`，圆角由 PNG 里的 squircle 决定（CSS `border-radius` 与之一致，避免裁切）；
  - 柔光仍用「同心层叠 + rgba 递减 alpha」包在外层容器上（PNG 内的光晕会被自己的边界裁掉）；
  - 多形态用**动态 `src` 计算属性**切换素材（本项目：`askBtnIcon() { return this.screentype === 'pill-shaped' ? '/common/icons/ask-btn-312.png' : '/common/icons/ask-btn-224.png' }`）。
  - 生成侧用 `@resvg/resvg-js`（项目已有依赖）在 Node 里画 SVG → PNG，SVG 里 `linearGradient` / `radialGradient` / 描边 / 贝塞尔全都可以用。

### 12.3 排查手法（仍然有效）

`<image>` 上加**诊断底色 + 极端 width**，并按「源 PNG 字形填充率 × 渲染框」反推实际显示尺寸 —— 但**必须至少换两个不同尺寸的素材交叉验证**，否则单点数据可能再次被巧合误导（见 12.1）。

同工程 `index.ux` 的 `.cat-icon-img`（CSS 55px）一直正常生效，当时被当作"未解差异"记录，现在看**它才是正常表现，有问题的是那条结论**。

## 13. interconnect 收发（★ 2026-11-01 真机实证，本节结论均为 S5 + 小米穿戴互联通道）

### 13.1 ★★★ 在 `onmessage` 回调里同步 `conn.send()` 会被框架静默吞掉

**最难查的一条**：不报错、不抛异常、`success` 与 `fail` 两个回调**都不触发**，帧一个字节都发不出去 —— 是彻底的黑洞，日志上表现成「这个模块根本不会发帧」。

**实测判据链**（《资料库》S5，v1.16.389）：
1. 手环 console 打出 `[BT-DS] 收到帧 t=cfg-query` → 帧确实到了、`handleCfg` 被调用；
2. 函数里 `_conn` 非空、`_conn.send()` 也确实执行了，但 success / fail / 异常**三条路径一条日志都没有**；
3. 手机侧 `conn.log` 里 `grep cfg` = **0 条**，收帧长度分布只有 23~25B（ping/pong）与 audio 帧 → cfg 帧从未离开手环；
4. 对照：同期**能到达手机**的帧（pong、audio_*）**全部由定时器发起**，没有一帧是在 `onmessage` 回调栈里同步发的 —— 这是两条路径唯一的差异。

**修复**：发送动作包进 `setTimeout(fn, 0)`，改到下一轮事件循环执行。
```js
// ✗ 在 onmessage 回调栈里同步发 —— 静默黑洞
function handleMessage(msg) { conn.send({ data: { t: 'cfg-state', ... } }) }

// ✓ 让出当前事件循环再发
function _cfgSend(obj) {
  setTimeout(function () {
    var conn = _resolveConn()
    if (!conn) return
    conn.send({ data: obj,
      success: function () { _log('送达') },
      fail: function (res, code) { _log('失败 code=' + code) } })
  }, 0)
}
```
修复后立刻出现 `送达(cb)` 回调，手机端首次收到 `✓ cfg-state 收到`。**所有响应式回帧（收到 A 回 B）都必须走这条规矩**。

### 13.2 「对象 vs 字符串」不能跨机型套用

- 手环 9（固件 3.1.32）实测：`data` 传 **JSON 字符串**会被 `fail` 拒绝，传**对象**才成功 —— 这是项目里「data 必须传对象」铁律的出处。
- 但 SPP 时代（2026-10-30 SPP 通道实测）S5 上双向跑通的 `_cfgSend` 恰恰是 `_conn.send({ data: JSON.stringify(obj) })`，**传的是字符串**。
- 结论：**投递形态取决于通道与固件，不是全局常量**。换通道（SPP ↔ 穿戴互联 SDK）时必须重新对照实验，不能直接沿用另一条通道的结论。

### 13.3 收到帧但零应答时，先怀疑「回调栈」，再怀疑「连接对象」

排查顺序（按命中率）：
1. **是否在收帧回调里同步发的**（本节 13.1，最高频）；
2. 帧结构是否被接受（换最小扁平帧对照）；
3. 连接对象是否有效（缓存 vs 每次 `instance()` 现取）。

> 反面教训：曾先后怀疑「onCreate 缓存的 `_conn` 已失效」并真的改成每次 `instance()` 现取、又怀疑「嵌套对象/数组结构不被接受」并改成发最小扁平帧 —— **两个都无效且都与既有事实矛盾**。SPP 时代同一份代码用缓存的 `_conn` 已跑通，`git log -S"cfg-query" -- src/SearchEngine/BtTransfer.js` 只命中引入提交、此后无改动，说明手环端业务逻辑本来没问题，问题只在通道层。**排查时先用 git 确认「这段逻辑历史上是否被验证过」，能直接砍掉一整片错误方向。**

### 13.4 接收器只初始化一次 → 失败后永不重试

`initBtReceiver()` 若写成 `if (registered) return`（而非 `return true`）并且整段包在 `try` 里，一旦 `onCreate` 那一刻框架的 interconnect 还没就绪（`require` 抛异常或 `instance()` 返回空），就会：
- 落进 `catch`，`registered` 保持 false；
- 但**再没有第二次调用点** → `cfg-query` / `ds-*` 这类业务帧**没有任何模块处理**，表现为「图标功能一律无反应」而语音/心跳却正常（它们走的是另一条包装链）。

对策：① `onCreate` 与 `probe()`（每次探测/重连时都会跑且幂等）**两处都调**；② `initBtReceiver` 内部对 `if (!conn)` 明确 `return false` 并打日志；③ `catch` 里把 `e.message` 打出来 —— 否则分不清是 `require` 失败还是 `instance()` 为空。

### 13.5 收帧日志必须打 `t` 字段，否则区分不了「收到 pong」和「什么都没收到」

handler 里对没有 `t` 字段的帧（如 `{"type":"pong"}`）常在下一行静默 `return`，日志上和「没收到任何帧」完全一样。入口处无条件打一行：
```js
var _tag = msg.t || msg.type || '(无 t/type)'
_log('收到帧 t=' + _tag + ' : ' + _raw.slice(0, 60))
```
这一行是 13.1 得以定位的前提 —— 没有它根本无法区分「帧没到」与「帧到了但没应答」。

---

## 14. 推包与验证：三个会让人误判「代码没修好」的陷阱

### 14.1 推包必须等到 `App.installed` 回执，否则装的根本是旧版

`tools/pushwatch.py` 输出里有三件事，**只有第三件才是安装成功的证据**：

```
[http] 192.168.101.9 取走 1923079 字节        ← ① 这只是手表来拉包
[http] 自校验通过 http://…/rpk → 1923079 字节  ← ② 这是脚本自己 GET 一遍
[mqtt] → {"method":"Rpk.install",…}           ← ③ 指令已发出
```

真正表示装上的，是在 `vela-ide/<device>/command` 上收到的：

```json
{"method":"App.installed","params":{"status":"ok","packagename":"vela.Databank"}}
```

**踩过的坑**：某轮推包只看到 ①②，就以为 1.16.397 已生效，于是拿「新代码修了重绑 bug」的预期去解释真机行为，连续几十分钟都在错误前提上排查。实际上手环 WiFi 已掉线，包**根本没下来**，跑的还是旧版。

判据补齐方式：
- `--wait 90` 让脚本多等回执；
- 或独立订阅 `vela-ide/#` 看有没有 `App.installed`；
- 或推完立刻查一次包内版本号与手环上报的版本是否一致。

### 14.2 手表 WiFi 会掉，但蓝牙链路不会 —— 两者判据完全不同

- **WiFi 掉线**：`ping <手表IP>` 全丢、MQTT 订阅收到 0 条 → 此时**无法推包**（拉不到 rpk）。
- **蓝牙/SDK 链路**：掉 WiFi 后依然通，`recv.log` 里 `{"type":"ping","seq":N}` 照常每秒递增。

所以：
- 判「能不能推包」→ 看 WiFi / MQTT 在线；
- 判「快应用是否活着、链路是否通」→ 看 ping/pong 是否在往返，**不要用 ping ICMP 判断**。

### 14.3 `tools/watchlog.py` 拉到的内核日志可能是几小时前的旧时段

它抓的是设备端 kmsg 的**环形缓冲当前内容**，不是「从现在开始记录」。某次 00:0x 拉取，得到的却是 `[11/01 15:26 – 15:31]` 的段落 —— 里面当然找不到当前这次 cfg 的任何 `[BT-DS]` 行。

误用后果：会得出「手环端一条日志都没有 → handleCfg 没被调用」这种**建立在错误时段上的结论**。

正确做法：拉完先看首末行的时间戳，确认覆盖到操作时刻；不覆盖就等设备侧日志滚动，或改用 MQTT 的 CDP 通道实时抓 console。

### 14.4 广播被系统延迟派发（OPPO / ColorOS）

`am broadcast` 返回 `result=0` 只代表入队。真机上实测 `dumpsys activity broadcasts` 里能看到：

```
enq=23:19:12  disp=23:20:18  fin=23:20:21     ← 延迟 1 分 6 秒
```

于是「发完等 20 秒查结果」必然看不到日志文件，极易误判为「探针崩了」。要么等足时间（≥90s），要么轮询结果文件出现为止。

### 14.5 手机 App 进程被系统杀掉后，广播没人接

`ps -A | grep <pkg>` 为空时，`am broadcast` 会显示 `Broadcast completed: result=0`，但 manifest 里的 receiver **根本不会实例化**（进程都没起），日志文件自然不出现。动手排查前先确认进程在：不在就 `am start -n <pkg>/<.MainActivity全名>` 拉起来再说。
