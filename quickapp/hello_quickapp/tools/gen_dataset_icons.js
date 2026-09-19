#!/usr/bin/env node
// gen_dataset_icons.js —— 资料集图形图标生成（v1.16.42 主人要求：图标不用文字）
// 用法: node tools/gen_dataset_icons.js
// 产出: src/common/datasets/{poems,english,health,life,study,bt}/icon.png（128x128，圆底+白色线条图形——v1.16.48 从 256 缩至 128：显示尺寸 33~55px，减小滚动重绘解码开销）
// 历史集沿用 /common/logo.png + icons/history.png（书本图形，本就是图形化），不在本脚本范围
// 图标不参与搜索缓存，替换后无需递增 SearchEngine cache.version，但需重打 rpk
'use strict'

const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')

// 白色线条风格公共参数
const S = 'stroke="#FFFFFF" fill="none" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"'
const S9 = 'stroke="#FFFFFF" fill="none" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"'

// 各集图形（256 画布，圆底 r=120）
const ICONS = {
  // 诗词：展开的卷轴（两侧卷筒 + 纸面竖纹）
  poems: `
  <rect x="74" y="64" width="108" height="128" ${S}/>
  <rect x="46" y="54" width="24" height="148" rx="12" fill="#FFFFFF"/>
  <rect x="186" y="54" width="24" height="148" rx="12" fill="#FFFFFF"/>
  <line x1="106" y1="92" x2="106" y2="164" ${S9}/>
  <line x1="128" y1="92" x2="128" y2="164" ${S9}/>
  <line x1="150" y1="92" x2="150" y2="164" ${S9}/>`,
  // 英语：地球经纬线（语言/世界）
  english: `
  <circle cx="128" cy="128" r="74" ${S}/>
  <line x1="54" y1="128" x2="202" y2="128" ${S9}/>
  <path d="M64 98 Q128 78 192 98" ${S9}/>
  <path d="M64 158 Q128 178 192 158" ${S9}/>
  <ellipse cx="128" cy="128" rx="32" ry="74" ${S9}/>`,
  // 健康：心形 + 心电图折线
  health: `
  <path d="M128 198 C58 152 50 106 78 82 C100 64 122 74 128 96 C134 74 156 64 178 82 C206 106 198 152 128 198 Z" ${S}/>
  <polyline points="66,132 100,132 112,108 128,152 140,122 148,132 190,132" fill="none" stroke="#FFFFFF" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`,
  // 生活：小房子（屋顶 + 房身 + 门）
  life: `
  <polyline points="56,130 128,62 200,130" fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="76" y="126" width="104" height="74" ${S}/>
  <rect x="112" y="154" width="32" height="46" fill="#FFFFFF"/>`,
  // 蓝牙动态集：下载箭头入托盘（蓝牙传输的资料统一用此图标）
  bt: `
  <line x1="128" y1="54" x2="128" y2="118" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round"/>
  <polyline points="96,88 128,120 160,88" fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M60 140 L60 178 Q128 208 196 178 L196 140" fill="none" stroke="#FFFFFF" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="128" y1="186" x2="128" y2="160" stroke="#FFFFFF" stroke-width="11" stroke-linecap="round"/>`,
  // 学习：学士帽（菱形帽面 + 帽基 + 垂穗）
  study: `
  <polygon points="128,58 212,98 128,138 44,98" fill="#FFFFFF"/>
  <path d="M84 118 L84 146 Q128 172 172 146 L172 118" ${S}/>
  <line x1="212" y1="98" x2="212" y2="146" ${S9}/>
  <circle cx="212" cy="156" r="9" fill="#FFFFFF"/>`
}

// 底色沿用各集现行 icon.png 的颜色（首页入口色系一致）
const DATASETS = [
  { stem: 'poems', char: '诗词', bg: '#4D9FEE' },
  { stem: 'english', bg: '#5DBB6C' },
  { stem: 'health', bg: '#8B5CF6' },
  { stem: 'life', bg: '#EA4335' },
  { stem: 'study', bg: '#24C1E0' },
  { stem: 'bt', bg: '#3D7BFF' }
]

function renderIconSvg(stem, bg) {
  // v1.16.49：输出【透明底 + 白色图形】（与 icons/history.png 同款，显示路径已验证正常）——
  // 底色圆由页面 CSS colorClass（ci-*）绘制；图内自带彩底在轻量运行时上渲染异常（实测）
  return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' + ICONS[stem] + '</svg>'
}

function main() {
  const base = path.join(__dirname, '..', 'src', 'common', 'datasets')
  for (const ds of DATASETS) {
    const png = new Resvg(renderIconSvg(ds.stem, ds.bg), { fitTo: { mode: 'width', value: 64 } }).render().asPng()
    const out = path.join(base, ds.stem, 'icon.png')
    fs.writeFileSync(out, png)
    console.log('✅', ds.stem.padEnd(8), png.length + 'B ->', path.relative(process.cwd(), out))
  }
  console.log('完成。注意: icon 变更需重打 rpk（资源变更），无需递增 cache.version')
}

module.exports = { ICONS, DATASETS, renderIconSvg }
if (require.main === module) main()
