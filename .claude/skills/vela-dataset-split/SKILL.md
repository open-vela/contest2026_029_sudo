---
name: vela-dataset-split
description: 为 Vela 快应用《资料库》拆分或校验离线资料集（生成手环可读的 map/detail/block/meta 索引文件）。当需要新增资料集、修改已有资料内容、或验证已有数据与源数据是否一致（排查搜不到/详情错乱/年份搜索错位类事故）时使用。
---

# Vela 资料集拆分与校验

《资料库》手环应用的数据是「预置离线索引」：源数据（人可读的文本行）经拆分工具转成手环引擎可加载的四类文件。本 Skill 覆盖「拆分 → 校验 → 发布」全流程。

## 一、数据格式速览（四类产物）

所有 `.txt` 约定：`\n` 分隔、**无尾换行、无 `\r`、UTF-8 无 BOM**。

| 文件 | 行格式 | 说明 |
|---|---|---|
| `map_N.txt` | `localId\|year\|regionIdx\|标题` | 目录条目，每 200 条一片；localId **必须 0..N-1 连续**（引擎二分查找） |
| `detail_N.txt` | `localId\|关键词\|字段1\|字段2…` | 详情，每 100 条一片；字段名在 meta.json 的 `fields.detail` 声明 |
| `block_0.txt` | `桶号\|id1,id2,…` | 搜索倒排桶（哈希取模 bucketSize=2048）；**分词必须与引擎查询侧一致**（纯字母词≥3 入 3..len 全部前缀小写；其余逐字符） |
| `meta.txt` | 单行紧凑 JSON | 引擎物化视图（totalCount/regionList/maps/mapChunkSize…），**键序即字节序** |
| `meta.json` | 缩进 JSON | 人类自述声明（字段名/图标/集 ID），引擎不读 |

字段值中的竖线物化为全角 `｜`、换行物化为字面 `\n` 两字符。

## 二、标准工作流

```bash
# 1. 改 spec（声明源文件/采样策略/字段模板）——人类唯一需要编辑的文件
vim tools/specs/<集名>.json

# 2. 拆分（产出写到 spec.outDir）
node tools/split_dataset.js <集名>

# 3. 校验（结构七项 + 与 spec 重建的逐字节比对）
node tools/verify_dataset.js check src/common/datasets/<集名> <集名>

# 4. 数据变了必须递增缓存版本（否则手环命中旧缓存）
#    src/SearchEngine/SearchEngine.js  config.cache.version +1
#    src/manifest.json                 versionName/versionCode 递增

# 5. 构建并确认（只看 tail 不够，必须 grep 成功关键字）
npm run build 2>&1 | grep "build success"
```

**新增一个资料集** = 新建 `tools/specs/<名>.json`（声明 `parser`/`sources`/`mapLine`/`detailFields`/`bucketText`/`regionList`）+ 在 `DatasetManager.js` 注册 + 生成图标。全部参数含义见 `docs/资料拆分指南.md`。

## 三、通用能力（跨项目复用）

拆分核心是零依赖的 `tools/lib/dataset_core.js`（纯函数：分词/哈希/分片/meta 组装），可供任何「大文本 → 分片索引」场景复用：

```js
const core = require('./tools/lib/dataset_core.js')
core.tokenize('维生素 C')        // → ['维','生','素','C']（与引擎查询对齐）
core.hashCode('健康')            // → DJBXOR33 哈希（seed 5381）
core.parseSources(spec, files, readFile)   // 源解析（pipe5/poems/tsv 三种 preset）
core.buildArtifacts(spec, records, regionValues)  // → map/detail/block/meta 全部产物
```

## 四、校验器能抓什么（七项结构检查 + 深度比对）

`verify_dataset.js check` 逐项检查：① localId 连续性 ② meta.maps 覆盖无缝 ③ regionIdx 越界 ④ **block 桶内 id 越界（= block 过期的铁证）** ⑤ detail 列数与声明一致 ⑥ **year_index 与 map 年份交叉验证（历史集曾全量错位过）** ⑦ 与 spec 重建的**逐字节比对**。

常见事故模式（校验器都能提前发现）：
- **重编号后 block/year_index 未重建** → 搜索结果/年份搜索命中错位记录
- **改数据没递增 cache.version** → 手环清了缓存还是旧数据
- **分词与引擎不一致** → 该条目永远搜不到（交集恒空）

## 五、坑点清单（血泪教训，动手前必读）

1. **build success ≠ 产物正确**：webpack 可能因一个语法错误静默丢弃整个模块。每次构建后**解包 rpk 全目录 walk 搜索**关键字符串验证（页面依赖在 `pages/xxx/xxx.js` 而非 app.js；验证特征用**字符串字面量**——注释和函数名会被压缩剥离）。
2. **模板禁拼接类名**：`class="固定 {{变量}}"` 在手环 9 轻量运行时会导致 DOM 属性设置异常——类名必须在数据侧预拼成纯变量插值。
3. **滚动帧禁写响应式字段**：onScroll 里写非 `_` 前缀的 private 字段会每帧全量重渲染（横滑卡顿的根因）。
4. **onInit 阶段 router/file/storage 回调可能静默失效**：涉及导航/读文件的判断放 onShow；storage 回调在部分环境会丢失 → 重要判断要加**延迟 + 超时兜底 + 内存标记**三重保险。
5. **改源数据后**：必须重跑拆分 + 校验 + 递增缓存版本 + 重打 rpk，四步缺一不可。
