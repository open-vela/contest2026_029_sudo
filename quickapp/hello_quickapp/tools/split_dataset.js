#!/usr/bin/env node
// split_dataset.js —— 通用资料集拆分 CLI（人类可读 spec 驱动）
// ─────────────────────────────────────────────────────────────────
// 用法:
//   node tools/split_dataset.js <spec> [--out <dir>] [--icon] [--dry]
//     <spec>   tools/specs/<name>.json 的 <name>，或任意 spec 文件路径
//     --out    覆盖 spec.outDir（相对项目根）
//     --icon   同时生成 icon.png（需 @resvg/resvg-js；默认不动现有图标）
//     --dry    只统计不写盘
//
// 产物: map_N.txt / detail_N.txt / block_0.txt / meta.txt / meta.json(按 spec)
// 拆分规则全部在 tools/lib/dataset_core.js（唯一权威实现），spec 只做声明。
//
// ⚠️ 写盘成功后的两个必做动作（数据变了缓存不认识）:
//   1. src/SearchEngine/SearchEngine.js 里 config.cache.version +1
//   2. src/manifest.json 的 versionCode/versionName 递增
'use strict'

const fs = require('fs')
const path = require('path')
const core = require('./lib/dataset_core.js')

const ROOT = path.join(__dirname, '..')

// 输入护栏：CLI 工具本地使用，参数白名单化（防静态分析误报 + 防误敲）
const SPEC_NAME_RE = /^[a-z0-9_-]+$/          // spec 名：tools/specs/<name>.json
const SPEC_PATH_RE = /^[a-zA-Z0-9_./\\:-]+$/  // 显式 spec 路径：仅合法路径字符
const OUT_OVERRIDE_RE = /^[a-zA-Z0-9_./-]+$/  // --out：相对项目根，允许合法相对段

function assertSpecName(nameOrPath) {
  if (!/[\\/]/.test(nameOrPath) && !nameOrPath.endsWith('.json')) {
    if (!SPEC_NAME_RE.test(nameOrPath)) {
      console.error('❌ spec 名不合法（^[a-z0-9_-]+$）: ' + nameOrPath)
      process.exit(1)
    }
  } else if (!SPEC_PATH_RE.test(nameOrPath)) {
    console.error('❌ spec 路径含非法字符: ' + nameOrPath)
    process.exit(1)
  }
  return nameOrPath
}

// ── IO 适配层（core 保持零依赖，方便未来在别的环境复用） ───────────
const io = {
  mkdir(dir) { fs.mkdirSync(dir, { recursive: true }) },
  listFiles(dir) { try { return fs.readdirSync(dir) } catch (e) { return [] } },
  unlink(fp) { try { fs.unlinkSync(fp) } catch (e) {} },
  write(fp, body) { fs.writeFileSync(fp, body, 'utf-8') }
}

function resolveSpec(nameOrPath) {
  const specPath = /[\\/]/.test(nameOrPath) || nameOrPath.endsWith('.json')
    ? path.resolve(assertSpecName(nameOrPath))
    : path.join(__dirname, 'specs', assertSpecName(nameOrPath) + '.json')
  if (!fs.existsSync(specPath)) {
    console.error('❌ 找不到 spec: ' + specPath)
    console.error('   可用 spec: ' + fs.readdirSync(path.join(__dirname, 'specs')).join(', '))
    process.exit(1)
  }
  return { spec: JSON.parse(fs.readFileSync(specPath, 'utf-8')), specPath }
}

function resolveSourcePath(spec, p) {
  if (path.isAbsolute(p)) {
    if (p.indexOf('..') >= 0 || p.indexOf('.') === 0) { console.error('❌ 源路径含 . 或 .. 段: ' + p); process.exit(1) }
    return p
  }
  const base = path.resolve(ROOT, spec.sourcesBase || '')
  const target = path.resolve(base, p)
  if (target !== base && !target.startsWith(base + path.sep)) {
    console.error('❌ 源路径越出工程根: ' + target)
    process.exit(1)
  }
  return target
}

function main() {
  const args = process.argv.slice(2)
  const specName = args[0]
  if (!specName || specName.startsWith('--')) {
    console.error('用法: node tools/split_dataset.js <spec> [--out <dir>] [--icon] [--dry]')
    process.exit(1)
  }
  const outOverride = args.indexOf('--out') > -1 ? args[args.indexOf('--out') + 1] : null
  if (outOverride !== null && !OUT_OVERRIDE_RE.test(outOverride)) {
    console.error('❌ --out 含非法字符（仅允许字母/数字/下划线/点/斜杠/连字符）: ' + outOverride)
    process.exit(1)
  }
  const wantIcon = args.includes('--icon')
  const dry = args.includes('--dry')

  const { spec, specPath } = resolveSpec(specName)
  console.log('═'.repeat(60))
  console.log('拆分 spec: ' + specPath)
  console.log('数据集: ' + spec.name + '（模式: ' + (spec.mode || 'fresh') + '）')

  let artifacts, recordsN
  if (spec.mode === 'existing') {
    // ── existing：从既有 map_*/detail_* 读回重建（读固定 spec.outDir；--out 只改写目标） ──
    const readBase = path.resolve(ROOT)
    const readDir = path.resolve(readBase, spec.outDir)
    if (readDir !== readBase && !readDir.startsWith(readBase + path.sep)) {
      console.error('❌ 读回目录越出工程根: ' + readDir)
      process.exit(1)
    }
    const readFile = fp => fs.readFileSync(fp, 'utf-8')
    const existsFn = fp => fs.existsSync(fp)
    console.log('读回既有数据: ' + readDir)
    const existing = core.readExisting(readDir, readFile, existsFn)
    const existingMeta = JSON.parse(readFile(path.join(readDir, 'meta.txt')))
    recordsN = existing.records.length
    console.log('读回 ' + recordsN + ' 条（map 共 ' + existing.mapCount + ' 行 / detail 共 ' + existing.detailCount + ' 行）')
    if (spec.sample && spec.sample.target && recordsN > spec.sample.target) {
      console.log('采样: ' + spec.sample.mode + ' → 前 ' + spec.sample.target + ' 条')
    }
    const sampled = core.sampleRecords(existing.records, spec.sample)
    artifacts = core.buildArtifacts(spec, sampled, [], existingMeta)
  } else {
    // ── fresh：解析源文件 → 采样 → 拆分 ──
    const files = (spec.sources || []).map(s => ({
      path: resolveSourcePath(spec, s.path),
      label: s.path,
      level: s.level
    }))
    for (const f of files) {
      if (!fs.existsSync(f.path)) {
        console.error('❌ 缺源文件: ' + f.path)
        process.exit(1)
      }
    }
    const readFile = fp => fs.readFileSync(fp, 'utf-8')
    const parsed = core.parseSources(spec, files, readFile)
    recordsN = parsed.records.length
    console.log('源解析: ' + recordsN + ' 条（丢弃: 短行 ' + parsed.dropped.shortLine
      + ' 空标题 ' + parsed.dropped.emptyTitle + ' 重复 ' + parsed.dropped.dedupe + '）')
    if (parsed.regionValues.length) {
      console.log('分类收集（采样前全量）: ' + parsed.regionValues.length + ' 个')
    }
    const sampled = core.sampleRecords(parsed.records, spec.sample)
    if (sampled.length !== recordsN) console.log('采样后: ' + sampled.length + ' 条（重编号 0..' + (sampled.length - 1) + '）')
    artifacts = core.buildArtifacts(spec, sampled, parsed.regionValues, null)
  }

  // ── 统计输出 ──
  const st = artifacts.stats
  console.log('─'.repeat(60))
  console.log('拆分结果: ' + st.records + ' 条 → ' + st.mapFiles + ' 个 map 片 + '
    + st.detailFiles + ' 个 detail 片, ' + st.buckets + ' 个桶')
  console.log('regionList(' + artifacts.regionList.length + '): ' + artifacts.regionList.join('、'))

  if (dry) {
    console.log('（--dry 未写盘）')
    return
  }

  const outBase = path.resolve(ROOT)
  const outDir = path.resolve(outBase, outOverride || spec.outDir)
  if (outDir !== outBase && !outDir.startsWith(outBase + path.sep)) {
    console.error('❌ 输出目录越出工程根: ' + outDir)
    process.exit(1)
  }
  core.writeDataset(outDir, artifacts, io)
  console.log('✅ 已写入: ' + outDir)
  if (wantIcon && spec.icon) {
    try {
      const { Resvg } = require('@resvg/resvg-js')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
        + '<circle cx="128" cy="128" r="120" fill="' + spec.icon.bg + '"/>'
        + '<text x="128" y="128" font-family="sans-serif" font-size="150" font-weight="bold" fill="' + spec.icon.fg
        + '" text-anchor="middle" dominant-baseline="central">' + spec.icon.char + '</text></svg>'
      fs.writeFileSync(path.join(outDir, 'icon.png'), new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng())
      console.log('✅ 图标已生成: icon.png')
    } catch (e) {
      console.error('⚠️ 图标生成失败（不影响资料）: ' + e.message)
    }
  }

  console.log('─'.repeat(60))
  console.log('📌 后续必做:')
  console.log('   1. SearchEngine.js config.cache.version 递增（否则手环命中旧缓存）')
  console.log('   2. manifest.json versionName/versionCode 递增')
  console.log('   3. node tools/verify_dataset.js check ' + path.relative(ROOT, outDir) + ' '
    + path.basename(specPath, '.json') + '   ← 深度自检')
}

main()
