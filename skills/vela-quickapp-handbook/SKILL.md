---
name: vela-quickapp-handbook
description: openvela/Vela 手表快应用（.ux 单文件组件）开发实战手册。当需要在 openvela/Vela 轻量运行时上开发或调试手表快应用、处理多形态（方屏/圆屏/胶囊屏）适配、排查「界面正常但点不动 / 文字被挤压 / 元素占位 / 布局错乱 / 搜索后整屏塌陷」类疑难、优化进页与搜索性能、构建可离线检索的资料集（倒排索引 + 分片）、或用 python-pptx 批量生成答辩/报告类 PPT 时使用。基于《资料库》项目（六大数据集 5400 条、三形态适配、纯 JS 零依赖检索引擎）200+ 次构建与实机迭代沉淀。
---

# openvela 快应用实战手册

> 来源：2026 首届 openvela AI 硬件开发者大赛参赛作品《资料库》的开发沉淀。
> 全文条目均在官方模拟器（方屏 336×480 / 圆屏 466×466 / 胶囊屏 192×490）或小米手环 9（固件 3.1.32）上实测复现过。
> **凡未经真机验证的结论，条目内均显式标注。**

## 阅读指引

| 你在做什么 | 先读 |
|---|---|
| 第一次上手，不知道运行时和浏览器差在哪 | 一、运行时铁律 |
| 界面「看得见点不到」 | 三、触摸与命中 |
| 页面打开慢、搜索卡 | 四、性能优化方法论 |
| 要搭离线数据集 | 五、离线资料集架构 |
| 打包、装机、连模拟器 | 六、构建与部署、七、模拟器环境手册 |
| 包体莫名变大、进页慢 | 十一、包体与启动 |
| 没有设计资源，要自己出图标 | 五章 5.y |
| 写答辩 PPT / 报告材料 | 八、PPT 与答辩材料工程 |
| 声称「修好了」之前 | 九、验证纪律 |

---

## 一、运行时铁律

这些不是风格偏好，是该轻量运行时的真实行为差异；外部文档未覆盖，只能实测得出。**违反必出诡异 bug**。

| # | 铁律 | 现象 | 规避方式 |
|---|---|---|---|
| 1 | `show="{{false}}"` **仍占位**（非 display:none） | 隐藏的卡片/提示留出大片空白 | 需真正移除占位时用 `if`；需零占位又要常驻节点时，用**类切换把高度/字号/内距一并归零** |
| 2 | `position:absolute` 在 flex 容器内**不渲染** | 绝对定位的角标/浮层整个消失 | 改用「flex 子项 + 负 margin」；或把节点挂到覆盖整屏的父级上 |
| 3 | `width`/`height` **都是 border-box**（v1.16.295 起定案；早期「width 是 content-box」的结论已撤销） | 按 content-box 心算会低估占位、出现右侧溢出 | 尺寸直接写「含 padding/border 的总宽」。实测：`.cat-icon` 58+border2 → 58.0；`.search-btn` 136+border3 → 135.7 |
| 4 | `flex: 1` **不可靠** | 等分/自适应布局塌陷或被挤压 | 用显式百分比宽度；行内用 `justify-content: space-between` 配固定宽 |
| 5 | 模板内**禁止复杂表达式** | 编译或运行期行为异常 | 所有类名/文案在 JS 侧预拼成字符串，模板只做变量插值 |
| 6 | `if` 节点**插删会渲染错序** | 交替显隐后元素顺序错乱 | 高频切换的节点用常驻 + 类切换；确需 `if` 时避免与其它 DOM 变更同帧发生 |
| 7 | **容器必须显式声明 `flex-direction`** | 无 class 的 div 默认横向排布，元素被排成一行 | 每个容器显式写 `flex-direction: column/row` |
| 8 | `<scroll>` 会**吃掉命中测试** | 元素可见但点击无响应 | 关键可点区域不要放在会被遮挡的滚动容器内；必要时把竞争节点用 `if` 摘掉 |
| 9 | **`flex: none` 会让手环 9 直接重启**（固件 3.1.32） | 应用一打开瞬间手环重启（不是 OOM） | **禁用 `flex: none`**；等价写法用长写 `flex-grow:0; flex-shrink:0; flex-basis:auto` |
| 10 | **覆盖 `flex: 1` 时必须给 `flex-basis`** | 卡片/容器高度塌成 0、父级跟着塌、整块内容不显示 | `flex: 1` 展开含 `basis: 0%`；只写 grow/shrink 会保留 0% → 元素主尺寸为 0。**必须补 `flex-basis: auto`** |
| 11 | **不支持 `flex-wrap: nowrap`** | 想让标签一行横滑，实测仍换行堆叠 | 窄屏不要依赖 nowrap；改用横向 `<scroll>` 容器，或接受换行并做成「标签感」（底色/圆角） |
| 12 | **弱 CPU 上「后台预热」= 前台冻结** | 进入应用后 UI 冻结几十秒直到息屏；模拟器 1~2 秒察觉不到 | 批量初始化（索引构建等）**只在带进度 UI 的加载页做**；不要在首页「顺手预热」 |
| 13 | **`@system.storage` 回调会丢失/很慢** | 启动判断永不落定 → 既不跳加载页也不建缓存 → 首搜现场建索引 → 卡死重启 | 所有依赖 storage 回调的分支都要**超时兜底**（给足 5~6 秒窗口 + 重试）；宁可多走一次加载页（幂等）也不能漏建 |
| 14 | **CSS 值 ↔ JS 常量必须同步** | 改完 CSS 后出现「内容压住输入框/错位」这类像渲染 bug 的症状 | 项目内联动点（如 `_searchHeaderH()` 与搜索态 CSS、`screen1H` 与状态栏高度）；**改 CSS 后全局搜索同名常量**，否则只改一半 |
| 15 | **隐藏但挂载的 `absolute` 组件仍会拦截触摸** | 组件「看不见」了，但它覆盖区域内的元素全部点不动 | `hide` 类属性只做**视觉隐藏**，不移除命中区域。要么真卸载（`if`），要么用类把它**移出屏幕**（`bottom: -999px`）；**改挂载策略后必须复测该区域的点击** |
| 16 | **性能优化必须做「功能回归」对照** | 为提速改了组件挂载/显隐策略后，原本能点的区域失效（本项目真实发生过：键盘保持挂载 → 结果卡全部点不动） | 任何挂载/显隐/层级相关的优化，**必须用「改前能点、改后还能点」的对照实验验证**，不能只看目标指标 |

### 1.17 模板表达式与指令的补充实测

| 项 | 实测结论 |
|---|---|
| `else` 指令 | **支持**。`<div if="{{a}}">…</div><div else>…</div>` 可正常配成分支。已用于交付验证（`loading.ux:22`） |
| `for` 三种写法 | `for="{{list}}"`（$item/$idx）、`for="{{item in list}}"`、`for="{{item in obj.arr[0]}}"` 均可用 |
| `tid` 稳定键 | **只接受静态字段名，不能插值**。写 `tid="{{item}}"` 构建期直接失败：`{{item}} tid expecting a static string，actually a dynamic value` → `ERROR: build error, loader error: UxLoader`。正确写法 `tid="id"`（字段名）。且仅当数组元素是对象时有意义；项目内 `resultList` 是字符串数组，无法用 `tid` |
| 三元表达式 | 模板内**从未使用过**（全仓 grep 0 命中）。`||` 在 `if`/`show` 属性里可用且有先例，但插值里谨慎使用，优先在 JS 侧预拼 |
| `class` 插值 | **禁止** `class="{{item.cls}}"` 这类动态拼接（历史崩机诱因）；改为在 JS 侧预拼完整类名再整体插值 |
| 动态 `style` 绑定 | **崩机级**。手环 9 固件上 `style="height:{{x}}px"` 在值变化时会崩机或静默失效。**所有尺寸走 CSS 类**，需要变化时切类名 |
| `if` vs `show` | **`if` 在条件翻真时会重新插入节点，位置不可靠**。同一个卡片先由 A 条件显示、后来又由 B 条件显示时，节点会被重建并可能跑到别的元素后面。需要「位置固定、只切可见性」时**用 `show`**；且同一卡片内**不要用两个互斥 `if` 分别渲染正文**，改成在 JS 侧合成一个字段、模板只绑一个节点 |
| 页面对象的自定义属性 | **`export default` 里直接写的自定义属性（如 `DEMO_ENABLED: true`）在实例上读不到**（`this.DEMO_ENABLED === undefined`）。页面实例只保证 `private` 块里声明的字段可读写。需要页面级常量时放到 `<script>` 顶部的**模块作用域 `var`**，用裸标识符引用 |
| `for` 内变量必须带 `$` | **写错不报错，整块静默不渲染**。`<div for="{{list}}" @click="pick(item.type)">{{item.label}}</div>` 构建通过、控制台无输出、按钮整块消失。必须写 `$item.type` / `$item.label`（`$` 是硬语法）。排查口诀：**模板里有 `for` 的地方，先检查每个变量引用有没有 `$` 前缀** |
| `position:absolute` 必须显式 `width`/`height` | 宽度 `auto` 会算成 0 或撑满不可控 —— 元素表现为「消失」。`position:absolute; bottom:0` 必须补 `left:0; width:100%; height:<px>` |

---

## 二、多形态适配

- **不要用同一套绝对像素坐标套三种形态**：`designWidth=300` 下各形态可用高度不同，硬编码高度会导致底部按钮出屏。
- **可用设计高 = 屏高 × designWidth ÷ 屏宽**（等比缩放的正确算法）。
  自检：方屏 `480×300÷336 = 429`、胶囊屏 `520×300÷212 = 736`、圆屏 `466×300÷466 = 300` —— 与实测一致。
- 形态差异全部用 `@media (shape: pill-shaped / circle)` 固化在样式层，运行时只判定 `screenType` 一次。
- 图片素材**按原始宽高比缩放**：用固定正方形约束会把 `94×60` 这类宽图横向压扁（曾把 `123`/`En` 键压变形 40%）。
- **三形态真实物理倍率**（图片重采样必用）：

  | 形态 | 物理宽 | 逻辑宽 | 倍率 |
  |---|---|---|---|
  | rect 方屏 | 336 | 300 | **1.1200** |
  | circle 圆屏 | 466 | 300 | **1.5533** |
  | pill 胶囊 | 192 | 300 | **0.6400**（缩小！） |

---

## 三、触摸与命中

本章是全书最关键部分。**「看得见但点不到」是 Vela 最高频、最难查的一类问题**——界面渲染完全正常，没有任何报错。

### 3.1 三条基本原理

1. **视觉盒 ≠ 布局盒**。`transform: scale()` 只缩「画」出来的部分，不缩布局盒。不加裁剪时，盒内溢出部分**仍参与命中测试**。
   - 典型现场：圆屏键盘 `.kb-circle { left:-90px; width:480px; transform: scale(0.625) }` —— 视觉 300px 宽，布局盒 480px 宽。
   - 项目实证注释（`index.ux:794`）：本运行时对绝对定位子容器的裁剪在 **transform 之前的坐标系**生效。所以给父级加 `overflow:hidden` 会把 480 画布截成 pre-transform 的 0~300，键盘左右各被切掉一截 —— **不能这么修**。
2. **「隐藏」不等于「不占命中区」**。见铁律 15。
3. **DOM 顺序决定命中优先级**。同层重叠时**后面的节点赢**。项目实证：键盘容器在 DOM 末尾且 absolute 铺满整屏 → 点搜索框的点击全被键盘容器吞掉，键盘收不起来。修法：把容器盒子压到可见内容高度，让出顶部区域。

### 3.2 边缘死区实测（圆屏 466×466 / dpi320 / designWidth 300）

**现象**：屏幕左侧约 40px、右侧约 10px 的竖条内，点击完全无反应；但**滑动有效**。

| 对象 | 视觉左边界 | 实测可点左边界 | 死区宽度 |
|---|---|---|---|
| 键盘 Q 键（无 transform） | x=8 | x=40 | 32px |
| 键盘 A 行 | x=18 | x=40 | 22px |
| 键盘 Z 行 | x=51 | x=60 | 9px |
| 首页「学习」图标（无 transform） | x=24 | x=45 | 21px |

换算：左死区 **40px = 20dp**，右死区 **10px = 5dp**（dpi 320 → 1dp = 2px）。

**已排除的假设**（逐条做过对照实验）：
- 不是 transform 坐标错位 —— 首页图标完全无 transform，死区同样存在。
- 不是圆形屏几何裁剪 —— y=379 处圆的几何边界在 x=51，而死区右界仍只到 60，形状不吻合。
- 不是注入通道失效 —— 从 x=10 向右滑**能成功触发返回**，说明事件送达；`tap` / `longtap` / `touch` 三种注入模式结果一致，`swipe` 不受影响。
- 不是单个元素的问题 —— 跨元素（键盘/图标/搜索框）死区右界集中在 x≈40~45。

**没有定论的部分（如实记录）**：具体成因未闭合。简单假设 `(x+90)/0.625` 反算出的边界与实测 x=40 不符，在偏差公式未推出前改 CSS 属于猜改。**且此现象未在真机上验证**，真机是否复现未知。

**排查这类问题的正确顺序**：
1. 先验注入通道本身有效（用「滑动」或「明显会换屏的按钮」做正例）。
2. 再跨元素测死区边界（逐点点击 + 像素判据）。
3. 再做「有 transform / 无 transform」对照。
4. 最后才怀疑某个具体容器的布局盒。

### 3.3 命中问题的稳定判据

不要用 `dmesg` 数事件条数当判据——**Vela 内核 dmesg 环形缓冲只有约 1007 字符**（日志里可见 `[logBuff] over len 1007`），两次 `adb shell dmesg` 之间常被整段冲掉，计数差会出现负数。

改用**像素判据**：

| 你要判什么 | 判据 | 实测标定值 |
|---|---|---|
| 键盘是否在场 | 全屏 `(38,38,38)` 像素占比 | 键盘开 **25.8%** / 键盘关 **0.0%**（9 px） |
| 某次点击是否产生输入 | 输入框文字带（`x 55~410 / y 150~200`）像素差 > 5 | 点错键也会变，所以只判「有无反应」 |
| 界面是否变化 | 截图文件字节数 | 同字节数 ≈ 同画面 |

### 3.4 触摸测试的三大污染源（每一个都会让结论作废）

1. **冷启动弹框吞点击**。`am start` 后「蓝牙未连接」模态框会**延迟数秒**出现，把所有 tap 吃掉。症状：所有点击「无反应」，容易误判成死区扩大或修复无效。
   - 对策：连点两次「知道了」区域；**每次采样前自检「第一个字母键是否真的输入了字符」**，没输入就重开。
2. **键盘自己关掉了而脚本不知道**。后续截图全是首页，被当成「键盘所有位置都点不动」。
   - 对策：每次点击前用键帽像素占比自检，不在场就重开；仍失败则把该点标 `INVALID` 而不是 `MISS`。
3. **样本有效性问题导致「0 条 = 修好了」的误判**。本项目踩得最深的一个坑，见 9.2。

---

## 四、性能优化方法论

### 4.1 最大杀手：`@media` 块内每条规则单独求值

**根因**：Vela 引擎对 `@media` 块内的**每条规则**都要单独求值一次媒体查询，成本是块外规则的 **4~9 倍**。圆屏上 `@media (shape: circle)` 条件恒真，这层外壳纯属白付。

分档实测（同一基线逐项删减，圆屏）：

| 规则位置 | 条数 | 耗时 | 单条成本 |
|---|---|---|---|
| 基础（`@media` 外） | ~77 | 87ms | **1.1ms** |
| `@media (shape: pill-shaped)` | 49 | 225ms | **4.6ms** |
| `@media (shape: circle)` | 59 | 555ms | **9.4ms** |

**收益**：把圆屏 @media 外壳摊平后，资料页**建树 895~1026ms → 143~161ms（−84%）**。

**注意事项**：
- 摊平只能在 `<style>` 段内操作。`@media (shape: circle)` 这串字在 JS 注释里也大量出现，**不限定范围会从注释处吞掉大段脚本**（本项目实际踩到，`index.ux` 被吃掉 2620B 且锚点失效）。
- 主线 `src/` 不能摊平（胶囊屏依赖 pill 块，三形态共存必须靠媒体查询）。只作用于**派生包**。
- 摊平语义等价性：块内容位置未动，层叠顺序与条件永真时一致。

### 4.2 分阶段埋点：埋点必须落在观测终点之后

外部截图轮询测进页耗时**不可靠**（tap 前不在首页会恒得 `-1ms`；`am start` 后画面可能停在表盘；swipe y 太靠底会触发系统退出手势）。

正确做法：跳转前写 `global._navT0 = Date.now()`，在目标页 `onInit` 与 `onShow` 各取一次时间，把「路由派发」与「建树 + 首帧渲染」分开显示。

**★ 坑**：曾把计时结果写在 `onShow` 里，而 `device.getInfo` 回调的整树重建发生在 `onShow` **之后** → 导致「改初值无差异」的误判。**埋点必须在观测终点之后落笔**。

首测结果：路由 96ms · 建树 953ms → **94% 的开销在页面建树，不在路由**。这个比例决定优化方向，不先测就会瞎猜。

### 4.3 图片解码内存按「宽×高×4」算，与磁盘字节无关

图片解码内存 = **宽 × 高 × 4**（RGBA）。素材尺寸该按「各形态真实物理像素」定，不是按设计稿画布定。

实测收益（语音按钮两张图）：

| 图片 | 改前 | 改后 | 解码 |
|---|---|---|---|
| `ask-btn-200x72.png` | 400×144 | 260×94 | 225KB → **95KB** |
| `ask-btn-184x130.png` | 368×260 | 130×92 | 374KB → **47KB** |

合计省 **457KB** 解码堆，包体 1,829,966 → 1,802,152 B（−27,814）。验证：首页按钮逐像素对比差值>12 仅 **2.98%**（全在边缘抗锯齿）。

### 4.4 `show` 只控绘制、不控创建

**实测（`/proc/meminfo` 的 `Umem` 行）**：

| 状态 | 已用内存 | 内存块数 | 增量 |
|---|---|---|---|
| 基线（首页，键盘关） | 21,279,796 B | 1160 | — |
| 点搜索框开键盘 | 22,955,076 B | 1402 | **+1.60 MB / +242 块** |
| 切数字态 | 23,240,268 B | 1422 | +0.28 MB / +20 块 |
| **切回字母态** | 23,239,996 B | 1423 | **±0（不回退）** |

**结论**：切回后内存不下降 → `show` 切换**不销毁节点、不重新解码**；图片在**节点创建时就全部解码**。

推论：`show` 隐藏的节点照样占内存，改成 `if` 能省内存，但代价是每次切换都要重建子树 + 重新解码。本项目实测键盘 24 张图全解码 506KB，其中默认态白建（不可见）9 张 ≈ 215KB；**判为不改**——现有实现是稳态零成本，而动态建树有崩机风险。

### 4.5 高频日志：先量化，再决定关

**量化方法**：拿协议常量算帧数。手机端 `MAX_CHUNK_BYTES = 4096`、`paceMs = 60`；本仓数据集共 3,023,509 B → 一次全量约 **738 帧 / 44.3 秒 / 16.7 帧每秒**。每帧原本都付 `JSON.stringify(4KB 对象)` + `console.log` + `storage` 写入。

**修法**：加模块级开关（`var DEBUG_FRAME = false`），控制帧照常打、分片帧只在排障时开。

**旁证**：`[logBuff] over len 1007` 出现 —— 内核缓冲仅 1007 字符，高频日志确实会顶满丢日志。

### 4.6 降噪判据不能建在「require 抛异常」上

**踩过的坑**：想给 `require('@system.interconnect')` 加失败退避。60 秒长测证明**完全没生效** —— 因为 Vela 上该 `require` **不抛异常**（框架从 "old manager" 兜底返回对象，日志 `Try find feautre in old manager`），所以 `catch` 永不进，退避闸恒假。真正失败的是 `conn.send`。

**正解**：模块级缓存 `require` 的结果（只缓存成功返回值）。实测 interconnect 日志 **36 → 7 条**。

### 4.7 「查过但不改」也要用数字证明

审查的产出不只是改动。本项目 8 轮审查里有 4 轮结论是「不改」，每轮都留了量化依据：

| 查了什么 | 量化结论 |
|---|---|
| 热路径文本解析 | 6 个 block 串行解析合计 **11.57ms**；缓存 JSON 膨胀仅 1.05~1.23×、单次 ≤312µs；detail 分片最大 **86µs** |
| 正则 | `new RegExp` 全仓 **0 处**（无循环内重复编译） |
| storage 频率 | 无高频写；运行时日志已 2 秒窗口合并 |
| 事件订阅 | 覆盖式赋值（后订覆盖先订），O(1)/次，非泄漏 |
| 模板死分支 | T9 子树（66 行/47 节点/10 img/~5.7KB）有 `else` 守卫，**恒不创建，运行时零开销** |

**为什么值得记**：防止下一个人（或下一轮 AI）重复挖同一件事。

### 4.8 顺带发现的死代码

`SearchEngine._saveProgress` / `_loadResumeProgress` 全仓**零调用方**，只有 `_clearResumeProgress` 被设置页调用。配置项 `resume.saveInterval: 500` 从未生效。

**但不要顺手删**：无调用方的死代码删除回归风险大于收益（可能是外部/未来接入点）。记录下来即可。

---

## 五、离线资料集架构（可复用）

一套经过验证的「通用离线检索」数据规范，**引擎与资料完全解耦**：

```
datasets/<集名>/
├── meta.json        # 自描述：fields.map / fields.detail / fields.filter + 分片与桶大小
├── map_N.txt        # 卡片分片：localId|year|region|title（列序由 meta 声明）
├── detail_N.txt     # 详情分片：localId|keywords|字段1|字段2…（按 meta.fields.detail 顺序）
├── block_0.txt      # 倒排索引：桶号|id列表（DJBXOR 哈希 % bucketSize）
└── icon.png
```

### 5.1 要点

- **分词与哈希必须建索引侧/查询侧逐字一致**，否则求交恒为空 —— 这是最难查的坑。中文逐字入桶；英文按前缀入桶时两侧的**最小前缀长度必须相同**。
- **全局 ID** = `datasetId << 20 | localId`：跨集唯一、免映射表，收藏与详情跳转统一寻址。
- **分片粒度按单条正文长度决定**：单条越长的资料集，每片条数要越小（曾出现单片 300KB → 详情页整片读入，峰值内存过高；改为 10 条/片后降到 54KB）。
- 新增资料集只需「放目录 + 注册一行」，无需改引擎与 UI。

### 5.2 哈希与分词的真实实现（照抄可用）

```js
// djb2 变体；注意全程 >>>0，否则 JS 位运算会得到负数
function hashCode(str) {
  var hash = 5381;
  for (var i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}
// 分隔符：空白、中英文逗号、中文顿号
var SEP = /[\s,，、]+/;
// 英文：每个前缀都入桶（"life" → l, li, lif, life）
// 中文：逐字入桶
```

### 5.3 LRU 上限与「流式临时抬升」

Block/Map 常驻上限各收到 **1**。但原实现有个隐蔽性能坑：循环内逐条 `if (!map) await ensureMap(id)`，候选分散在 >2 个 map 且翻深页时会形成「载 map3 → 挤掉 map1 → 要用 map1 → 重载 → 挤掉 map2」的抖动 → 一次翻页多次重复 I/O + 百 KB JSON.parse。

**修法**：切片前先统计本页会用到哪些 mapId，**临时抬高 LRU 一次性载齐**，再走纯内存切片，最后按所有权标记还原。

### 5.4 列表下标越界：`$idx` 没有安全网

**踩坑现场**：候选字栏用 `for="{{cvalList}}"`（`cvalList` 按 `maxlength=20` 生成 20 格）+ `value="{{resultList[$idx]}}"`。实际候选只有 5 个左右 → 下标 5~19 共 15 格取到 `undefined` 传给 `value`。

**后果**：`[InspectHostSetDomAttributes:78] Unsupported type for setDomAttributes: 2`，每条按键 5~7 条，反复刷屏。

**修法**：`for` 直接遍历真实数据 `for="{{item in resultList}}"`，从根上消除越界。

**残留问题（如实记录）**：改成遍历真实数据后报错数并未归零，说明还有其它来源未定位。**不要在此处的「降到 0 条」结论上偷懒**，见 9.2。

---

### 5.x 蓝牙推送来的动态资料集：两个必改点

动态集（手机端分片推送到 `internal://files/datasets/<ds>/`）与内置集走同一套引擎，但有两处**必须额外处理**，否则「传成功但用不了」：

1. **首页入口要写进 `GROUP_MAP`**。首页图标行读的是 `getGroupEntries()`，它**只遍历静态常量 `GROUP_MAP`**。只把动态集 `push` 进 `DATASETS` 是不够的——无论传多少次，首页都不会出现它的入口，于是点不进去、里面可用于筛选的字段也测不到。
   修法：注册时给它建一个独立大类，`groupId` 从 100 起（避开静态组 0~5）：
   ```js
   var dynGroupId = 100 + (ds.id - DYN_ID_BASE)
   GROUP_MAP[dynGroupId] = { name: ds.name, icon: opt.icon || '/common/datasets/bt/icon.png',
                             colorClass: 'ci-ds', datasets: [ds.id] }
   ```
2. **图标要单独传**。常规的资料文件清单是纯文本（`meta.txt` / `map_N.txt` / `detail_N.txt` / `block_N.txt`），**二进制 `icon.png` 不在里面**，所以动态集只能用统一占位图。
   修法：新增一帧 `{t:'ds-icon', ds, name, b64}` 承载 PNG 的 base64（interconnect 只投递文本帧，二进制必须 base64），**必须放在 `ds-end` 之前**；手环端用 `@system.file.writeArrayBuffer`（**不是 `writeText`**，会损坏二进制）落到 `internal://files/datasets/<ds>/icon.png`，再把该路径写进 entry 的 `icon`。

> 顺带：`writeArrayBuffer` 的 `buffer` 参数类型是 `Uint8Array`，手环端没有内置 `atob`，需自己写 base64 解码（`AudioUp.js` 里只有编码方向）。

---

### 5.y 没有设计资源时怎么出 PNG 图标

项目内 21 个图标全部是脚本生成的（无第三方设计文件）。两条路都验过：

**A. Node 手写 PNG 编码器**（zlib deflate + CRC32，手拼 IHDR/IDAT/IEND 块，4× 超采样抗锯齿）。好处是零依赖，坏处是要自己处理两个坑：

- **变量遮蔽**：外层 `const sx = width / base` 与内层采样循环 `for (let sx ...)` 同名 —— 绘制函数里 `distToSeg(x, y, g[0] * sx, ...)` 的 `sx` 被内层遮蔽，线段坐标乘上采样序号 0~3 → 每个采样点线段跳位 → alpha 恒低（如恒 21），图标淡成虚线。**内层循环变量换名（`sx2`）+ 坐标缩放提到循环外**。
- **描边断裂**：用隐式方程距离带（`|v|/|∇v| < band`）画描边，在高曲率区（心形顶凹/底尖）距离近似失真、描边碎裂。**正确做法是双实心差集法**：环 = 外心实心 ∩ 内心补集，逐像素判「外心内 && 内心外」。坐标映射注意方向——画布点映射到内心坐标系应乘 `R/Ri`（放大），写反成 `Ri/R` 会导致「内心比外心大」、环恒为空。

**B. `@resvg/resvg-js` 渲染 SVG**（`devDependencies` 里已有）。写 SVG 字符串 → `new Resvg(svg, { fitTo: { mode: 'width', value: 520 } }).render().asPng()`。适合「渐变+高光+描边」这类复杂面，因为本运行时不支持 CSS 渐变/阴影，但 `<image>` 能渲染带渐变的 PNG。

**尺寸策略**（直接决定解码堆占用）：

- 出**显示尺寸的 2× 源图**（26px 显示 → 52px 源），alpha 过渡带用 `pow(a/255, 1.8)` 收紧——兼顾曲线余量与缩放渗出。
- 源图过小（26px 原生）曲线画不好、描边断裂；过大（128px 缩到 26px）缩小 5 倍丢点严重渗色。
- **按每个使用处的实际显示宽度分别生成**（`heart_26` / `heart_47` …），grep 每个 `width` 取值逐一匹配；**没被引用的图标文件要删**（`grep -rl 文件名 src` 查引用计数）。

---

## 六、构建与部署

### 6.1 构建

```bash
# 主线构建（三形态共存）
npx aiot build            # 或项目封装的 build 脚本

# 派生包（形态裁剪后）
python tools/gen_xxx.py   # 派生脚本只处理 .ux + manifest.json
bash tools/build_xxx.sh   # 替换式构建，结束后还原
```

**要点**：
- `quickapp.config.js` 里若写死 `enableJsc: false`，**配置会压过命令行 `--enable-jsc`**。结果：包里 0 个 `.jsc`、数十万字节 JS 现场解析 → 进页慢的真因之一。改成 true 后 `.jsc` 数量与体积显著改善。
- 版本号必须**三处同步**：`src/manifest.json` 的 `versionName`/`versionCode`、`app.ux` 的 `APP_VERSION` 常量。本项目曾出现 `APP_VERSION` 停在旧版、与 manifest 脱节 27 个版本。
- 用 Python `json.dump` 改 manifest 会**丢掉文件末尾换行**（`\ No newline at end of file`），需 `printf '\n' >>` 补回。
- **`.ux` 备份文件不要留在项目内**：`aiot build` 会把它们当源文件编译，报一串 `assets/... file does not exist` + `loader error: UxLoader`。备份放项目外。
- 构建后回读产物**字节数 + 时间戳**判新鲜度；`build success` 也可能产出旧包。

### 6.2 装机

```bash
ADB="<sdk>/tools/adb/win/adb.exe"   # 不在 PATH
export MSYS2_ARG_CONV_EXCL="*"

timeout 90 "$ADB" push dist/xxx.rpk /data/local/tmp/xxx.rpk
timeout 180 "$ADB" shell "pm install /data/local/tmp/xxx.rpk"   # 必须单独跑 + 套 timeout
sleep 6
timeout 20 "$ADB" shell "cat /data/app/<包名>/manifest.json" | grep versionName
```

**坑**：
- `pm install` 若与后续命令写在同一条 shell 里，常出现 RC=1 且**无任何输出**；单独跑并套 `timeout` 才稳定。
- `pm install` 是**异步返回**的，装完立刻回读可能拿到旧版本号 —— 必须 `sleep 6~7` 再读。
- **`/data/app/packages.list` 不一定包含你的包，但应用照样能 `am start`**。所以不能用它判断「装没装成功」，改回读 `manifest.json`。
- `adb push` 的**源路径必须写 Windows 形式** `E:/tmp/x.rpk`；写 `/e/tmp/x.rpk` 会 `cannot stat` 失败。若脚本不 `set -e` 就会静默跳过，后续测的全是残留旧包（本项目因此白测 4 轮）。
- `am force-stop` 在 Vela 上**不支持**（只认 `am start` / `am stop`）。要彻底重启进程用模拟器 `reboot`。

### 6.3 部署后不生效的三个常见假象

1. 旧进程驻留旧代码（前台驻留时安装新包不生效）→ 冷启动或 `reboot`。
2. 装的包是旧的（见上面的 push 路径坑）。
3. 开关/配置没生效（如 `enableJsc`）→ 回读包内文件确认。

---

## 七、模拟器环境手册

### 7.1 启动（以圆屏 Vela_Virtual_Device5 为例）

```bash
export MSYS2_ARG_CONV_EXCL="*"
export ANDROID_AVD_HOME="$HOME/.vela/vvd"
cd "$HOME/.vela/sdk/emulator/windows-x86_64"
./emulator.exe -vela -avd Vela_Virtual_Device5 -no-snapshot-load -grpc 8557
```

**`-vela` 不能漏**。漏了会报：
```
ERROR | This AVD's configuration is missing a kernel file! ...
PANIC: Broken AVD system path. Check your ANDROID_SDK_ROOT value
```
因为 Vela AVD 用的是 `nuttx` 内核而非标准 Android 的 `kernel-ranchu`，只有 `-vela` 标志才走 Vela 启动路径。别被 `ANDROID_SDK_ROOT` 的报错文案带偏 —— 那不是根因。

### 7.2 设备命名

`adb devices` 里显示 `emulator-5554 device product:adb dev model:adb_board device:NuttX`。
**gRPC 端口和 adb 序号是两套编号**：gRPC 是启动时 `-grpc` 指定的（如 8557），adb 序号是 5554/5556。要拿真实端口只能读进程命令行：

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object {\$_.Name -like '*emulator*'} | Select ProcessId,CommandLine"
```

### 7.3 截图与点击

- 截图走 gRPC：`node _shot.js <grpcPort> <out.png>`
- 点击走 gRPC：`node _mouse_op.js <grpcPort> tap <x> <y>`（另有 `swipe` / `longtap` / `touch`）
- **输出路径必须用 `E:/tmp/x.png` 正斜杠形式**。传 `/e/tmp/x.png` 会被 Node 解析成 `E:\e\tmp\x.png` → ENOENT。

### 7.4 nsh 的局限（不是 Android shell）

Vela 用的是 NuttX nsh，**没有** `grep` / `head` / `find` / `wm` / `input` / 后台子 shell。所以：
- 不能 `adb shell input tap` —— 只能用 gRPC 注入。
- 不能 `ps -ef` —— 进程号从 `dmesg` 行首的中括号数字取。
- 不能在设备上跑管道过滤 —— 把日志整段拉回主机再过滤。

### 7.5 内存看 `/proc/meminfo`

格式不是 Android 的 `MemTotal`：
```
total used free maxused maxfree nused nfree name
130159616 22955076 107204540 24746304 106643360 1402 143 Umem
```
第二行的 `Umem` 才是应用内存。

---

### 7.x 模拟器截图的真实格式（踩过的两个坑）

- **`/dev/fb0` 不是 16 位**。Vela 模拟器（`Vela_Virtual_Device5`，466×466）的 fb0 实测 **1737248 B = 466×466×8**，即 **2 帧 × 32 位 BGRX**。按 16 位 `BGR;16` 渲染只会得到半个帧 → 满屏彩色竖条纹，极易误判成「渲染/截图失败」。
  ```python
  raw = open(dst,'rb').read()
  im = Image.frombytes('RGB',(466,466), raw[:466*466*4], 'raw','BGRX')
  ```
- **远端临时文件名必须每次唯一**。`dd if=/dev/fb0 of=/tmp/fbcap.raw` 一旦失败或只写一半，会留下**上一次的旧文件**，于是连续多次截图 sha 完全相同，看起来像「界面没动」——实际读的是陈数据。改用带序号的文件名 + 拉回后校验字节数，不足直接报错。

### 7.x 点击注入：控制台 `event` 无效，只用真实鼠标

- 控制台（`127.0.0.1:5554`，token 在 `~/.emulator_console_auth_token`）的 `event mouse` / `event send EV_ABS` 对 Vela 快应用**完全无效**——返回 OK（内核收下）但界面零变化。那是 Android 内核 input 语义，Vela 的触摸不经过它。
- 可行路径：拿**模拟器窗口的屏幕坐标**，用 `SetCursorPos + mouse_event` 点。窗口与屏幕的关系需要标定：截窗口图，把 fb 截图当模板做多尺度匹配，求出「屏幕区在窗口内的偏移 + 缩放」，之后 `fb坐标 → 窗口内偏移 + 缩放 → 加窗口左上角` 即得屏幕坐标。
- 标定时注意：`Get-Process qemu-system-armel` 的 `MainWindowHandle` 有时指向**最小化/不可见的小窗口**（rect 为 `-32000,-32000` 或 `160x28`）。要枚举该进程所有可见窗口，按标题（`Android Emulator - <AVD>:5554`）挑真正的那个句柄。

---

## 八、PPT 与答辩材料工程

用 `python-pptx` 批量生成/修改 PPT 时的实战结论。

### 8.1 ★ `python-pptx` 的 `save()` 在大型 PPT 上会毁文件

**实测**：48~49MB 的 PPT，用 `Presentation.save()` 保存后，**目标页被清空成模板占位**（「以下填写模块标题」），且包里出现 `Duplicate name` 警告、成员数从 251 掉到 245。

**根因**：`python-pptx` 的 save 会**整包重新序列化** —— 重排 zip 成员顺序、丢弃它认为「未被引用」的部件。

**正确做法**：只改目标 slide 的 XML，其余成员逐字节原样 copy：

```python
# 1. 从 presentation.xml 的 sldIdLst 解析真实页序（见 8.2）
# 2. 只读目标 slide 的 xml，用 lxml 改 a:t 文本
# 3. 输出时其他成员用原 ZipInfo 原样 writestr
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w") as zout:
    for item in zin.infolist():
        data = new_blobs.get(item.filename, zin.read(item.filename))
        zout.writestr(item, data)
# 4. 断言：除目标 slide 外，其余成员必须逐字节一致
diff = [n for n in namelist if a.read(n) != b.read(n)]
assert all(n in new_blobs for n in diff)
```

### 8.2 页码映射不能靠 `slideN.xml` 猜

包被重排过多次后，**第 23 页可能对应 `slide10.xml`**。必须从 `presentation.xml` 的顺序解析：

```python
pres = etree.fromstring(z.read("ppt/presentation.xml"))
rels = etree.fromstring(z.read("ppt/_rels/presentation.xml.rels"))
rel_map = {r.get("Id"): r.get("Target") for r in rels}
order = []
for sld in pres.find(f"{{{NS_P}}}sldIdLst"):
    rid = sld.get(f"{{{NS_R}}}id")
    order.append("ppt/" + rel_map[rid].lstrip("/").replace("ppt/", "", 1))
# order[22] 才是第 23 页
```

### 8.3 `a:t` 嵌在 `a:r` 下，必须用 `iter()`

```python
# 错：findall 只找直接子元素，永远返回空列表
ts = pa.findall(f"{{{NS_A}}}t")

# 对：递归找
ts = list(pa.iter(f"{{{NS_A}}}t"))
if not ts:
    raise RuntimeError("该段没有 a:t，跳过而不是擅自增删段落")
ts[0].text = new_text
for extra in ts[1:]:
    extra.text = ""     # 多出来的清空，避免残留旧文字
```

**段落数必须匹配**：每个 shape 的 `a:p` 数量要与替换文案的行数一致，不一致就跳过并报告。宁可少改也不擅自增删 `a:p`（会改变行距与对齐）。

### 8.4 颜色：低 alpha 填充不是实心色

模板里的「浅灰卡片」实际是：
```xml
<a:solidFill>
  <a:srgbClr val="0F172A">
    <a:alpha val="4000"/>     <!-- 4% 不透明度！ -->
  </a:srgbClr>
</a:solidFill>
```
它是 4% 的深色叠在白底上 → 视觉是**极浅的灰白**。任何自己写的预览/渲染工具**必须做 alpha 混合**，只读 RGB 会把它画成实心深蓝，得出「配色全错」的错误结论。

### 8.5 多 AI 并发写同一文件

- 改动前先记 `stat` 的 mtime + 字节数，改完再比。
- **别人正在跑的时候不要覆盖它正在写的文件**（哪怕内容是坏的）—— 会把它那一轮成果一起抹掉。
- 想在隔离环境验证别人的脚本，把脚本和数据一起复制到子目录跑，不要改主文件。
- 定向替换比整包重写安全：后者会把并发期间别人的改动一起回滚。

### 8.6 无 Office 环境下的近似预览

本机没有 PowerPoint / LibreOffice / WPS 时，可用 PIL 按形状真实坐标 + 填充色 + 字号画近似图，**只用于判断**：
- 版式位置、间距、卡片对齐
- 文字是否挤出框 / 撞边界
- 数字与标签的视觉层级

**不能反映**：真实字宽、阴影/渐变、动画、alpha 混合后的观感（除非自己实现混合）。

---

## 九、验证纪律

### 9.1 宣称完成前必须跑验证并给证据

不靠「应该没问题」。证据形式：截图、日志原文、脚本输出、产物字节数。

### 9.2 ★ 「降到 0 条」必须先证明样本有效

这是本项目踩得最深、代价最大的一个坑，完整记录如下：

**经过**：排查某报错时，改了一处代码后采样得到「报错 0 条」，据此对外宣布「从 82 条降到 0 条」。后续清点全部样本才发现**数据自相矛盾**：

| 样本活动量（`processEvent` 计数） | 报错条数 |
|---|---|
| ≤ 19（低活动） | **一律 0 条** |
| ≥ 21（正常活动） | **一律 20+ 条** |

规律很干净：那些「0 条」**全是假阴性** —— 冷启动弹框挡住了所有点击，输入根本没发生。改动其实没有任何效果，已全部回滚。

**教训（写成硬规则）**：
1. **任何「0 条 / 无异常 / 已消除」的结论，先证明触发条件确实发生了**。输入没发生 ≠ 修复生效。
2. 样本里出现「低活动样本全绿、高活动样本全红」这种**按活动量分层**的规律，就是假阴性的指纹。
3. 计数类判据必须配合一个**独立的正例判据**（如「第一个按键是否真的输入了字符」）。
4. 判据本身不可靠时（如 dmesg 只有 1007 字符），换判据，不是在不可靠判据上加大采样量。

### 9.3 反向验证：修复要能把绿灯变红

声称修好之后，把改动撤回，确认现象**复现**，再恢复。只变绿不变红的验证不算验证。

### 9.4 长跑任务要防状态漂移

- 探针跑久了「键盘已关而脚本不知」→ 每次操作前自检前置状态。
- 异步安装/回调要 `sleep` 后回读，不信任返回值。
- 多轮之间复位状态（清空输入、回到首页），避免上一轮残留污染下一轮。

### 9.5 部署要冷启动

前台驻留时安装新包不生效（旧进程驻留旧代码）→ 杀进程冷启动后再装。

### 9.6 性能数据要留佐证

把分阶段耗时埋点写进运行时日志，使数据可复现；同时记录**采集环境**（机型/模拟器、端口、版本号），因为换环境结论即作废。

---

## 十、高频疑难速查

| 现象 | 根因 |
|---|---|
| 一行本该 6 个元素，只显示 2 个 | 单元格没写宽度 → 内部 `input` 按字号取**文字固有宽**（约 150px），右侧被裁而非换行 |
| 整个子树可见但整片点不动 | 该子树与某个 `<scroll>` 命中区重叠，滚动容器赢了命中测试 |
| 点某处触发整机卡死（连 adb 都失联） | VM 级挂起：在大 DOM 变更（区块销毁/创建）的同时创建重型组件；把两者错帧即可规避 |
| 键盘/列表按键无反应 | 组件节点在 DOM 顺序上被常驻滚动容器压住 |
| 详情页字段串位 | 物化数据的列布局与 `meta` 声明不一致（同一批数据混用了两套列序） |
| **搜索完成后那一瞬间搜索框塌到角落** | 动态 `style` 绑定在固件上失效 + 一帧内三次重排叠加。修法：高度全部改成 CSS 类常量，搜索态切另一个类，**不在 style 里插值** |
| 屏幕边缘约 40px 内点不动，但滑动正常 | 见 3.2（成因未完全闭合，已排除 transform 错位 / 圆屏裁切 / 通道失效） |
| 应用能 `am start` 但 `packages.list` 里没有 | 该运行时按目录存在启动，`packages.list` 不是必要条件 |
| 改了代码但行为没变 | `enableJsc` 被配置压死、装的是旧包、或旧进程驻留 —— 三选一，逐项排 |
| 改了代码但真机毫无变化，模拟器正常 | **`build_s5.sh` 这类「替换式构建」会用 `src_s5/` 覆盖 `src/` 的 `.ux`**。只改 `src/` 那份，一打包就被替掉。**改 `.ux` 必须双写**；`.js` 只在 `src/`（不在覆盖名单里） |
| 某张卡片先出现、随后跑到列表末尾/消失 | 该卡片及其子节点用了 `if`（且常有互斥 `if` 双节点）→ 条件变化触发节点重建。改 `show`，正文合成单字段 |
| 页面上写了开关常量，但分支永远不进 | 常量写成了页面对象属性（`export default` 内的自定义键）。移到 `<script>` 顶部模块作用域 `var` |

---

## 十一、包体与启动：构建器不做 tree-shaking

**这是最容易看走眼的一条：`rpk` 里没有独立模块文件。**

```bash
unzip -l dist/*.rpk | grep -E "\.jsc$"                          # 只有 pages/**/*.jsc 与 app.jsc
unzip -l dist/*.rpk | grep -iE "SearchEngine|DatasetManager"     # 命中 0 条
```

同一个 `SearchEngine.js` 会被**内联进每一个引用它的页面**，在包里存在 N 份副本、互不共享。页面越多、引用越广，包体与启动解析耗时成倍膨胀。

判定某个页面是否真背了引擎，**不要 grep 源码，要 grep 字节码的字符串表**：

```bash
unzip -p dist/*.rpk pages/index/index.jsc > /tmp/i.jsc
strings /tmp/i.jsc | grep -c "_loadChunkFromFileText"   # 1=内联了 0=已剥离
```

⚠️ 别用 `getSearchEngine` / `maxLoadedChunks` 这类通用符号判定——它们在多处同名出现，会误报。要用**该模块独有的长字符串**（如 `search_engine_map__ds0v2_0`、`_loadChunkFromFileText`）。

**真实账单**（本项目 v1.16.392 实测）：首页只调用 `isCacheBuilt` 6 次，却背了 **267,466 B** 源码闭包；设置页只为 `clearAllCaches` 一个函数背了 **41,472 B**。

**根因不止「直接 import」——`require()` 同样被当静态依赖**：

```
index.ux → AssistantEngine.js → BtTransfer.js 里 require('./DatasetManager.js') → SearchEngine.js
```

删掉页面自己那行 `import` **不够**：中间任何一层模块里的相对 `require` 都会把整条链拖进来。改完发现体积没降，八成是还有别的模块在 require。

**正确做法**：把「叶子能力」统一挂到 `global`（`global.getSearchEngine()` 之类），让中间层不再有指向引擎的静态引用。同理，页面之间不要用 `import` 共享数据——模块实例按页面作用域隔离，用 `global` 做单点。

---

## 参考文件

- 本仓 `docs/`：数据格式规范、模块化规范、图标自定义架构与蓝牙协议设计
- 本仓 `quickapp/hello_quickapp/tools/`：资料集拆分与校验脚本（`split_dataset.js` / `verify_dataset.js`）、各集 spec
- 源码内注释：每条改动的版本号、现象与规避方式都写在被改的那行附近（`grep v1\.16` 可全局串联）
- `references/pitfalls.md` — 完整坑清单，14 节，含真实报错文本与命令。**§13 = interconnect 收发专章**（同步 send 被吞、对象/字符串跨机型差异、排查顺序、接收器只初始化一次/重绑）；**§14 = 推包与验证陷阱**（`App.installed` 回执、WiFi vs 蓝牙判据、旧时段日志、广播延迟派发、进程被杀）
- `references/deploy-notes.md` — 构建 / 模拟器 / 真手环全部命令集与故障处置
- 第八章的 PPT 做法已给出可直接照做的命令行片段，无需依赖额外脚本
