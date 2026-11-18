#!/usr/bin/env node
// ⚠️ 必须是 .cjs：Node 按扩展名决定模块系统，.mjs 会被当 ESM，require 直接 ReferenceError。
// proot-verify-driver.cjs —— 在 PRoot guest 内跑的验收驱动（0.2.2-rc.3-debug）
//
// 为什么要它：rootfs 的 /usr/bin/node 是 glibc ELF，Android 侧没有
// /lib/ld-linux-aarch64.so.1，`run-as sh -c '.../node x.mjs'` 必然 ENOENT。
// 所以设备侧只能由 App 通过 ProotHost.startCommand 在 proot 内执行。
//
// 调用（宿主侧，见 tools/verify-rc3-device.sh）：
//   adb shell am start -n com.dsh.android/.runtime.ProotProbeActivity \
//     --es run_script /data/user/0/com.dsh.android/files/home/.dsh/proot-verify-driver.mjs
//
// 输出：stdout（被 ProotProbeActivity 收集到 files/proot-probe.txt）
// 结论行：RESULT=PASS / RESULT=FAIL

'use strict'
const fs = require('fs')
const path = require('path')

const IDS = '/opt/dsh/node_modules/@deepseek-ai'
const EXPECT_ENGINE = '0.2.2-rc.3'

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

// 1) 引擎版本
let engine = 'UNKNOWN'
try { engine = JSON.parse(read(path.join(IDS, 'dsh/package.json'))).version } catch {}
console.log('engine=' + engine)

// 2) 补丁标记（与 tools/check-engine-patch-marks.mjs 同口径，内联避免依赖外部文件）
const bootFile = (() => {
  try {
    const d = path.join(IDS, 'dsh/lib')
    return fs.readdirSync(d).filter((f) => f.startsWith('profile-boot-') && f.endsWith('.js'))
      .map((f) => path.join(d, f))[0] || ''
  } catch { return '' }
})()

const CHECKS = [
  ['flock-android', path.join(IDS, 'node-addon-system/lib/flock.js'), ["'android'"], []],
  ['fail-loud-boot', path.join(IDS, 'dsh-app-boot/lib/index.js'), ['DSH-ANDROID-KEEP-ALIVE'], ['proc.exit(1);']],
  ['fail-loud-release', bootFile, ['DSH-ANDROID-KEEP-ALIVE-RELEASE'], []],
  ['terminal-shell', path.join(IDS, 'dsh-terminal-bash/lib/index.js'), ['DEFAULT_BASH_SHELL = process.env.PREFIX'], []],
  ['attachment-fsync', path.join(IDS, 'dsh-attachment-local/lib/index.js'), ['Android: 祖先目录'], []],
]

let marks = 0
for (const [tag, file, has, lacks] of CHECKS) {
  const txt = read(file)
  const miss = has.filter((s) => !txt.includes(s))
  const extra = lacks.filter((s) => txt.includes(s))
  const ok = txt.length > 0 && miss.length === 0 && extra.length === 0
  if (ok) marks += 1
  console.log((ok ? '[OK]   ' : '[FAIL] ') + tag + (ok ? '' : '  miss=' + JSON.stringify(miss) + ' extra=' + JSON.stringify(extra)))
}
console.log('patch-marks=' + marks + '/' + CHECKS.length)

// 3) 发图白名单是否已放宽（IMG_TYPE 补丁的真实效果）
const conv = read(path.join(IDS, 'dsh-client-ui-conversation/lib/client.js'))
const relaxed = conv.includes('return value.startsWith(`image/`)')
const guarded = /function isImageMediaType\(value\)\{if\(typeof value!==`string`\)/.test(conv)
console.log('img_type_relaxed=' + (relaxed ? 'yes' : 'no') + ' shaped=' + (guarded ? 'yes' : 'no'))

// 4) rootfs 关键文件
const FILES = [
  '/usr/bin/node',
  '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  '/usr/local/bin/dsh',
  '/usr/local/bin/pnpm',
  '/usr/local/bin/boo-sandbox-run',
  '/usr/local/lib/liblinkcompat.so',
  '/usr/bin/git',
  '/usr/bin/python3',
  '/usr/bin/curl',
  '/etc/ssl/certs/ca-certificates.crt',
]
let files = 0
for (const f of FILES) {
  const ok = (() => { try { return fs.statSync(f).isFile() && fs.statSync(f).size > 0 } catch { return false } })()
  if (ok) files += 1
  console.log((ok ? '[OK]   ' : '[MISS] ') + f)
}
console.log('files=' + files + '/' + FILES.length)

// 5) Office Kit 是否随包（保留策略的静态证据；真跑仍需 tool 调用）
const office = fs.existsSync(path.join(IDS, 'dsh-office-kit/package.json'))
const lowasm = fs.existsSync(path.join(IDS, 'libreoffice-kit-wasm/package.json'))
console.log('office_kit=' + (office ? 'present' : 'missing') + ' libreoffice_wasm=' + (lowasm ? 'present' : 'missing'))

const pass = engine === EXPECT_ENGINE && marks === CHECKS.length && relaxed && files === FILES.length
console.log('RESULT=' + (pass ? 'PASS' : 'FAIL'))
process.exit(pass ? 0 : 1)