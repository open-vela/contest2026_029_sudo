#!/usr/bin/env node
// gen_bluetooth_icon.js —— 「蓝牙未连接」图标（v1.16.56 第 10 版终版）
// 主人：「不需要斜杠……正常红色蓝牙 + 透明红色背景」，且指出前版「留空的地方被填实」——
// 本版用 Feather/标准图标库的蓝牙 polyline（单条折线，两翼三角自然留空，行业标准形状）：
//   24 系坐标 points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"
'use strict'

const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')

const BG = 'rgba(229,57,53,0.35)'   // 透明红色背景
const FG = '#E53935'                // 正常红色蓝牙符号

// Feather 蓝牙 polyline（24x24，stroke 描边=两翼内部留空）
const POLY = '6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <circle cx="128" cy="128" r="120" fill="${BG}"/>
  <g transform="translate(24.8,24.8) scale(8.6)" fill="none" stroke="${FG}" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round">
    <polyline points="${POLY}"/>
  </g>
</svg>`

const png = new Resvg(svg, { fitTo: { mode: 'width', value: 128 } }).render().asPng()
const out = path.join(__dirname, '..', 'src', 'common', 'icons', 'bluetooth_off.png')
fs.writeFileSync(out, png)
console.log('✅ bluetooth_off.png 终版（' + png.length + 'B，128x128）：透明红底 + 标准蓝牙符号（Feather polyline，两翼留空）')

// 黑底三尺寸预览
function icon(s) {
  return '<g transform="scale(' + (s / 256) + ')">'
    + '<circle cx="128" cy="128" r="120" fill="rgba(229,57,53,0.35)"/>'
    + '<g transform="translate(24.8,24.8) scale(8.6)" fill="none" stroke="#E53935" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
    + '<polyline points="' + POLY + '"/></g></g>'
}
const outer = '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="256" viewBox="0 0 520 256">'
  + '<rect width="520" height="256" fill="#000"/>'
  + '<g transform="translate(0,0)">' + icon(256) + '</g>'
  + '<g transform="translate(266,64)">' + icon(128) + '</g>'
  + '<g transform="translate(420,88)">' + icon(80) + '</g></svg>'
fs.writeFileSync(path.join(__dirname, '..', '.bt_preview.png'), new Resvg(outer, { fitTo: { mode: 'width', value: 520 } }).render().asPng())
console.log('  （黑底三尺寸预览: velaPro/.bt_preview.png）')
