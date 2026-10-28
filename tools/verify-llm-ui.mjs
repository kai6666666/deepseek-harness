#!/data/data/com.dsh.android/files/termux/usr/bin/node
// verify-llm-ui.mjs —— 用「已登录账号」在 App UI 里跑一轮真实对话，并校验工具真的执行了。
//
// 为什么不用 headless：
//   账号 provider（deepseek-account）要求请求目的地允许账号认证，headless 里会报
//   ACCOUNT_SIGN_IN_REQUIRED；App 的 Web 进程才持有 client-connection 授权。
//
// 做法：探针 UI 注入 → 新建会话 → 发一条要求调用 shell 的消息 →
//       轮询最新 session.v4.jsonl.zstd，等 tool/result 里出现 uid=。
//
// 输出：HIT uid=... / NO_HIT reason / NO_BOX / NO_SEND
// 退出码：0 命中；1 未命中。
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

const D = '/data/user/0/com.dsh.android/files/home/.dsh'
const C = D + '/ui-cmd.json'
const R = D + '/ui-result.json'
const SESS = D + '/sessions/--data-user-0-com.dsh.android-files-workspace-deepseek-harness-default-workspace--'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let q = 230000

async function probe(action, extra = {}) {
  const id = ++q
  try { fs.unlinkSync(R) } catch {}
  fs.writeFileSync(C, JSON.stringify({ id, action, limit: 1200, ...extra }))
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    try {
      const d = JSON.parse(fs.readFileSync(R, 'utf8'))
      if (d.id === id) return d
    } catch {}
  }
  throw new Error(action + ' timeout')
}
const T = (e) => ((e.text || '') + (e.aria || '')).replace(/\s+/g, ' ').trim()
const X = (e) => Math.round(((e.rect || {}).x) || 0)

function newestSession(mtimeFloor) {
  let best = ''
  let bt = 0
  for (const d of fs.readdirSync(SESS)) {
    const f = path.join(SESS, d, 'session.v4.jsonl.zstd')
    try {
      const st = fs.statSync(f)
      if (st.mtimeMs >= mtimeFloor && st.mtimeMs > bt) { bt = st.mtimeMs; best = f }
    } catch {}
  }
  return best
}
function readSession(f) {
  try { return zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8') } catch { return '' }
}

;(async () => {
  const start = Date.now()
  let d = await probe('dump')
  const nav = (d.elements || []).find((e) => T(e) === '打开导航' && X(e) >= 0)
  if (nav) { await probe('tap', { ref: nav.ref }); await sleep(900); d = await probe('dump') }
  const ns = (d.elements || []).find((e) => /新建会话/.test(T(e)) && X(e) > 5)
  if (ns) { await probe('tap', { ref: ns.ref }); await sleep(1500); d = await probe('dump') }
  const box = (d.elements || []).find((e) => e.tag === 'div' && e.role === 'textbox')
  if (!box) { console.log('NO_BOX'); process.exit(1) }
  await probe('type', { ref: box.ref, value: '用 shell 工具执行 id 命令，把原始输出原样贴出来', clear: true })
  await sleep(400)
  d = await probe('dump')
  const send = (d.elements || []).find((e) => T(e) === '发送消息')
  if (!send) { console.log('NO_SEND'); process.exit(1) }
  await probe('tap', { ref: send.ref })

  for (let i = 0; i < 45; i++) {
    await sleep(3000)
    const f = newestSession(start - 5000)
    if (!f) continue
    const txt = readSession(f)
    const m = txt.match(/uid=\d+\([^)]*\)/)
    if (m) { console.log('HIT ' + m[0]); process.exit(0) }
    if (/MISSING_CREDENTIAL|ACCOUNT_SIGN_IN_REQUIRED/.test(txt)) {
      const code = txt.match(/(MISSING_CREDENTIAL|ACCOUNT_SIGN_IN_REQUIRED)/)[1]
      console.log('NO_HIT ' + code); process.exit(1)
    }
  }
  console.log('NO_HIT timeout')
  process.exit(1)
})().catch((e) => { console.log('NO_HIT ' + e.message); process.exit(1) })
