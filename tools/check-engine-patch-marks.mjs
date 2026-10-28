#!/usr/bin/env node
// check-engine-patch-marks.mjs —— 在**已打补丁**的引擎副本上核对补丁标记。
//
// 和 check-engine-anchors.mjs 的分工：
//   anchors      ：升级前，对**未打补丁**的新引擎副本核对原文是否还在（决定补丁要不要改）
//   patch-marks  ：上机后，对 files/engine 核对补丁是否真的写进去了（决定适配有没有生效）
//
// 用法：node tools/check-engine-patch-marks.mjs <engineDir> [--json]
// 退出码：0=全部命中；1=有缺失；2=参数错误。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] || process.env.ENGINE_DIR || ''
if (!root || !existsSync(root)) {
  console.error('用法: node tools/check-engine-patch-marks.mjs <engineDir> [--json]')
  process.exit(2)
}
const M = join(root, 'node_modules/@deepseek-ai')
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const bootFile = (() => {
  const dir = join(M, 'dsh/lib')
  try { return readdirSync(dir).filter((f) => f.startsWith('profile-boot-') && f.endsWith('.js')).map((f) => join(dir, f))[0] || '' } catch { return '' }
})()

const CHECKS = [
  { tag: 'flock-android', why: 'flock 放行 android', file: join(M, 'node-addon-system/lib/flock.js'), has: ["'android'"] },
  { tag: 'fail-loud-boot', why: '插件崩溃不再 proc.exit(1)', file: join(M, 'dsh-app-boot/lib/index.js'), has: ['DSH-ANDROID-KEEP-ALIVE'], lacks: ['proc.exit(1);'] },
  { tag: 'fail-loud-release', why: '插件崩溃不再 dispose 整个 fiber', file: bootFile, has: ['DSH-ANDROID-KEEP-ALIVE-RELEASE'] },
  { tag: 'terminal-shell', why: 'bash 指向 Termux（PREFIX 拼接）', file: join(M, 'dsh-terminal-bash/lib/index.js'), has: ['DEFAULT_BASH_SHELL = process.env.PREFIX'] },
  { tag: 'attachment-fsync', why: '祖先目录 open 失败可容忍', file: join(M, 'dsh-attachment-local/lib/index.js'), has: ['Android: 祖先目录'] },
]

let bad = 0
for (const c of CHECKS) {
  const txt = read(c.file)
  const miss = (c.has || []).filter((s) => !txt.includes(s))
  const extra = (c.lacks || []).filter((s) => txt.includes(s))
  const ok = txt.length > 0 && miss.length === 0 && extra.length === 0
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${c.tag}  ${ok ? '' : `→ ${c.file || '(缺文件)'}  ${miss.length ? '缺标记: ' + miss.join(', ') : ''} ${extra.length ? '仍存在: ' + extra.join(', ') : ''}`}`)
  if (!ok) console.log(`   为什么: ${c.why}`)
}
console.log(`----\n${CHECKS.length - bad}/${CHECKS.length} 补丁标记命中`)
process.exit(bad === 0 ? 0 : 1)
