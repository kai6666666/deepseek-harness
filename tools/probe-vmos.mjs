// probe-vmos.mjs —— 探测 VMOS+ 的 adb 端点与 ROM 能力
//   1) 列出宿主 LISTEN 端口，并对每个端口做 adb CNXN 握手
//   2) 列出 VMOS 的 ROM 包（路径在宿主可读、proot 内可能不可读）
// 用法：node tools/probe-vmos.mjs
import fs from 'node:fs'
import net from 'node:net'

function listenPorts() {
  const out = new Set()
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let t = ''
    try { t = fs.readFileSync(f, 'utf8') } catch { continue }
    for (const line of t.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length < 4 || c[3] !== '0A') continue
      const p = parseInt(c[1].split(':')[1], 16)
      if (p > 0 && p < 65536) out.add(p)
    }
  }
  return [...out].sort((a, b) => a - b)
}

function crc32(b) {
  let crc = 0xffffffff
  for (let i = 0; i < b.length; i++) {
    let c = (crc ^ b[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function cnxn() {
  const pl = Buffer.from('host::\0')
  const b = Buffer.alloc(24 + pl.length)
  b.writeUInt32LE(0x4e584e43, 0)
  b.writeUInt32LE(0x01000000, 4)
  b.writeUInt32LE(4096 * 1024, 8)
  b.writeUInt32LE(pl.length, 12)
  b.writeUInt32LE(crc32(pl), 16)
  b.writeUInt32LE((0x4e584e43 ^ 0xffffffff) >>> 0, 20)
  pl.copy(b, 24)
  return b
}

const probe = (p) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p })
  let done = false
  let acc = Buffer.alloc(0)
  const fin = (v) => { if (!done) { done = true; try { s.destroy() } catch {} ; res(v) } }
  s.setTimeout(1500, () => fin('timeout'))
  s.on('connect', () => s.write(cnxn()))
  s.on('data', (d) => {
    acc = Buffer.concat([acc, d])
    if (acc.length >= 24) {
      const c = acc.readUInt32LE(0)
      fin(c === 0x4e584e43 ? 'ADBD_CNXN' : c === 0x48545541 ? 'ADBD_AUTH' : 'other')
    }
  })
  s.on('error', (e) => fin(e.code || 'err'))
  s.on('close', () => fin('closed'))
})

const ports = listenPorts()
console.log('LISTEN: ' + ports.join(' '))
for (const p of ports) {
  const r = await probe(p)
  if (r === 'ADBD_CNXN' || r === 'ADBD_AUTH' || r === 'other') console.log('  ' + p + ' -> ' + r)
}

const ROMS = '/sdcard/Android/data/com.vmos.plus/files/roms'
try {
  for (const n of fs.readdirSync(ROMS).filter((x) => /\.7z$/.test(x))) {
    const st = fs.statSync(ROMS + '/' + n)
    console.log('ROM: ' + n + ' ' + st.size + ' bytes')
  }
} catch {
  console.log('ROM: (proot 内不可读 Android/data，用 adb shell ls 或 7z 读 guestOSInfo)')
}