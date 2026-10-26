#!/usr/bin/env node
// mcp-android —— 把 Android 能力做成标准 MCP server（stdio JSON-RPC）。
//
// 为什么是 MCP 而不是再写一个 dsh 插件：
//   · dsh 已经内置 `@deepseek-ai/dsh-mcp-client`，MCP 工具会**原生出现**在模型工具表里；
//   · 同一个 server 可以同时被本机 dsh、远端 dsh、甚至别的 agent 用 —— 桥一次，处处能用；
//   · 桥的落地协议只需要两个文件（cmd/result），与 DSHAPP 现有文件信箱同构，不需要新原生代码。
//
// 协议：stdio，逐行 JSON-RPC 2.0（MCP stdio transport）。
// 通道：$DSH_HOME/mcp-cmd.json（本进程写）/ $DSH_HOME/mcp-result.json（Kotlin 侧写）。
//   { "id": 123, "action": "tap", "args": { "x": 10, "y": 20 } }
//   { "id": 123, "ok": true, "data": { ... } }
//
// ⚠️ stdout 是协议通道：任何日志只能走 stderr。

import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CMD = join(DSH_HOME, 'mcp-cmd.json')
const RES = join(DSH_HOME, 'mcp-result.json')
const POLL_MS = 120
const DEFAULT_TIMEOUT_MS = 20_000

const log = (...a) => process.stderr.write('[mcp-android] ' + a.join(' ') + '\n')

const TOOLS = [
  {
    name: 'android_ui_dump',
    description: '枚举当前屏幕上的可交互元素（带稳定编号与屏幕坐标），用于后续点击/输入。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'android_tap',
    description: '按屏幕坐标点击。返回 onTarget 用于判断事件是否真的送达元素。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'android_type',
    description: '向当前焦点输入文本（等价于键盘输入，不是设置值）。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'android_screenshot',
    description: '截取当前屏幕，返回落盘绝对路径。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'android_shell',
    description: '以 shell(uid 2000) 执行一条命令（需 Shizuku/adb 授权；未授权时明确报错）。',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'android_open_with',
    description: '用系统“打开方式”打开 /sdcard 下的文件或目录（app 私有目录不支持）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, mime: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'android_notify',
    description: '发一条系统通知（用于长任务完成提醒）。',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, text: { type: 'string' } },
      required: ['title', 'text'],
    },
  },
]

let seq = 0

async function callBridge(action, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const id = ++seq
  await writeFile(CMD, JSON.stringify({ id, action, args, ts: Date.now() }) + '\n')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(RES, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.id === id) {
        if (parsed.ok === false) throw new Error(parsed.error || `${action} 被宿主拒绝`)
        return parsed.data ?? {}
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // 宿主正在写（非原子）：下一轮再读
      } else if (e?.code !== 'ENOENT') {
        throw e
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
  throw new Error(`宿主无响应（${action} > ${timeoutMs}ms）：检查 DSHAPP 的 MCP 桥是否在轮询 ${CMD}`)
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-android', version: '1.0.0' },
      })
    case 'notifications/initialized':
      return // 通知无需回复
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call': {
      const name = params?.name
      const a = params?.arguments ?? {}
      try {
        let data
        switch (name) {
          case 'android_ui_dump': data = await callBridge('dump', {}); break
          case 'android_tap': data = await callBridge('tap', { x: a.x, y: a.y }); break
          case 'android_type': data = await callBridge('type', { text: a.text }); break
          case 'android_screenshot': data = await callBridge('screenshot', {}); break
          case 'android_shell': data = await callBridge('shell', { command: a.command }); break
          case 'android_notify': data = await callBridge('notify', { title: a.title, text: a.text }); break
          case 'android_open_with': data = await callBridge('open_with', { path: a.path, mime: a.mime }); break
          default: throw new Error(`未知工具: ${name}`)
        }
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(data) }] })
      } catch (e) {
        return reply(id, {
          isError: true,
          content: [{ type: 'text', text: `调用失败: ${e.message}` }],
        })
      }
    }
    default:
      if (id !== undefined) fail(id, -32601, `未实现的方法: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  const text = line.trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    log('忽略非 JSON 行')
    return
  }
  handle(msg).catch(e => log('处理失败:', e?.message ?? String(e)))
})

log('ready; DSH_HOME=' + DSH_HOME)