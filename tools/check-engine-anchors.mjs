#!/usr/bin/env node
// check-engine-anchors.mjs —— 在任意引擎副本上核对 Android 适配所依赖的文本锚点。
//
// 为什么需要它：EngineManager 里十几处补丁靠「引擎内部文本」定位，匹配不到只 warn 并静默跳过。
// 升级引擎前先跑这个脚本，否则会出现「补丁没生效但没人知道」。
//
// 用法：node tools/check-engine-anchors.mjs /opt/dsh-rc3 [--json]
// 退出码：0=全部命中；1=有缺失；2=参数/目录错误。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ANCHORS = [
  { tag: 'flock-platform', file: 'node_modules/@deepseek-ai/node-addon-system/lib/flock.js', anchor: "if (platform !== 'linux' && platform !== 'darwin') {", why: 'flock 平台白名单：要放行 android' },
  { tag: 'fail-loud-app-boot', file: 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', anchor: 'proc.exit(1);', why: '插件崩溃不杀引擎（两处 proc.exit）' },
  { tag: 'fail-loud-release', file: 'node_modules/@deepseek-ai/dsh/lib/profile-boot-*.js', anchor: 'await app.current?.fiber.dispose();', why: '同一处 release 回调（只改 exit 不改它 = 引擎照退）' },
  { tag: 'terminal-shell', file: 'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js', anchor: 'const DEFAULT_BASH_SHELL = "/bin/bash";', why: 'Android 没有 /bin/bash，必须换 Termux bash' },
  { tag: 'attachment-fsync', file: 'node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js', anchor: '\tconst handle = await open(path, constants.O_RDONLY);', why: '祖先目录 fsync 容错（否则图片发送失败）' },
]

const root = process.argv[2] || process.env.ENGINE_DIR || ''
const asJson = process.argv.includes('--json')
if (!root || !existsSync(root)) {
  console.error('用法: node tools/check-engine-anchors.mjs <engineDir> [--json]')
  process.exit(2)
}

function resolveOne(pattern) {
  if (!pattern.includes('*')) {
    const p = join(root, pattern)
    return existsSync(p) && statSync(p).isFile() ? [p] : []
  }
  const dir = join(root, pattern.slice(0, pattern.lastIndexOf('/')))
  const base = pattern.slice(pattern.lastIndexOf('/') + 1)
  const prefix = base.slice(0, base.indexOf('*'))
  const suffix = base.slice(base.indexOf('*') + 1)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith(suffix)).map((n) => join(dir, n))
}

function findNearby(text, anchor) {
  const tokens = anchor.replace(/["'`]/g, ' ').split(/[^A-Za-z0-9_$.]+/).filter((t) => t.length >= 4).slice(0, 3)
  if (tokens.length === 0) return []
  const lines = text.split('\n')
  const hit = []
  for (let i = 0; i < lines.length && hit.length < 3; i++) {
    if (tokens.every((t) => lines[i].includes(t))) hit.push(`${i + 1}: ${lines[i].trim().slice(0, 160)}`)
  }
  return hit
}

const results = []
for (const a of ANCHORS) {
  const files = resolveOne(a.file)
  if (files.length === 0) {
    results.push({ tag: a.tag, ok: false, reason: 'file-missing', file: a.file, why: a.why })
    continue
  }
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const ok = text.includes(a.anchor)
    results.push({ tag: a.tag, ok, reason: ok ? 'ok' : 'anchor-missing', file: relative(root, f), why: a.why, ...(ok ? {} : { hint: findNearby(text, a.anchor) }) })
  }
}

if (asJson) {
  console.log(JSON.stringify({ root, results }, null, 2))
} else {
  console.log(`== 引擎目录: ${root}`)
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.tag}  ${r.file}  (${r.reason})`)
    if (!r.ok) {
      console.log(`   为什么需要: ${r.why}`)
      for (const h of r.hint ?? []) console.log(`   候选: ${h}`)
    }
  }
}

process.exit(results.every((r) => r.ok) ? 0 : 1)
