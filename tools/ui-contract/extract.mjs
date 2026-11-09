#!/usr/bin/env node
// 从引擎插件前端抽取「哈希类名 -> 附近语义属性」候选映射。
// 用法：node tools/ui-contract/extract.mjs --engine <rootfs>/opt/dsh [--out contract.json]

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const ENGINE = arg('--engine')
const OUT = arg('--out', 'tools/ui-contract/contract.json')
if (!ENGINE) {
  console.error('用法: extract.mjs --engine <rootfs>/opt/dsh [--out contract.json]')
  process.exit(2)
}

const HASHED = /(?:\.|["'])([A-Za-z0-9_]{5,8})_([A-Za-z0-9]{2,8})\b/g
const DATA = /\bdata-[a-zA-Z0-9-]+/g
const ARIA = /\baria-[a-zA-Z0-9-]+/g
const ROLE = /\brole\s*[:=]\s*["']([a-z]+)["']/g

const nm = path.join(ENGINE, 'node_modules', '@deepseek-ai')
const files = []
for (const pkg of fs.existsSync(nm) ? fs.readdirSync(nm) : []) {
  const f = path.join(nm, pkg, 'lib', 'client.js')
  if (fs.existsSync(f)) files.push({ pkg, file: f })
}

const map = new Map()
for (const { pkg, file } of files) {
  const text = fs.readFileSync(file, 'utf8')
  HASHED.lastIndex = 0
  let m
  while ((m = HASHED.exec(text))) {
    const key = m[1] + '_' + m[2]
    const win = text.slice(Math.max(0, m.index - 400), Math.min(text.length, m.index + 400))
    const ent = map.get(key) || {
      pkg,
      files: new Set(),
      data: new Set(),
      aria: new Set(),
      role: new Set(),
      samples: 0,
    }
    ent.files.add(pkg)
    ent.samples += 1
    for (const x of win.match(DATA) || []) ent.data.add(x)
    for (const x of win.match(ARIA) || []) ent.aria.add(x)
    let r
    ROLE.lastIndex = 0
    while ((r = ROLE.exec(win))) ent.role.add(r[1])
    map.set(key, ent)
  }
}

const out = {}
for (const [k, v] of [...map.entries()].sort()) {
  out[k] = {
    pkg: v.pkg,
    files: [...v.files],
    data: [...v.data].sort(),
    aria: [...v.aria].sort(),
    role: [...v.role].sort(),
    samples: v.samples,
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')

const withData = Object.values(out).filter((x) => x.data.length > 0).length
const withAria = Object.values(out).filter((x) => x.aria.length > 0).length
console.log('扫描 ' + files.length + ' 个插件 client.js')
console.log('哈希类名 ' + Object.keys(out).length + '；带 data-* 候选 ' + withData + '；带 aria-* 候选 ' + withAria)
console.log('写出 ' + OUT)