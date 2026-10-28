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
// 环境变量：
//   CLEAN=1  跑完把本次测试会话删掉（文件 + workspace.json 索引），只留证据文本
//   SHOT=1   失败时额外 screencap 一张到 files/home/llm-fail-<ts>.png
//
// 输出：HIT uid=… / NO_HIT reason / NO_BOX / NO_SEND（失败时附 FAIL_PNG 路径）
// 退出码：0 命中；1 未命中。
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const F = '/data/user/0/com.dsh.android/files'
const D = F + '/home/.dsh'
const C = D + '/ui-cmd.json'
const R = D + '/ui-result.json'
const SESS = D + '/sessions/--data-user-0-com.dsh.android-files-workspace-deepseek-harness-default-workspace--'
const CLEAN = process.env.CLEAN === '1'
const SHOT = process.env.SHOT === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cleaned = []
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

function evidence(file) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const out = F + '/home/llm-evidence-' + ts + '.txt'
  const txt = readSession(file)
  const lines = []
  for (const l of txt.split('\n')) {
    let j
    try { j = JSON.parse(l) } catch { continue }
    if (j.type === 'tool/result') {
      const m = j.data.message || {}
      const t = (m.content || []).map((c) => c.text || '').join('')
      if (t) lines.push('TOOLRESULT: ' + t.slice(0, 400))
    }
    if (j.type === 'assistant/message') {
      for (const c of j.data.message.content || []) if (c.type === 'text') lines.push('ASSISTANT: ' + c.text.slice(0, 400))
    }
  }
  fs.writeFileSync(out, lines.join('\n') + '\n')
  return out
}

function anyHasPrompt() {
  for (const d of fs.readdirSync(SESS)) {
    const f = path.join(SESS, d, 'session.v4.jsonl.zstd')
    try { if (readSession(f).includes('用 shell 工具执行 id')) return true } catch {}
  }
  return false
}

function cleanupSession(file) {
  const dir = path.dirname(file)
  const sid = path.basename(dir)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  try {
    const wp = D + '/storages/workspace.json'
    const j = JSON.parse(fs.readFileSync(wp, 'utf8'))
    for (const w of Object.values(j.tables.workspaces || {})) {
      w.sessionIds = (w.sessionIds || []).filter((x) => x !== sid)
    }
    j.global.archivedSessionIds = (j.global.archivedSessionIds || []).filter((x) => x !== sid)
    j.global.pinnedSessionIds = (j.global.pinnedSessionIds || []).filter((x) => x !== sid)
    if (j.tables.sessions) delete j.tables.sessions[sid]
    fs.writeFileSync(wp, JSON.stringify(j))
  } catch {}
  cleaned.push(sid)
  try { fs.writeFileSync(F + '/home/llm-last-clean.json', JSON.stringify({ ts: new Date().toISOString(), ids: cleaned })) } catch {}
}

function cleanupNewest(start) {
  if (!CLEAN) return
  const f = newestSession(start - 5000)
  if (f) cleanupSession(f)
}

function failShot() {
  if (!SHOT) return ''
  const p = F + '/home/llm-fail-' + Date.now() + '.png'
  try { execFileSync('screencap', ['-p', p], { stdio: 'ignore' }) ; return ' FAIL_PNG ' + p } catch { return '' }
}

;(async () => {
  const start = Date.now()
  let d = await probe('dump')
  const nav = (d.elements || []).find((e) => T(e) === '打开导航' && X(e) >= 0)
  if (nav) { await probe('tap', { ref: nav.ref }); await sleep(900); d = await probe('dump') }
  const ns = (d.elements || []).find((e) => /新建会话/.test(T(e)) && X(e) > 5)
  if (ns) { await probe('tap', { ref: ns.ref }); await sleep(1500); d = await probe('dump') }
  const box = (d.elements || []).find((e) => e.tag === 'div' && e.role === 'textbox')
  if (!box) { console.log('NO_BOX' + failShot()); process.exit(1) }
  await probe('type', { ref: box.ref, value: '用 shell 工具执行 id 命令，把原始输出原样贴出来', clear: true })
  await sleep(400)
  d = await probe('dump')
  const send = (d.elements || []).find((e) => T(e) === '发送消息')
  if (!send) { console.log('NO_SEND' + failShot()); process.exit(1) }
  await probe('tap', { ref: send.ref })

  let wrote = false
  for (let i = 0; i < 6; i++) { await sleep(3000); if (anyHasPrompt()) { wrote = true; break } }
  if (!wrote) { console.log('NO_HIT NO_SESSION_WRITE' + failShot()); process.exit(1) }

  for (let i = 0; i < 45; i++) {
    await sleep(3000)
    const f = newestSession(start - 5000)
    if (!f) continue
    const txt = readSession(f)
    const m = txt.match(/uid=\d+\([^)]*\)/)
    if (m) {
      const ev = evidence(f)
      if (CLEAN) cleanupSession(f)
      console.log('HIT ' + m[0] + (CLEAN ? ' (cleaned, evidence ' + ev + ')' : ''))
      process.exit(0)
    }
    if (/MISSING_CREDENTIAL|ACCOUNT_SIGN_IN_REQUIRED/.test(txt)) {
      const code = txt.match(/(MISSING_CREDENTIAL|ACCOUNT_SIGN_IN_REQUIRED)/)[1]
      cleanupNewest(start)
      console.log('NO_HIT ' + code + failShot()); process.exit(1)
    }
  }
  cleanupNewest(start)
  console.log('NO_HIT timeout' + failShot())
  process.exit(1)
})().catch((e) => { console.log('NO_HIT ' + e.message + failShot()); process.exit(1) })