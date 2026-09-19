// 批量资料集生成脚本（Node）：队友 B 的 20 个 5 列文件 → 规范 v1 资料集
// 用法: node tools/build_datasets_batch.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const SRC_DIR = 'E:/vela Project/资料提取';
const OUT_DIR = 'E:/vela Project/velaPro/src/common/datasets';
const DATASET_ID_START = 3; // 0 历史 / 1 诗词 / 2 英语
const BUCKET_SIZE = 2048;
const MAP_CHUNK = 200;
const DETAIL_CHUNK = 100;

// 6 标签精简分组：每个标签产出 1 个资料集（组内多文件合并 + 均匀采样）
// 主人要求：6 个标签、资料大幅削减至 4000~6000 条（原 21 集约 6500 条过于臃肿，
// 跨 24 集聚合搜索导致处处出问题；集数=标签数后搜索只需遍历 6 个集）
const GROUPS = [
  { dir: 'health', name: '健康', files: ['jiankang', 'hufu', 'xinli', 'jijiu', 'yundong'], target: 1000 },
  { dir: 'life', name: '生活', files: ['chufang', 'jujia', 'yiwu', 'weixiu', 'chongwu', 'chuxing', 'licai', 'yinpin', "yu'er", 'jieqi', 'minsu', 'luzhi', 'zhichang'], target: 1200 },
  { dir: 'study', name: '学习', files: ['xuexi', 'shuma', 'chatgpt-baike'], target: 800 }
];

function hashCode(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) hash = (hash * 33) ^ str.charCodeAt(i);
  return hash >>> 0;
}
// 与引擎 _parseQuery 完全对齐的入桶分词（bucket key 生成规则必须与查询侧一致，否则交集为空）
// 规则：纯字母词 ≥3 → 入 3..len 的全部前缀（引擎查询按前缀哈希求交），<3 → 整词；
//       其余（中文/数字/混合/标点）→ 逐非空字符入桶
// ⚠️ 此前用 text.match(/[a-zA-Z0-9]+/) 整词入桶，与引擎的「字母前缀 + 其余逐字符」不一致，
//    导致资料集里的英文/数字关键词（如 pH 值、维生素 C、3 分钟）全部搜不到
function tokenize(text) {
  const tokens = [];
  const words = text.split(/[\s,，、]+/);
  for (const w of words) {
    if (!w) continue;
    if (/^[a-zA-Z]+$/.test(w)) {
      if (w.length >= 3) {
        for (let j = 3; j <= w.length; j++) tokens.push(w.substring(0, j).toLowerCase());
      } else {
        tokens.push(w.toLowerCase());
      }
    } else {
      for (const ch of w) {
        if (ch && ch.trim()) tokens.push(ch);
      }
    }
  }
  return [...new Set(tokens)];
}
function buildIcon(charText, bgColor, fgColor) {
  const ch = (charText || '资').charAt(0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><circle cx="128" cy="128" r="120" fill="${bgColor}"/><text x="128" y="128" font-family="sans-serif" font-size="150" font-weight="bold" fill="${fgColor}" text-anchor="middle" dominant-baseline="central">${ch}</text></svg>`;
  return new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
}

function main() {
  const results = [];
  let dsId = DATASET_ID_START;
  const colors = ['#4D9FEE', '#34A853', '#FB8C00', '#8B5CF6', '#EA4335', '#24C1E0', '#FBBC05', '#5DBB6C'];

  for (const grp of GROUPS) {
    const stem = grp.dir;
    const name = grp.name;
    const outBase = path.resolve(OUT_DIR)
    const outDir = path.resolve(outBase, stem)
    if (outDir !== outBase && !outDir.startsWith(outBase + path.sep)) { console.log('⚠️ 输出路径越界跳过:', stem); continue; }
    // 组内多文件合并（如「生活」= 厨房+居家+衣物+维修+宠物+出行+理财+饮品+育儿+节气+民俗+职场×2）
    let lines = [];
    const srcBase = path.resolve(SRC_DIR);
    for (const f of grp.files) {
      const fp = path.resolve(srcBase, f + '.txt');
      if (fp !== srcBase && !fp.startsWith(srcBase + path.sep)) continue;
      if (!fs.existsSync(fp)) { console.log('⚠️ 缺文件跳过:', f); continue; }
      const raw = fs.readFileSync(fp, 'utf-8');
      lines = lines.concat(raw.split('\n').map(l => l.trim()).filter(l => l));
    }
    const records = [];
    const catSet = new Set();

    for (const line of lines) {
      const p = line.split('|').map(x => x.trim());
      if (p.length < 5 || !p[0]) continue;
      const rec = {
        // ⚠️ localId 必须显式赋值：map/detail/block 三处都靠它写行首 ID，
        // 缺了会整片写成字面量 "undefined"（详情页按 ID 匹配整片失配 → 详情读空）
        localId: records.length,
        title: p[0].replace(/\|/g, '｜'), keywords: p[1].replace(/\|/g, '｜'),
        cause: p[2].replace(/\|/g, '｜'), impact: p[3].replace(/\|/g, '｜'), cat: p[4] || name
      };
      catSet.add(rec.cat);
      records.push(rec);
    }
    if (!records.length) { console.log('⚠️ 空组跳过:', grp.dir); continue; }

    // 精简：按内容质量（字段总长度）降序取前 N —— 主人要求「长的/信息完整的优先」。
    // 不用均匀采样：那会把小主题整片砍掉，且重要与不重要的一视同仁地削。
    if (grp.target && records.length > grp.target) {
      const lenOf = r => (r.title || '').length + (r.keywords || '').length + (r.cause || '').length + (r.impact || '').length;
      records.sort((a, b) => lenOf(b) - lenOf(a));
      records.length = grp.target;
      // 排序改变了顺序：localId 必须按新顺序重编（map/detail 行首 ID 与行序绑定）
      records.forEach((r, i) => { r.localId = i; });
      console.log(`  ${grp.dir}: ${grp.files.length} 文件合并后按内容长度取前 ${records.length} 条`);
    }

    const cats = [...catSet].sort();
    const catIdx = {}; cats.forEach((c, i) => { catIdx[c] = i; });

    // map 分片（localId|0|catIdx|标题）
    const mapFiles = [];
    for (let c = 0; c * MAP_CHUNK < records.length; c++) {
      mapFiles.push(records.slice(c * MAP_CHUNK, (c + 1) * MAP_CHUNK)
        .map(r => `${r.localId}|0|${catIdx[r.cat]}|${r.title}`).join('\n'));
    }
    // detail 分片（localId|关键词|原因背景|影响做法）
    const detailFiles = [];
    for (let c = 0; c * DETAIL_CHUNK < records.length; c++) {
      detailFiles.push(records.slice(c * DETAIL_CHUNK, (c + 1) * DETAIL_CHUNK)
        .map(r => `${r.localId}|${r.keywords}|${r.cause}|${r.impact}`).join('\n'));
    }
    // 文本 block
    const buckets = {};
    for (const r of records) {
      const kwText = [r.title, r.keywords, r.cat].filter(Boolean).join(',');
      for (const t of tokenize(kwText)) {
        const b = hashCode(t) % BUCKET_SIZE;
        (buckets[b] = buckets[b] || []).push(r.localId);
      }
    }
    const blockBody = Object.keys(buckets).map(Number).sort((a, b) => a - b)
      .map(b => `${b}|${buckets[b].join(',')}`).join('\n');

    fs.mkdirSync(outDir, { recursive: true });
    // ⚠️ 先清理旧分片：条数变少时残留的旧 map_N/detail_N 会带着旧 id 被引擎读到（数据错乱）
    for (const f of fs.readdirSync(outDir)) {
      if (/^(map|detail)_\d+\.txt$/.test(f)) fs.unlinkSync(path.join(outDir, f));
    }
    mapFiles.forEach((body, i) => fs.writeFileSync(path.join(outDir, `map_${i}.txt`), body, 'utf-8'));
    detailFiles.forEach((body, i) => fs.writeFileSync(path.join(outDir, `detail_${i}.txt`), body, 'utf-8'));
    fs.writeFileSync(path.join(outDir, 'block_0.txt'), blockBody, 'utf-8');
    fs.writeFileSync(path.join(outDir, 'icon.png'), buildIcon(name.charAt(0), colors[dsId % colors.length], '#FFFFFF'));

    const meta = {
      totalCount: records.length, regionList: cats, categoryList: [],
      bucketSize: BUCKET_SIZE,
      chunks: [{ id: 0, bucketStart: 0, bucketEnd: BUCKET_SIZE - 1, recordCount: records.length }],
      maps: mapFiles.map((_, i) => ({ startId: i * MAP_CHUNK, endId: Math.min((i + 1) * MAP_CHUNK, records.length) - 1 })),
      mapChunkSize: MAP_CHUNK, detailChunkSize: DETAIL_CHUNK, version: `${stem}-ds-1`
    };
    fs.writeFileSync(path.join(outDir, 'meta.txt'), JSON.stringify(meta), 'utf-8');
    const metaJson = {
      datasetId: dsId, name, version: 1, category: name, author: 'sudo',
      totalCount: records.length,
      fields: { map: ['title', 'year', 'category'], keyword: 'keywords', detail: ['原因/背景', '影响/做法'], filter: ['category'] },
      mapChunkSize: MAP_CHUNK, detailChunkSize: DETAIL_CHUNK, blockCount: 1, bucketSize: BUCKET_SIZE, yearIndex: false, icon: 'icon.png'
    };
    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(metaJson, null, 2), 'utf-8');

    results.push({ dsId, stem, name, count: records.length });
    dsId++;
  }

  console.log('=== 生成完成 ===');
  for (const r of results) console.log(`datasetId=${r.dsId} ${r.name}(${r.stem}): ${r.count} 条`);
  console.log('注册代码（DatasetManager.js DATASETS 追加）:');
  for (const r of results) {
    const folder = 'datasets/' + r.stem + '/';
    console.log(`  { id: ${r.dsId}, folder: '${folder}', name: '${r.name}', tag: '${r.name}', icon: '/common/${folder}icon.png' },`);
  }
}
main();
