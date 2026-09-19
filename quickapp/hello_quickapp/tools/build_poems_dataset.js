// 诗集资料集生成脚本（Node 端运行）
// 用法: node tools/build_poems_dataset.js
// 输入: 资料/poems_10000条_cleaned (1).txt  行格式: ID|标题|作者|朝代|出处|内容
// 输出: src/common/datasets/poems/  （规范 v1 资料集：meta.json + v4 引擎物化视图）
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

// 资料集图标生成：圆底 + 集名首字（规范 v1：每个资料包自带 icon.png）
function buildDatasetIcon(charText, bgColor, fgColor) {
  const ch = (charText || '资').charAt(0);
  const fontSize = 150;
  const cx = 128;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <circle cx="${cx}" cy="128" r="120" fill="${bgColor}"/>
  <text x="${cx}" y="128" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" fill="${fgColor}" text-anchor="middle" dominant-baseline="central">${ch}</text>
</svg>`;
  return new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
}

const SRC = path.join(__dirname, '..', '..', '资料', 'poems_10000条_cleaned (1).txt');
const OUT = path.join(__dirname, '..', 'src', 'common', 'datasets', 'poems');
const DATASET_ID = 1;
const BUCKET_SIZE = 2048;
const MAP_CHUNK = 200;
const DETAIL_CHUNK = 100;

// 与引擎完全一致的哈希（DJBXOR）
function hashCode(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

// 与引擎 _parseQuery 对齐的入桶分词（bucket key 生成规则必须与查询侧完全一致，否则交集为空）
function tokenize(text) {
  const tokens = [];
  // \u7eaf\u5b57\u6bcd\u8bcd \u22653 \u5165\u6876\u5168\u90e8\u524d\u7f00(3..len)\u5c0f\u5199\uff08\u5f15\u64ce\u67e5\u8be2\u6309\u524d\u7f00\u54c8\u5e0c\u6c42\u4ea4\uff09\uff0c<3 \u6574\u8bcd\uff1b
  // \u5176\u4f59\uff08\u4e2d\u6587/\u6570\u5b57/\u6df7\u5408/\u6807\u70b9\uff09\u9010\u975e\u7a7a\u5b57\u7b26\u5165\u6876\uff08\u5f15\u64ce\u5bf9\u975e\u7eaf\u5b57\u6bcd\u8bcd\u9010\u5b57\u54c8\u5e0c\uff09
  const words = text.split(/[\s,\uff0c\u3001]+/);
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

function main() {
  const raw = fs.readFileSync(SRC, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const records = [];
  const dynastySet = new Set();

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 6) continue;
    const [, title, author, dynasty, source, content] = parts.map(p => p.trim().replace(/\|/g, '｜'));
    if (!title) continue;
    dynastySet.add(dynasty || '未知');
    records.push({ title, author, dynasty: dynasty || '未知', source, content });
  }

  const dynasties = [...dynastySet].sort();
  const regionIndex = {};
  dynasties.forEach((d, i) => { regionIndex[d] = i; });

  // 精简：按正文长度降序取前 800（主人要求「长的/信息完整的优先」）
  const POEMS_TARGET = 550;
  if (records.length > POEMS_TARGET) {
    records.sort((a, b) => ((b.content || '').length) - ((a.content || '').length));
    records.length = POEMS_TARGET;
    console.log('诗集精简（按正文长度取前 ' + records.length + ' 条）');
  }
  // 重编号 localId 0..N-1
  records.forEach((r, i) => { r.localId = i; });

  // ---- map 分片（v4 引擎格式: localId|year(0)|regionId(朝代idx)|title(标题·作者)）----
  const mapFiles = [];
  for (let c = 0; c * MAP_CHUNK < records.length; c++) {
    const seg = records.slice(c * MAP_CHUNK, (c + 1) * MAP_CHUNK);
    const body = seg.map(r => `${r.localId}|0|${regionIndex[r.dynasty]}|${r.title}·${r.author}`).join('\n');
    mapFiles.push(body);
  }

  // ---- detail 分片（v4 格式: localId|keywords|cause(出处)|impact(内容)）----
  const detailFiles = [];
  for (let c = 0; c * DETAIL_CHUNK < records.length; c++) {
    const seg = records.slice(c * DETAIL_CHUNK, (c + 1) * DETAIL_CHUNK);
    const body = seg.map(r => {
      const kw = [r.title, r.author, r.dynasty, r.source].filter(Boolean).join(',');
      const content = (r.content || '').replace(/\r?\n/g, '\\n');
      return `${r.localId}|${kw}|${r.source || ''}|${content}`;
    }).join('\n');
    detailFiles.push(body);
  }

  // ---- 文本 block（bucketIdx|id1,id2,...）——关键词逐 token 入桶 ----
  const buckets = {};
  for (const r of records) {
    const kwText = [r.title, r.author, r.dynasty, r.source].filter(Boolean).join(',');
    for (const token of tokenize(kwText)) {
      const b = hashCode(token) % BUCKET_SIZE;
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(r.localId);
    }
  }
  const blockBody = Object.keys(buckets)
    .map(Number).sort((a, b) => a - b)
    .map(b => `${b}|${buckets[b].join(',')}`)
    .join('\n');

  // ---- 写文件 ----
  fs.mkdirSync(OUT, { recursive: true });
  // ⚠️ 先清理旧分片：条数变少时残留的旧 map_N/detail_N 会带着旧 id 被引擎读到（数据错乱）
  for (const f of fs.readdirSync(OUT)) {
    if (/^(map|detail)_\d+\.txt$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  }
  mapFiles.forEach((body, i) => fs.writeFileSync(path.join(OUT, `map_${i}.txt`), body, 'utf-8'));
  detailFiles.forEach((body, i) => fs.writeFileSync(path.join(OUT, `detail_${i}.txt`), body, 'utf-8'));
  fs.writeFileSync(path.join(OUT, 'block_0.txt'), blockBody, 'utf-8');

  // ---- icon.png（资料集图标：圆底 + 集名首字）----
  fs.writeFileSync(path.join(OUT, 'icon.png'), buildDatasetIcon('诗', '#4D9FEE', '#FFFFFF'));

  // ---- meta.txt（v4 引擎物化视图）----
  const meta = {
    totalCount: records.length,
    regionList: dynasties,
    categoryList: [],
    bucketSize: BUCKET_SIZE,
    chunks: [{ id: 0, bucketStart: 0, bucketEnd: BUCKET_SIZE - 1, recordCount: records.length }],
    maps: mapFiles.map((_, i) => ({
      startId: i * MAP_CHUNK,
      endId: Math.min((i + 1) * MAP_CHUNK, records.length) - 1
    })),
    mapChunkSize: MAP_CHUNK,
    detailChunkSize: DETAIL_CHUNK,
    version: 'poems-ds-1'
  };
  fs.writeFileSync(path.join(OUT, 'meta.txt'), JSON.stringify(meta), 'utf-8');

  // ---- meta.json（规范 v1 自描述）----
  const metaJson = {
    datasetId: DATASET_ID,
    name: '诗词集',
    version: 1,
    category: '文化',
    author: 'sudo',
    totalCount: records.length,
    fields: {
      map: ['title', 'year', 'dynasty'],
      keyword: 'keywords',
      detail: ['source', 'content'],
      filter: ['dynasty']
    },
    mapChunkSize: MAP_CHUNK,
    detailChunkSize: DETAIL_CHUNK,
    blockCount: 1,
    bucketSize: BUCKET_SIZE,
    yearIndex: false,
    icon: 'icon.png'
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(metaJson, null, 2), 'utf-8');

  console.log(`诗词资料集生成完成: ${records.length} 条, ${mapFiles.length} 个 map 片, ${detailFiles.length} 个 detail 片, ${dynasties.length} 个朝代`);
  console.log('输出目录:', OUT);
}

main();
