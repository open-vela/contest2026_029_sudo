// 英语集 CET-4/CET-6 词表替换（合并去重）
// 来源: KyleBing/english-vocabulary 仓库的「四级-乱序.txt」+「六级-乱序.txt」
// 格式: 单词\t词性. 释义（tab 分隔）
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const OUT = path.join(__dirname, '..', 'src', 'common', 'datasets', 'english');
const BUCKET = 2048;

// 与引擎 _parseQuery 对齐的英文分词（≥3 字母入全部前缀，短词整词）
function tokenize(word) {
  const lower = word.toLowerCase();
  const tokens = [];
  if (lower.length >= 3) { for (let i = 3; i <= lower.length; i++) tokens.push(lower.slice(0, i)); }
  else tokens.push(lower);
  return [...new Set(tokens)];
}
function hashCode(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i); return h >>> 0; }
function buildIcon(ch, bg, fg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><circle cx="128" cy="128" r="120" fill="${bg}"/><text x="128" y="128" font-family="sans-serif" font-size="150" font-weight="bold" fill="${fg}" text-anchor="middle" dominant-baseline="central">${ch}</text></svg>`;
  return new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
}

// CET4 + CET6 合并去重
const seen = new Set();
const records = [];
const levels = ['四级', '六级'];

for (const [file, level] of [['cet4_raw.txt', '四级'], ['cet6_raw.txt', '六级']]) {
  const base = path.resolve(__dirname, '..');
  const fp = path.resolve(base, file);
  if (fp !== base && !fp.startsWith(base + path.sep)) continue;
  const raw = fs.readFileSync(fp, 'utf-8');
  for (const line of raw.split('\n')) {
    const p = line.split('\t');
    if (p.length < 2 || !p[0].trim()) continue;
    const word = p[0].trim().toLowerCase();
    if (seen.has(word)) continue;
    seen.add(word);
    records.push({ localId: 0, word, level, meaning: p[1].trim().replace(/\|/g, '｜') });
  }
}
// 精简：CET 词表按序保留前 800 条（前部是高频基础词，均匀采样反而会丢掉常用词）
const EN_TARGET = 750;
if (records.length > EN_TARGET) {
  records.length = EN_TARGET;
  console.log('英语集精简至前 ' + EN_TARGET + ' 条');
}
// 重编号
records.forEach((r, i) => { r.localId = i; });
const levelIdx = {}; levels.forEach((l, i) => { levelIdx[l] = i; });

// map 分片（localId|0|levelIdx|单词）
const mapFiles = [];
for (let c = 0; c * 200 < records.length; c++) {
  mapFiles.push(records.slice(c * 200, (c + 1) * 200).map(r => `${r.localId}|0|${levelIdx[r.level] || 0}|${r.word}`).join('\n'));
}
// detail 分片（localId|关键词|释义）
const detailFiles = [];
for (let c = 0; c * 100 < records.length; c++) {
  detailFiles.push(records.slice(c * 100, (c + 1) * 100).map(r => `${r.localId}|${r.word},${r.level}|${r.meaning}`).join('\n'));
}
// 文本 block
const buckets = {};
for (const r of records) {
  for (const t of tokenize(r.word)) {
    const b = hashCode(t) % 2048;
    (buckets[b] = buckets[b] || []).push(r.localId);
  }
}
const blockBody = Object.keys(buckets).map(Number).sort((a, b) => a - b).map(b => `${b}|${buckets[b].join(',')}`).join('\n');

// 写文件
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
mapFiles.forEach((b, i) => fs.writeFileSync(path.join(OUT, `map_${i}.txt`), b, 'utf-8'));
detailFiles.forEach((b, i) => fs.writeFileSync(path.join(OUT, `detail_${i}.txt`), b, 'utf-8'));
fs.writeFileSync(path.join(OUT, 'block_0.txt'), blockBody, 'utf-8');
fs.writeFileSync(path.join(OUT, 'icon.png'), buildIcon('英', '#5DBB6C', '#FFFFFF'));

const meta = {
  totalCount: records.length, regionList: levels, categoryList: [],
  bucketSize: BUCKET,
  chunks: [{ id: 0, bucketStart: 0, bucketEnd: BUCKET - 1, recordCount: records.length }],
  maps: mapFiles.map((_, i) => ({ startId: i * 200, endId: Math.min((i + 1) * 200, records.length) - 1 })),
  mapChunkSize: 200, detailChunkSize: 100, version: 'english-cet-2'
};
fs.writeFileSync(path.join(OUT, 'meta.txt'), JSON.stringify(meta), 'utf-8');
const metaJson = {
  datasetId: 2, name: '英语集', version: 2, category: '英语', author: 'sudo',
  totalCount: records.length,
  fields: { map: ['title', 'year', 'category'], keyword: 'keywords', detail: ['释义'], filter: ['category'] },
  mapChunkSize: 200, detailChunkSize: 100, blockCount: 1, bucketSize: BUCKET, yearIndex: false, icon: 'icon.png'
};
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(metaJson, null, 2), 'utf-8');
console.log('英语集 CET 替换完成:', records.length, '条,', mapFiles.length, 'map 片,', detailFiles.length, 'detail 片,', '去重后');
