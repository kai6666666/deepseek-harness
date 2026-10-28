#!/data/data/com.dsh.android/files/termux/usr/bin/node
// verify-llm-tools.mjs —— 用已登录账号的真模型，逐个驱动工具插件，校验 tool/result。
//
// 与 mock 驱动的区别：这里模型自己决定调用哪个工具，验证的是「模型 → 工具 → 回注」全链路。
//
// root 用例默认冻结（FROZEN）：不驱动模型、不消耗会话，只输出 SKIP 行，不计入分母。
// 设备 / VMOS 具备 root 后加 --root（或 DSH_ROOT=1）启用，判据 tool/result 里出现 uid=0。
//
// 用法：
//   node verify-llm-tools.mjs                  # 5 个工具，root 冻结
//   node verify-llm-tools.mjs --root           # 追加 root 用例
//   node verify-llm-tools.mjs --clean --shot   # 跑完删会话 + 失败截图
// 输出：PASS / FAIL <tool> [note]；SKIP <tool> <note>；SUMMARY n/m [· SKIP ...]；RESULT SUCCESS|FAIL
// 退出码：0 全部 PASS（SKIP 不算失败）；1 有 FAIL。
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const ARGS = process.argv.slice(2)
const F = process.env.DSH_DATA || '/data/user/0/com.dsh.android/files'
const D = F + '/home/.dsh'
const C = D + '/ui-cmd.json'
const R = D + '/ui-result.json'
const SESS = D + '/sessions/--data-user-0-com.dsh.android-files-workspace-deepseek-harness-default-workspace--'
const CLEAN = ARGS.includes('--clean') || process.env.CLEAN === '1'
const SHOT = ARGS.includes('--shot') || process.env.SHOT === '1'
const ROOT_ON = ARGS.includes('--root') || process.env.DSH_ROOT === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let q = 250000
const CASES = [
  { tool: 'bubble', prompt: '用 bubble 工具执行 action=get 读取悬浮球外观，然后用一句话概括。' },
  { tool: 'ui', prompt: '用 ui 工具执行 action=ping，报告探针是否就绪和可交互元素数量。' },
  { tool: 'logs', prompt: '用 logs 工具执行 action=summary，把日志条数和错误数报给我。' },
  { tool: 'statusbar', prompt: '用 statusbar 工具执行 action=get，报告当前系统栏配色。' },
  { tool: 'browser', prompt: '用 browser 工具执行 action=tabs，列出当前标签页。' },
]
if (ROOT_ON) CASES.push({ tool: 'root', prompt: '用 root 工具执行 command=id，报告当前进程的 uid。', expect: /uid=0/ })
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
const readSession = (f) => { try { return zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8') } catch { return '' } }
function sessionsSince(ts) {
  const out = []
  for (const d of fs.readdirSync(SESS)) {
    const f = path.join(SESS, d, 'session.v4.jsonl.zstd')
    try { if (fs.statSync(f).mtimeMs >= ts) out.push(f) } catch {}
  }
  return out
}
function findToolResult(files, tool) {
  for (const f of files) {
    const txt = readSession(f)
    for (const l of txt.split('\n')) {
      let j
      try { j = JSON.parse(l) } catch { continue }
      if (j.type !== 'tool/call' || j.data.name !== tool) continue
      const cid = j.data.callId
      for (const l2 of txt.split('\n')) {
        let k
        try { k = JSON.parse(l2) } catch { continue }
        if (k.type !== 'tool/result') continue
        const m = k.data.message || {}
        if ((k.data.toolCallId || m.toolCallId) !== cid) continue
        return { sid: path.basename(path.dirname(f)), text: (m.content || []).map((c) => c.text || '').join('') }
      }
    }
  }
  return null
}
function cleanup(sid) {
  try { fs.rmSync(path.join(SESS, sid), { recursive: true, force: true }) } catch {}
  try {
    const wp = D + '/storages/workspace.json'
    const j = JSON.parse(fs.readFileSync(wp, 'utf8'))
    for (const w of Object.values(j.tables.workspaces || {})) w.sessionIds = (w.sessionIds || []).filter((x) => x !== sid)
    j.global.archivedSessionIds = (j.global.archivedSessionIds || []).filter((x) => x !== sid)
    j.global.pinnedSessionIds = (j.global.pinnedSessionIds || []).filter((x) => x !== sid)
    if (j.tables.sessions) delete j.tables.sessions[sid]
    fs.writeFileSync(wp, JSON.stringify(j))
  } catch {}
}
function shot() {
  if (!SHOT) return ''
  const p = F + '/home/llm-tools-fail-' + Date.now() + '.png'
  try { execFileSync('screencap', ['-p', p], { stdio: 'ignore' }); return ' FAIL_PNG ' + p } catch { return '' }
}
async function findBox() {
  for (let i = 0; i < 20; i++) {
    const d = await probe('dump')
    const box = (d.elements || []).find((e) => e.tag === 'div' && e.role === 'textbox')
    if (box) return { d, box }
    await sleep(1000)
  }
  return null
}
const boxText = (e) => ((e.value || '') + (e.text || '') + (e.aria || '')).replace(/\s+/g, ' ').trim()
const findTextBox = (d) => (d.elements || []).find((e) => e.tag === 'div' && e.role === 'textbox')
async function openNewSession() {
  let d = await probe('dump')
  const nav = (d.elements || []).find((e) => T(e) === '\u6253\u5f00\u5bfc\u822a' && X(e) >= 0)
  if (!nav) return false
  await probe('tap', { ref: nav.ref })
  await sleep(900)
  d = await probe('dump')
  const ns = (d.elements || []).find((e) => /\u65b0\u5efa\u4f1a\u8bdd/.test(T(e)) && X(e) > 5)
  if (!ns) return false
  await probe('tap', { ref: ns.ref })
  await sleep(1600)
  return true
}
async function sendInCurrent(prompt) {
  let got = await findBox()
  if (!got) {
    await openNewSession()
    got = await findBox()
  }
  if (!got) throw new Error('NO_BOX')
  const head = prompt.slice(0, 4)
  let typed = false
  for (let k = 0; k < 5; k++) {
    const d = await probe('dump')
    const box = findTextBox(d)
    if (box && boxText(box).includes(head)) { typed = true; break }
    if (box) await probe('type', { ref: box.ref, value: prompt, clear: true })
    await sleep(800)
  }
  if (!typed) {
    const d = await probe('dump')
    if (!findTextBox(d)) throw new Error('TYPE_FAIL')
  }
  for (let k = 0; k < 4; k++) {
    const d = await probe('dump')
    const send = (d.elements || []).find((e) => T(e) === '\u53d1\u9001\u6d88\u606f')
    if (send) await probe('tap', { ref: send.ref })
    await sleep(1800)
    const d2 = await probe('dump')
    const box2 = findTextBox(d2)
    if (!box2) return
    if (!boxText(box2).includes(head)) return
  }
  throw new Error('SEND_BLOCKED')
}

const cleanedSids = new Set()
const results = []
if (!ROOT_ON) results.push({ tool: 'root', status: 'SKIP', note: 'FROZEN_NO_ROOT' })
for (const c of CASES) {
  let ok = false
  let note = ''
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    const t0 = Date.now() - 4000
    note = ''
    try {
      await openNewSession()
      await sendInCurrent(c.prompt)
      let hit = null
      for (let i = 0; i < 45; i++) {
        await sleep(3000)
        hit = findToolResult(sessionsSince(t0), c.tool)
        if (hit) break
      }
      if (!hit) note = 'NO_TOOL_RESULT'
      else if (c.expect) ok = c.expect.test(hit.text)
      else ok = /\u6210\u529f|completed/i.test(hit.text) || hit.text.length > 0
      if (!ok && hit && !note) note = 'BAD_RESULT'
      if (hit) cleanedSids.add(hit.sid)
    } catch (e) { note = e.message }
    if (!ok) console.log('RETRY ' + c.tool + ' (' + note + ')')
  }
  results.push({ tool: c.tool, status: ok ? 'PASS' : 'FAIL', note })
  console.log((ok ? 'PASS ' : 'FAIL ') + c.tool + (ok || !note ? '' : ' ' + note) + (ok ? '' : shot()))
}

for (const s of results) if (s.status === 'SKIP') console.log('SKIP ' + s.tool + ' ' + s.note)
if (CLEAN) {
  const all = [...cleanedSids]
  const keepLast = all.pop()
  for (const sid of all) cleanup(sid)
  if (keepLast) console.log('kept ' + keepLast + ' (current UI session)')
}
const pass = results.filter((r) => r.status === 'PASS').length
const fail = results.filter((r) => r.status === 'FAIL').length
const skip = results.filter((r) => r.status === 'SKIP')
console.log('SUMMARY ' + pass + '/' + (pass + fail) + (skip.length ? ' · SKIP ' + skip.length + ' (' + skip.map((s) => s.tool + ':' + s.note).join(',') + ')' : ''))
console.log('RESULT ' + (fail ? 'FAIL' : 'SUCCESS'))
process.exit(fail ? 1 : 0)