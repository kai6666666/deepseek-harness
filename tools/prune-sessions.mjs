// prune-sessions.mjs —— 把当前 workspace 的会话收成 1 条（保留最新，即 UI 正在显示的那条）
// 用法：node /data/local/tmp/prune-sessions.mjs
// 为什么需要：真模型验收每轮都会新建会话，--clean 只清「拿到 tool/result」的那些，
// 剩下空壳会一直堆在 workspace 索引里，让「会话索引干净」这条断言变红。
import fs from 'node:fs'
import path from 'node:path'

const D = '/data/user/0/com.dsh.android/files/home/.dsh'
const S = D + '/sessions/--data-user-0-com.dsh.android-files-workspace-deepseek-harness-default-workspace--'
const list = fs.readdirSync(S).map((d) => {
  let t = 0
  try { t = fs.statSync(path.join(S, d, 'session.v4.jsonl.zstd')).mtimeMs } catch {}
  return { d, t }
}).sort((a, b) => b.t - a.t)
const keep = list.slice(0, 1).map((x) => x.d)
for (const x of list.slice(1)) fs.rmSync(path.join(S, x.d), { recursive: true, force: true })
const wp = D + '/storages/workspace.json'
const j = JSON.parse(fs.readFileSync(wp, 'utf8'))
const k = new Set(keep)
for (const w of Object.values(j.tables.workspaces || {})) w.sessionIds = (w.sessionIds || []).filter((x) => k.has(x))
j.global.archivedSessionIds = (j.global.archivedSessionIds || []).filter((x) => k.has(x))
j.global.pinnedSessionIds = (j.global.pinnedSessionIds || []).filter((x) => k.has(x))
if (j.tables.sessions) for (const id of Object.keys(j.tables.sessions)) if (!k.has(id)) delete j.tables.sessions[id]
fs.writeFileSync(wp, JSON.stringify(j))
console.log('kept ' + keep.join(',') + ' removed ' + (list.length - 1))