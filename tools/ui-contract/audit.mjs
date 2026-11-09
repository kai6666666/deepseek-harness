#!/usr/bin/env node
// UI 契约审计：统计「webpack 哈希类名」在我们自己的代码里还剩多少。
//
// 用法：
//   node tools/ui-contract/audit.mjs
//   node tools/ui-contract/audit.mjs --json
//   node tools/ui-contract/audit.mjs --write-baseline
//   node tools/ui-contract/audit.mjs --max 87   # 超过即 exit 1（CI 门禁）

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCAN = ['app/src/main', 'mobile-ui-plugin']
const HASHED = /\.([A-Za-z0-9_]{5,8})_([A-Za-z0-9]{2,8})\b/g
const SKIP = /(^|\/)(build|\.gradle|node_modules|\.git)(\/|$)/

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (SKIP.test(p)) continue
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(js|mjs|kt|java|ts|css|html)$/.test(ent.name)) out.push(p)
  }
  return out
}

const byFile = new Map()
const unique = new Set()
for (const rel of SCAN) {
  for (const file of walk(path.join(ROOT, rel))) {
    const text = fs.readFileSync(file, 'utf8')
    let m
    HASHED.lastIndex = 0
    while ((m = HASHED.exec(text))) {
      const cls = '.' + m[1] + '_' + m[2]
      unique.add(cls)
      const relFile = path.relative(ROOT, file)
      if (!byFile.has(relFile)) byFile.set(relFile, new Set())
      byFile.get(relFile).add(cls)
    }
  }
}

const rows = [...byFile.entries()]
  .map(([file, set]) => ({ file, count: set.size, classes: [...set].sort() }))
  .sort((a, b) => b.count - a.count)

const result = { unique: unique.size, files: rows.length, rows }
const args = process.argv.slice(2)

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else if (args.includes('--write-baseline')) {
  const out = path.join(ROOT, 'tools/ui-contract/baseline.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  console.log('baseline: ' + out + '  unique=' + unique.size + '  files=' + rows.length)
} else {
  console.log('== 哈希类名审计 ==')
  console.log('唯一类名 ' + unique.size + '，分布在 ' + rows.length + ' 个文件')
  for (const r of rows.slice(0, 15)) {
    console.log('  ' + String(r.count).padStart(3) + '  ' + r.file)
  }
  if (rows.length > 15) console.log('  … 其余 ' + (rows.length - 15) + ' 个文件')

  const maxIdx = args.indexOf('--max')
  if (maxIdx >= 0) {
    const max = Number(args[maxIdx + 1])
    if (!Number.isFinite(max)) {
      console.error('--max 需要一个数字')
      process.exit(2)
    }
    if (unique.size > max) {
      console.error('\nFAIL: ' + unique.size + ' > ' + max + '（哈希类名不允许增加）')
      process.exit(1)
    }
    console.log('\nOK: ' + unique.size + ' <= ' + max)
  }
}