// probe-count.mjs —— 探针健康检查：dump 一次，数可交互元素
// 退出码：0 = 元素 > 5（可用）；1 = 元素不足或超时（需要重启 App）
import fs from 'node:fs'

const D = '/data/user/0/com.dsh.android/files/home/.dsh'
const C = D + '/ui-cmd.json'
const R = D + '/ui-result.json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const id = 900000 + (Date.now() % 99999)
try { fs.unlinkSync(R) } catch {}
fs.writeFileSync(C, JSON.stringify({ id, action: 'dump', limit: 1200 }))
for (let i = 0; i < 40; i++) {
  await sleep(250)
  try {
    const d = JSON.parse(fs.readFileSync(R, 'utf8'))
    if (d.id !== id) continue
    const n = (d.elements || []).length
    console.log('elements=' + n + ' url=' + (d.url || '') + ' docAgeMs=' + (d.docAgeMs || 0))
    process.exit(n > 5 ? 0 : 1)
  } catch {}
}
console.log('elements=timeout')
process.exit(1)