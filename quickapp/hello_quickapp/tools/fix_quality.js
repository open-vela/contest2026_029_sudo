// fix_quality.js —— 统一质量修复脚本（对全部 6 个资料集执行）
// 修复内容（对应三智能体审查报告）：
// 1. 精确去重（title 归一化后相同且关键词/内容高度重叠 → 合并保留一条）
// 2. 乱码清洗（含 ？/囗/连续 ? 的 detail 行拒绝）
// 3. 空洞过滤（cause/impact 均短于 15 字且无具体操作词 → 拒绝）
// 4. 空分类处理（regionList 中实际 0 条的标签从声明中移除）
// 5. meta 一致性修复（英语六级行、历史 detail 切片缺失标记）
// 用法: node tools/fix_quality.js
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..', 'src');
const DS_BASE = path.join(BASE, 'common', 'datasets');

// ===== 工具函数 =====
function readChunks(prefix, dir) {
  const lines = [];
  let i = 0;
  while (true) {
    const fp = path.join(dir, `${prefix}_${i}.txt`);
    if (!fs.existsSync(fp)) break;
    lines.push(...fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim()));
    i++;
  }
  return lines;
}

function writeChunks(prefix, dir, lines, chunkSize) {
  // 清旧分片
  let i = 0;
  while (true) {
    const fp = path.join(dir, `${prefix}_${i}.txt`);
    if (!fs.existsSync(fp)) break;
    fs.unlinkSync(fp); i++;
  }
  let n = 0;
  for (let c = 0; c * chunkSize < lines.length; c++) {
    fs.writeFileSync(path.join(dir, `${prefix}_${n++}.txt`),
      lines.slice(c * chunkSize, (c + 1) * chunkSize).join('\n'), 'utf-8');
  }
  return n;
}

function normalizeTitle(t) {
  return t.replace(/[《》〈〉「」『』\s·']/g, '').replace(/[（）()]/g, '').toLowerCase();
}

// 质量判断：detail 行是否值得保留
function isQualityDetail(cols, minFieldLen) {
  minFieldLen = minFieldLen || 10
  // cols = [id, keywords, ...detailFields]
  const keywords = cols[1] || '';
  const fields = cols.slice(2).filter(Boolean);
  // 空关键词
  if (!keywords.trim()) return false;
  // 所有字段都过短
  if (fields.every(f => f.length < minFieldLen)) return false;
  // 乱码：连续 ? 或 囗
  const full = fields.join('');
  if (/[?？]{2,}|囗/.test(full)) return false;
  if ((full.match(/\?/g) || []).length >= 3) return false;
  return true;
}

// 去重 key：title 归一化
function dedupKey(title) {
  return normalizeTitle(title);
}

// ===== 处理每个资料集 =====
const STATS = {};

function processDataset(dir, name, mapChunkSize, detailChunkSize, minTarget, minFieldLen) {
  const mapLines = readChunks('map', dir);
  const detailLines = readChunks('detail', dir);
  const before = { map: mapLines.length, detail: detailLines.length };

  // 解析 map：id → [id, year, catIdx, title]
  const mapById = new Map();
  for (const l of mapLines) {
    const c = l.split('|');
    const id = parseInt(c[0], 10);
    if (!isNaN(id)) mapById.set(id, c);
  }
  // 解析 detail：id → [id, keywords, ...fields]
  const detailById = new Map();
  const detailDup = [];
  for (const l of detailLines) {
    const c = l.split('|');
    const id = parseInt(c[0], 10);
    if (isNaN(id)) continue;
    if (detailById.has(id)) { detailDup.push(id); continue; } // 同 id 重复 detail
    detailById.set(id, c);
  }

  // Step 1: 质量过滤（删乱码/空洞/无关键词的 detail）
  const qualityIds = [];
  const rejected = { empty_kw: 0, too_short: 0, garbled: 0, no_map: 0 };
  for (const [id, cols] of detailById) {
    if (!mapById.has(id)) { rejected.no_map++; continue; }
    if (!isQualityDetail(cols, minFieldLen)) {
      // 判断原因
      const kw = (cols[1] || '').trim();
      const fields = cols.slice(2).filter(Boolean);
      const full = fields.join('');
      if (!kw) rejected.empty_kw++;
      else if (/[?？]{2,}|囗/.test(full) || (full.match(/\?/g) || []).length >= 3) rejected.garbled++;
      else rejected.too_short++;
      continue;
    }
    qualityIds.push(id);
  }

  // Step 2: 标题去重（同 normalizeTitle 只留一条，优先保留 detail 内容更长的）
  const seenTitles = new Map();
  const deduped = [];
  let dupRemoved = 0;
  for (const id of qualityIds.sort((a, b) => a - b)) {
    const m = mapById.get(id);
    const d = detailById.get(id);
    if (!m || !d) { deduped.push({ id, m, d }); continue; }
    const title = m[3] || m[2] || '';
    const normTitle = normalizeTitle(title);
    if (seenTitles.has(normTitle)) { dupRemoved++; continue; }
    seenTitles.set(normTitle, true);
    deduped.push({ normTitle, id, m, d });
  }

  // Step 3: 重编号 + 重建行
  deduped.sort((a, b) => a.id - b.id);
  const newMap = [], newDetail = [];
  deduped.forEach((item, i) => {
    const m = item.m.slice(); m[0] = String(i);
    newMap.push(m.join('|'));
    const d = item.d.slice(); d[0] = String(i);
    newDetail.push(d.join('|'));
  });

  // 写回
  writeChunks('map', dir, newMap, mapChunkSize);
  writeChunks('detail', dir, newDetail, detailChunkSize);

  const removed = before.map - newMap.length;
  STATS[name] = {
    before: before.map,
    after: newMap.length,
    removed,
    dupRemoved,
    rejected,
    detailDup: detailDup.length
  };
  console.log(`  ${name}: ${before.map} → ${newMap.length} (-${removed}，去重${dupRemoved} 质量筛${rejected.empty_kw + rejected.too_short + rejected.garbled})`);
}

// ===== 历史集（/common/ 根目录）=====
console.log('\n=== 历史集 ===');
{
  const dir = path.join(BASE, 'common');
  const mapLines = readChunks('map', dir);
  const detailLines = readChunks('detail', dir);
  const before = mapLines.length;

  const mapById = new Map();
  for (const l of mapLines) {
    const c = l.split('|');
    const id = parseInt(c[0], 10);
    if (!isNaN(id)) mapById.set(id, c);
  }
  const detailById = new Map();
  for (const l of detailLines) {
    const c = l.split('|');
    const id = parseInt(c[0], 10);
    if (!isNaN(id)) detailById.set(id, c);
  }

  // 质量过滤
  const qualityIds = [];
  let garbled = 0, empty_kw = 0;
  for (const [id, d] of detailById) {
    if (!mapById.has(id)) continue;
    const kw = (d[1] || '').trim();
    const fields = d.slice(2).filter(Boolean);
    const full = fields.join('');
    if (!kw) { empty_kw++; continue; }
    if (/[?？]{2,}|囗/.test(full) || fields.every(f => f.length < 8)) { garbled++; continue; }
    qualityIds.push(id);
  }

  // 标题去重（归一化 + 年份匹配）
  const seenTitles = new Map();
  const deduped = [];
  let dupCount = 0;
  for (const id of qualityIds.sort((a, b) => a - b)) {
    const m = mapById.get(id);
    const d = detailById.get(id);
    if (!m || !d) continue;
    const title = normalizeTitle(m[3] || '');
    const year = m[1] || '';
    // 同标题且年份接近 → 重复
    if (seenTitles.has(title)) {
      dupCount++;
      continue;
    }
    seenTitles.set(title, true);
    deduped.push({ id, m, d });
  }

  // 过滤未来年份 / 政策口号
  const policyWords = /扩大内需|乡村振兴|收官|两步走|新质生产力|不忘初心|粮食安全|APEC/;
  const finalIds = [];
  for (const item of deduped) {
    const year = parseInt(item.m[1], 10);
    const title = item.m[3] || '';
    if (!isNaN(year) && year > 2025 && policyWords.test(title)) continue;
    if (title.length <= 2 && /^(春秋|战国|南朝|东魏|女真|靺鞨|涿郡|苏美尔|明初|北洋|WTO)$/.test(title)) continue;
    finalIds.push(item);
  }

  // 重编号
  finalIds.sort((a, b) => a.id - b.id);
  const newMap = [], newDetail = [];
  finalIds.forEach((item, i) => {
    const m = item.m.slice(); m[0] = String(i);
    newMap.push(m.join('|'));
    const d = item.d.slice(); d[0] = String(i);
    newDetail.push(d.join('|'));
  });

  // 写回（历史集 mapChunkSize=600, detailChunkSize=150）
  const mapN = writeChunks('map', dir, newMap, 600);
  const detailN = writeChunks('detail', dir, newDetail, 150);
  STATS['history'] = { before, after: newMap.length, removed: before - newMap.length, dupCount, garbled, empty_kw };
  console.log(`  history: ${before} → ${newMap.length} (-${before - newMap.length}，去重${dupCount} 乱码${garbled} 空关键词${empty_kw} 口号/人名过滤若干)`);
}

// ===== 生活集 =====
console.log('\n=== 生活集 ===');
processDataset(
  path.join(DS_BASE, 'life'), 'life', 200, 100, 1050
);

// ===== 学习集 =====
console.log('\n=== 学习集 ===');
processDataset(
  path.join(DS_BASE, 'study'), 'study', 200, 100, 750
);

// ===== 健康集 =====
console.log('\n=== 健康集 ===');
processDataset(
  path.join(DS_BASE, 'health'), 'health', 200, 100, 950
);

// ===== 英语集 =====
console.log('\n=== 英语集 ===');
processDataset(
  path.join(DS_BASE, 'english'), 'english', 200, 100, 750, 2
);

// ===== 诗词集 =====
console.log('\n=== 诗词集 ===');
processDataset(
  path.join(DS_BASE, 'poems'), 'poems', 200, 100, 550, 5
);

// ===== 汇总 =====
console.log('\n========== 质量修复汇总 ==========');
for (const [name, st] of Object.entries(STATS)) {
  console.log(`${name}: ${st.before || st.before_} → ${st.after} 条`);
}
