// 历史集精简：按内容长度降序取前 N 条，重建 map/detail/文本 block/meta
// 背景：历史集原为二进制 BLOK 块（9 片）且分片参数 600/150，与其它集（文本块）不同构；
//      本脚本统一为文本块（与引擎 _parseQuery 对齐），并按内容质量削减条目数。
// 主人要求：按「长的/信息完整的优先」保留，总量压到 4000~6000。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'common');
const TARGET = 850;          // 历史集保留条数
const MAP_CHUNK = 600;
const DETAIL_CHUNK = 150;
const BUCKET_SIZE = 4096;

function hashCode(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return h >>> 0;
}
// 与引擎 _parseQuery 完全对齐的入桶分词
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
      for (const ch of w) if (ch && ch.trim()) tokens.push(ch);
    }
  }
  return [...new Set(tokens)];
}

function readChunks(prefix) {
  const base = path.resolve(DIR);
  const out = [];
  for (let i = 0; ; i++) {
    const fp = path.resolve(base, prefix + '_' + i + '.txt');
    if (fp !== base && !fp.startsWith(base + path.sep)) break;
    if (!fs.existsSync(fp)) break;
    out.push(...fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim()));
  }
  return out;
}

const mapLines = readChunks('map');
const detailLines = readChunks('detail');
console.log('原数据: map ' + mapLines.length + ' 行, detail ' + detailLines.length + ' 行');

const mapById = new Map();
for (const l of mapLines) { const c = l.split('|'); mapById.set(parseInt(c[0], 10), c); }
const detailById = new Map();
for (const l of detailLines) { const c = l.split('|'); detailById.set(parseInt(c[0], 10), c); }

// 按 detail 内容（关键词+原因+影响）长度降序
const ids = [...detailById.keys()].filter(id => mapById.has(id));
ids.sort((a, b) => detailById.get(b).slice(1).join('').length - detailById.get(a).slice(1).join('').length);
// 取前 TARGET 后按原 id 升序（保持时间线顺序，便于年份搜索）
const kept = ids.slice(0, TARGET).sort((a, b) => a - b);
console.log('保留 ' + kept.length + ' 条（按内容长度优先）');

const newMap = [], newDetail = [];
kept.forEach((oldId, i) => {
  const m = mapById.get(oldId).slice(); m[0] = String(i); newMap.push(m.join('|'));
  const d = detailById.get(oldId).slice(); d[0] = String(i); newDetail.push(d.join('|'));
});

// 删旧分片后重写
for (let i = 0; ; i++) { const fp = path.join(DIR, 'map_' + i + '.txt'); if (!fs.existsSync(fp)) break; fs.unlinkSync(fp); }
for (let i = 0; ; i++) { const fp = path.join(DIR, 'detail_' + i + '.txt'); if (!fs.existsSync(fp)) break; fs.unlinkSync(fp); }
let n = 0;
for (let c = 0; c * MAP_CHUNK < newMap.length; c++) {
  fs.writeFileSync(path.join(DIR, 'map_' + (n++) + '.txt'), newMap.slice(c * MAP_CHUNK, (c + 1) * MAP_CHUNK).join('\n'), 'utf-8');
}
n = 0;
for (let c = 0; c * DETAIL_CHUNK < newDetail.length; c++) {
  fs.writeFileSync(path.join(DIR, 'detail_' + (n++) + '.txt'), newDetail.slice(c * DETAIL_CHUNK, (c + 1) * DETAIL_CHUNK).join('\n'), 'utf-8');
}

// 重建文本 block（入桶文本 = 标题 + 关键词）
const buckets = {};
newMap.forEach(line => {
  const c = line.split('|');
  const id = parseInt(c[0], 10);
  const title = c[3] || '';
  const d = newDetail[id] ? newDetail[id].split('|') : [];
  for (const t of tokenize(title + ',' + (d[1] || ''))) {
    const b = hashCode(t) % BUCKET_SIZE;
    (buckets[b] = buckets[b] || []).push(id);
  }
});
const blockBody = Object.keys(buckets).map(Number).sort((a, b) => a - b)
  .map(b => b + '|' + buckets[b].join(',')).join('\n');
for (let i = 0; ; i++) { const fp = path.join(DIR, 'block_' + i + '.txt'); if (!fs.existsSync(fp)) break; fs.unlinkSync(fp); }
fs.writeFileSync(path.join(DIR, 'block_0.txt'), blockBody, 'utf-8');

// 更新 meta（保留 regionList/categoryList 等原有字段，只改容量相关项）
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.txt'), 'utf-8'));
meta.totalCount = newMap.length;
meta.bucketSize = BUCKET_SIZE;
meta.chunks = [{ id: 0, bucketStart: 0, bucketEnd: BUCKET_SIZE - 1, recordCount: newMap.length }];
delete meta.blockBinary;      // 改用文本块（引擎侧 blockBinary.enabled 本就为 false）
meta.mapChunkSize = MAP_CHUNK;
meta.detailChunkSize = DETAIL_CHUNK;
const mapFileCount = Math.ceil(newMap.length / MAP_CHUNK);
meta.maps = [];
for (let i = 0; i < mapFileCount; i++) {
  meta.maps.push({
    id: i, startId: i * MAP_CHUNK,
    endId: Math.min((i + 1) * MAP_CHUNK, newMap.length) - 1,
    recordCount: Math.min((i + 1) * MAP_CHUNK, newMap.length) - i * MAP_CHUNK
  });
}
fs.writeFileSync(path.join(DIR, 'meta.txt'), JSON.stringify(meta), 'utf-8');

console.log('历史集精简完成: ' + newMap.length + ' 条, ' + mapFileCount + ' 个 map 片, block 桶数 ' + Object.keys(buckets).length);
