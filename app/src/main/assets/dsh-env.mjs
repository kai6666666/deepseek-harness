#!/data/data/com.dsh.android/files/termux/usr/bin/node
// ─────────────────────────────────────────────────────────────────────────────
// dsh-env.mjs (v2) —— DSH 开发环境：**分组 + 子项** 的体检 / 安装 / 卸载
//
// 形态对齐 Operit 的「环境配置」向导：六张卡片，每张卡片里若干子项各自可勾选。
// 与 v1（六行）的差别不只是 UI：现在每个**子项**都有独立的安装器与回滚记录。
//
// 三类安装器（这是本文件的主干）：
//   apt    —— `apt-get install <pkgs>`，安装前后取 dpkg 快照做差分，卸载只回滚差集
//   pip    —— `python3 -m pip install <pkg>`，回滚用 `pip uninstall -y`
//   custom —— 下载/脚本安装（Gradle zip、rustup），回滚靠记录的 dirs + links
// 另有三类“零体积”项：
//   builtin —— 内建运行时（node / pnpm），只探测不装卸
//   check   —— 能力自检（venv、sshd），缺了就补（apt 里已有的包）
//   link    —— 软链（python → python3），建/删都是一条 ln
//
// 状态文件：$FILES/env-state.json（v2）
//   { version: 2, items: { "<itemId>": {pkgs,pipPkgs,dirs,links,installedAt,version,adopted} } }
// v1（顶层 id → 记录）会在读取时自动迁移，并按 item 的 `pkgs` 反查补齐（adopt）。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const FILES = process.env.DSH_FILES || '/data/user/0/com.dsh.android/files';
const PREFIX = process.env.PREFIX || path.join(FILES, 'termux/usr');
const HOME = process.env.HOME || path.join(FILES, 'termux/home');
const STATE_FILE = path.join(FILES, 'env-state.json');
const BIN = path.join(PREFIX, 'bin');

const ENV = {
  ...process.env,
  PREFIX,
  HOME,
  TMPDIR: path.join(PREFIX, 'tmp'),
  PATH: `${BIN}:${process.env.PATH || '/system/bin:/system/xbin'}`,
  LD_LIBRARY_PATH: `${path.join(PREFIX, 'lib')}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`,
  // ⚠️ pip 24+ 用 vendored truststore 直接调 OpenSSL；Termux 的 CA 在
  //   `$PREFIX/etc/tls/cert.pem`，不显式指过去就会在 `load_verify_locations`
  //   抛异常（真机上就是这样：pip 直接 traceback，提示 exit 2）。
  PIP_CERT: path.join(PREFIX, 'etc/tls/cert.pem'),
  SSL_CERT_FILE: path.join(PREFIX, 'etc/tls/cert.pem'),
  REQUESTS_CA_BUNDLE: path.join(PREFIX, 'etc/tls/cert.pem'),
};

// ── 保护名单：任何卸载路径都不许碰 ────────────────────────────────────────────
const PROTECTED = [
  'bash', 'coreutils', 'dash', 'dpkg', 'apt', 'libapt',
  'zlib', 'openssl', 'libcrypto', 'libssl', 'libandroid-support',
  'libc++', 'libc++_shared', 'nodejs', 'nodejs-lts',
];

// ── 分组定义 ─────────────────────────────────────────────────────────────────
// 每个 item：
//   kind    apt | pip | custom | check | link | builtin
//   pkgs    apt 的包名（也是 adopt 的依据）
//   pipPkg  pip 包名
//   probe   探测命令（argv 数组），第一行输出用来显示版本
//   estMb   体积预估（安装前给用户看）
//   required 该项是否不可卸载
const GROUPS = [
  {
    id: 'nodejs', label: 'Node.js 环境', desc: 'JavaScript 运行时', required: true,
    items: [
      {
        id: 'node', label: 'Node.js', desc: '内建运行时（不可卸载）', kind: 'builtin',
        probe: [path.join(BIN, 'node'), '-v'], required: true, estMb: 0,
      },
      {
        id: 'pnpm', label: 'PNPM', desc: '引擎自带的包管理器', kind: 'builtin',
        probe: [path.join(BIN, 'pnpm'), '-v'], required: true, estMb: 0,
      },
    ],
  },
  {
    id: 'python', label: 'Python 环境', desc: 'Python 开发环境',
    items: [
      {
        id: 'python.core', label: 'Python', desc: '解释器（会连带 llvm/clang）', kind: 'apt',
        pkgs: ['python'], probe: [path.join(BIN, 'python3'), '-V'], estMb: 690,
      },
      {
        id: 'python.link', label: 'Python 链接', desc: '把 python 命令链接到 python3', kind: 'link',
        link: { name: 'python', target: 'python3' }, probe: [path.join(BIN, 'python'), '-V'], estMb: 0,
      },
      {
        id: 'python.venv', label: '虚拟环境', desc: 'venv + ensurepip', kind: 'check',
        cmd: [path.join(BIN, 'python3'), '-c', 'import venv, ensurepip; print("ok")'],
        requires: ['python.core'], estMb: 0,
      },
      {
        id: 'python.pip', label: 'Pip', desc: 'Python 包管理器', kind: 'check',
        cmd: [path.join(BIN, 'pip'), '--version'], requires: ['python.core'], estMb: 0,
      },
      {
        id: 'python.uv', label: 'uv', desc: 'Rust 写的极速 Python 安装器（apt 包）', kind: 'apt',
        pkgs: ['uv'], probe: [path.join(BIN, 'uv'), '--version'], requires: ['python.core'], estMb: 40,
      },
    ],
  },
  {
    id: 'ssh', label: 'SSH 工具', desc: 'SSH 客户端与服务端',
    items: [
      {
        id: 'ssh.client', label: 'SSH 客户端', desc: 'ssh / scp / sftp', kind: 'apt',
        pkgs: ['openssh'], probe: [path.join(BIN, 'ssh'), '-V'], estMb: 12,
      },
      {
        id: 'ssh.sshpass', label: 'sshpass', desc: '密码认证（免交互）', kind: 'apt',
        pkgs: ['sshpass'], probe: [path.join(BIN, 'sshpass'), '-V'], estMb: 1,
      },
      {
        id: 'ssh.sshd', label: 'OpenSSH 服务器', desc: 'sshd，供反向隧道', kind: 'check',
        cmd: [path.join(BIN, 'sshd'), '-V'], requires: ['ssh.client'], estMb: 0,
      },
    ],
  },
  {
    id: 'java', label: 'Java 环境', desc: 'Java 开发环境',
    items: [
      {
        id: 'java.jdk', label: 'OpenJDK 17', desc: 'Java 17 开发环境', kind: 'apt',
        pkgs: ['openjdk-17'], probe: [path.join(BIN, 'java'), '-version'], estMb: 400,
      },
      {
        id: 'java.gradle', label: 'Gradle', desc: '构建自动化工具（apt 包）', kind: 'apt',
        pkgs: ['gradle'], probe: [path.join(BIN, 'gradle'), '-v'], requires: ['java.jdk'], estMb: 260,
      },
    ],
  },
  {
    id: 'rust', label: 'Rust (Cargo) 环境', desc: 'Rust 开发环境和包管理器',
    items: [
      {
        id: 'rust.apt', label: 'Rust & Cargo', desc: 'apt 版工具链', kind: 'apt',
        pkgs: ['rust'], probe: [path.join(BIN, 'rustc'), '--version'], estMb: 1100,
      },
      {
        id: 'rust.rustup', label: 'rustup 工具链', desc: '官方 rustup（实验，Termux 无二进制包）', kind: 'custom',
        custom: 'rustup',
        probe: [path.join(HOME, '.cargo/bin/rustup'), '-V'], estMb: 1000,
      },
    ],
  },
  {
    id: 'go', label: 'Go 环境', desc: 'Go 语言开发环境',
    items: [
      {
        id: 'go.apt', label: 'Go', desc: 'Go 编程语言', kind: 'apt',
        pkgs: ['golang'], probe: [path.join(BIN, 'go'), 'version'], estMb: 200,
      },
    ],
  },
];

const ITEM = new Map();
for (const g of GROUPS) for (const it of g.items) ITEM.set(it.id, { ...it, group: g.id });

// ── 基础工具 ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runSync(cmd, args, timeout = 120000) {
  const r = spawnSync(cmd, args, { env: ENV, encoding: 'utf8', timeout });
  return { code: r.status ?? -1, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

/** 跑一条命令，逐行回调（apt 的进度就靠它）。 */
function runStream(cmd, args, onLine, timeout = 1800000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const feed = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      if (onLine) for (const line of text.split('\n')) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out: tail }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.message) }); });
  });
}

function log(...a) { console.log(...a); }

// ── 状态（v2 + v1 迁移）─────────────────────────────────────────────────────
function readStateRaw() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function readState() {
  const raw = readStateRaw();
  if (raw && raw.version === 2 && raw.items) return raw;
  // v1：{ python: {pkgs:[...]}, go: {...} }  →  按新 item id 映射
  const legacyMap = {
    python: 'python.core', ssh: 'ssh.client', java: 'java.jdk',
    rust: 'rust.apt', go: 'go.apt',
  };
  const items = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const id = legacyMap[k] || k;
    if (v && Array.isArray(v.pkgs)) items[id] = { ...v, adopted: false };
  }
  return { version: 2, items };
}

function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, items: s.items }, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── 探测 ─────────────────────────────────────────────────────────────────────
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function probeOf(item) {
  if (item.kind === 'link') {
    const p = path.join(BIN, item.link.name);
    try {
      const st = fs.lstatSync(p);
      return { ok: st.isSymbolicLink() || st.isFile(), version: st.isSymbolicLink() ? 'link' : 'file' };
    } catch { return { ok: false, version: null }; }
  }
  if (item.kind === 'check') {
    const r = runSync(item.cmd[0], item.cmd.slice(1), 20000);
    return { ok: r.code === 0, version: r.code === 0 ? 'ok' : null };
  }
  if (item.kind === 'builtin') {
    if (!fileExists(item.probe[0])) return { ok: false, version: null };
    const r = runSync(item.probe[0], item.probe.slice(1), 15000);
    return { ok: r.code === 0, version: (r.out.split('\n')[0] || '').trim() };
  }
  // apt / pip / custom 都靠可执行文件探测
  if (!fileExists(item.probe[0])) return { ok: false, version: null };
  const r = runSync(item.probe[0], item.probe.slice(1), 20000);
  if (r.code !== 0) return { ok: false, version: null };
  return { ok: true, version: normalizeVersion(item, r.out.split('\n')[0] || '') };
}

function normalizeVersion(item, line) {
  const s = (line || '').trim();
  if (item.id === 'java.jdk') { const m = s.match(/version "([^"]+)"/); return m ? m[1] : s; }
  if (item.id === 'ssh.client') { const m = s.match(/OpenSSH[_\s]([^\s,]+)/); return m ? m[1] : s; }
  if (item.id === 'python.core' || item.id === 'python.link') { const m = s.match(/Python\s+([\w.]+)/); return m ? m[1] : s; }
  if (item.id === 'go.apt') return s.replace(/^go version\s+/, '').split(' ')[0];
  if (item.id === 'node') return s.replace(/^v/, 'v');
  return s.slice(0, 60);
}

// ── dpkg 快照与体积 ──────────────────────────────────────────────────────────
function dpkgSnapshot() {
  const r = runSync('dpkg-query', ['-W', '-f=${Package}\t${Installed-Size}\n'], 60000);
  const map = new Map();
  for (const line of (r.out || '').split('\n')) {
    const [name, kb] = line.split('\t');
    if (name) map.set(name.trim(), Number(kb || 0));
  }
  return map;
}

function sizeOf(item, state, snap) {
  const st = state.items[item.id];
  if (!st) return null;
  let kb = 0;
  for (const p of st.pkgs || []) kb += snap.get(p) || 0;
  if (st.dirs) for (const d of st.dirs) {
    const r = runSync('du', ['-sk', d], 60000);
    kb += Number((r.out.split(/\s+/)[0] || '0')) || 0;
  }
  return kb ? Math.round(kb / 1024) : 0;
}

// ── 安装器 ───────────────────────────────────────────────────────────────────
async function installApt(item, state, say) {
  const before = dpkgSnapshot();
  await ensureAptIndex(say);
  say(`apt-get install -y ${item.pkgs.join(' ')}`);
  const r = await runStream('apt-get', ['install', '-y', ...item.pkgs], say);
  if (r.code !== 0) throw new Error(`apt 安装失败（exit ${r.code}）`);
  const after = dpkgSnapshot();
  const added = [...after.keys()].filter((p) => !before.has(p));
  const pr = probeOf(item);
  if (!pr.ok) throw new Error('装完了但探测不到可执行文件');
  return { pkgs: added, version: pr.version };
}

async function installPip(item, state, say) {
  const py = path.join(BIN, 'python3');
  if (!fileExists(py)) throw new Error('需要先安装 Python');
  say(`pip install ${item.pipPkg}`);
  const r = await runStream(py, ['-m', 'pip', 'install', '--no-input', item.pipPkg], say);
  if (r.code !== 0) throw new Error(`pip 安装失败（exit ${r.code}）`);
  const pr = probeOf(item);
  if (!pr.ok) throw new Error('pip 装完了但找不到可执行文件（可能需要 PATH 刷新）');
  return { pipPkgs: [item.pipPkg], dirs: [path.join(HOME, '.local/bin')], version: pr.version };
}

async function installLink(item, state, say) {
  const target = path.join(BIN, item.link.target);
  const link = path.join(BIN, item.link.name);
  if (!fileExists(target)) throw new Error(`目标不存在：${item.link.target}`);
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(item.link.target, link);
  say(`${item.link.name} -> ${item.link.target}`);
  return { links: [`${link} -> ${item.link.target}`], version: 'link' };
}

async function installCheck(item, state, say) {
  // check 项本身不装东西：依赖项装好它就成立
  const pr = probeOf(item);
  if (pr.ok) return { version: 'ok' };
  if (item.requires) {
    say(`依赖 ${item.requires.join(', ')} 未就绪`);
  }
  throw new Error('能力自检未通过（依赖未安装或该内核不支持）');
}

async function installCustom(item, state, say) {
  if (item.custom === 'gradle') return installGradle(item, say);
  if (item.custom === 'rustup') return installRustup(item, say);
  throw new Error(`未知的自定义安装器：${item.custom}`);
}

async function installGradle(item, say) {
  const VER = '8.10.2';
  const dest = path.join(PREFIX, 'opt', 'gradle');
  const zip = path.join(PREFIX, 'tmp', `gradle-${VER}-bin.zip`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  say(`下载 Gradle ${VER}`);
  const r = await runStream(path.join(BIN, 'curl'), [
    '-L', '--retry', '3', '-m', '900', '-o', zip,
    `https://services.gradle.org/distributions/gradle-${VER}-bin.zip`,
  ], say, 1200000);
  if (r.code !== 0) throw new Error('Gradle 下载失败');
  say('解压');
  const u = await runStream(path.join(BIN, 'unzip'), ['-oq', zip, '-d', path.join(PREFIX, 'opt')], say);
  if (u.code !== 0) throw new Error('Gradle 解压失败');
  const extracted = path.join(PREFIX, 'opt', `gradle-${VER}`);
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
  fs.renameSync(extracted, dest);
  try { fs.unlinkSync(path.join(BIN, 'gradle')); } catch {}
  fs.symlinkSync(path.join(dest, 'bin/gradle'), path.join(BIN, 'gradle'));
  try { fs.unlinkSync(zip); } catch {}
  const pr = probeOf(item);
  return { dirs: [dest], links: [`${path.join(BIN, 'gradle')} -> ${path.join(dest, 'bin/gradle')}`], version: pr.version };
}

async function installRustup(item, say) {
  say('安装 rustup（写入 $HOME/.cargo）');
  const r = await runStream(path.join(BIN, 'curl'), [
    '-sSf', 'https://sh.rustup.rs', '-o', path.join(PREFIX, 'tmp/rustup-init.sh'),
  ], say, 300000);
  if (r.code !== 0) throw new Error('下载 rustup-init 失败');
  const sh = await runStream(path.join(BIN, 'bash'), [
    path.join(PREFIX, 'tmp/rustup-init.sh'), '-y', '--no-modify-path',
  ], say, 1800000);
  if (sh.code !== 0) throw new Error('rustup 安装失败');
  const pr = probeOf(item);
  return { dirs: [path.join(HOME, '.rustup'), path.join(HOME, '.cargo')], version: pr.version };
}

async function installItem(item, state, say) {
  if (item.required) throw new Error('该项为必需项，不可安装/卸载');
  if (item.requires) {
    for (const dep of item.requires) {
      const d = ITEM.get(dep);
      if (d && !probeOf(d).ok) throw new Error(`需要先安装 ${d.label}`);
    }
  }
  switch (item.kind) {
    case 'apt': return installApt(item, state, say);
    case 'pip': return installPip(item, state, say);
    case 'link': return installLink(item, state, say);
    case 'check': return installCheck(item, state, say);
    case 'custom': return installCustom(item, state, say);
    default: throw new Error(`不可安装的项：${item.kind}`);
  }
}

// ── 卸载器 ───────────────────────────────────────────────────────────────────
function isProtected(pkg) {
  return PROTECTED.some((p) => pkg === p || pkg.startsWith(`${p}-`) || pkg.startsWith(`${p}+`) ||
    (p.startsWith('lib') && pkg.startsWith(p)));
}

async function removeItem(item, state, say) {
  if (item.required) throw new Error('该项为必需项，不可卸载');
  const st = state.items[item.id];
  const kind = item.kind;

  if (kind === 'link') {
    try { fs.unlinkSync(path.join(BIN, item.link.name)); } catch {}
    return;
  }
  if (kind === 'check' || kind === 'builtin') {
    throw new Error('该项由依赖包提供，请卸载它的依赖项');
  }
  if (kind === 'pip') {
    const py = path.join(BIN, 'python3');
    if (fileExists(py)) await runStream(py, ['-m', 'pip', 'uninstall', '-y', item.pipPkg], say, 300000);
    return;
  }
  if (kind === 'custom') {
    for (const l of st?.links || []) {
      const p = l.split(' -> ')[0];
      try { fs.unlinkSync(p); } catch {}
    }
    for (const d of st?.dirs || []) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    return;
  }

  // apt：差分回滚 + 共享依赖保护 + 保护名单
  const keep = new Set();
  for (const [id, s] of Object.entries(state.items)) {
    if (id === item.id) continue;
    for (const p of s.pkgs || []) keep.add(p);
  }
  // ⚠️ 没有 state 记录也要能卸：手动 apt 装的项（未纳管）按**声明包名**兜底，
  //   否则用户在界面上点卸载会得到「没有可删的包」，而东西明明还在。
  const owned = (st && Array.isArray(st.pkgs) && st.pkgs.length) ? st.pkgs : (item.pkgs || []);
  if (!st) say('该项未纳管，按声明包名卸载');
  const del = [];
  for (const p of owned) {
    if (keep.has(p) || isProtected(p)) continue;
    del.push(p);
  }
  if (del.length === 0) { say('没有可删的包（可能从未由本工具安装）'); return; }
  say(`apt-get remove --purge -y ${del.join(' ')}`);
  const r = await runStream('apt-get', ['remove', '--purge', '-y', ...del], say);
  if (r.code !== 0) throw new Error('apt 卸载失败');
  await runStream('apt-get', ['autoremove', '--purge', '-y'], say, 900000);

  // ⚠️ 幽灵文件：apt 在“解包完但还没写库”时被中断（例如上一条命令被 SIGPIPE 打死），
  //   dpkg 里没有记录、二进制却还在。此时 apt 会说 “not installed, so not removed”，
  //   而界面上这一项仍是 ✅。这里补一刀：探测仍通过就删掉它的可执行文件。
  if (probeOf(item).ok) {
    const bin = item.probe && item.probe[0];
    if (bin && bin.startsWith(BIN)) {
      try { fs.unlinkSync(bin); say(`删除残留可执行文件 ${bin}`); } catch {}
    }
  }
}

// ── apt 索引（一次任务只 update 一次）────────────────────────────────────────
let aptIndexReady = false;
async function ensureAptIndex(say) {
  if (aptIndexReady) return;
  say('apt-get update');
  await runStream('apt-get', ['update', '-y'], say, 300000);
  aptIndexReady = true;
}

// ── 状态汇总 ─────────────────────────────────────────────────────────────────
function statusData() {
  const state = readState();
  const snap = dpkgSnapshot();
  const builtin = {};
  for (const g of GROUPS) {
    for (const it of g.items) {
      if (it.kind === 'builtin') {
        const pr = probeOf(it);
        builtin[it.id] = pr.ok ? pr.version : null;
      }
    }
  }

  const groups = GROUPS.map((g) => {
    const items = g.items.map((it) => {
      const pr = probeOf(it);
      const st = state.items[it.id];
      return {
        id: it.id,
        label: it.label,
        desc: it.desc,
        required: Boolean(it.required),
        kind: it.kind,
        installed: pr.ok,
        version: pr.version,
        estMb: it.estMb || 0,
        sizeMb: pr.ok ? sizeOf(it, state, snap) : null,
        tracked: Boolean(st),
        adopted: Boolean(st && st.adopted),
        requires: it.requires || [],
      };
    });
    const installed = items.filter((i) => i.installed).length;
    return {
      id: g.id,
      label: g.label,
      desc: g.desc,
      required: Boolean(g.required),
      items,
      installedCount: installed,
      totalCount: items.length,
      state: installed === items.length ? 'installed' : (installed === 0 ? 'none' : 'partial'),
    };
  });

  const df = runSync('df', ['-k', FILES], 20000);
  const last = (df.out || '').trim().split('\n').pop() || '';
  const parts = last.split(/\s+/);
  const freeMb = parts.length >= 4 ? Math.round(Number(parts[3]) / 1024) : null;

  return {
    version: 2,
    prefix: PREFIX,
    stateFile: STATE_FILE,
    builtin,
    totalMb: dirSizeMb(FILES),
    freeMb,
    protectedList: PROTECTED,
    groups,
  };
}

function dirSizeMb(p) {
  const r = runSync('du', ['-sk', p], 60000);
  return Math.round(Number((r.out.split(/\s+/)[0] || '0')) / 1024) || 0;
}

function printStatus() {
  const d = statusData();
  log('── DSH 开发环境（分组）──────────────────────');
  log(`PREFIX = ${d.prefix}`);
  log(`占用   = ${d.totalMb} MB` + (d.freeMb != null ? `   可用 = ${d.freeMb} MB` : ''));
  for (const g of d.groups) {
    log('');
    log(`【${g.label}】 ${g.installedCount}/${g.totalCount}` + (g.required ? '  （必需）' : ''));
    for (const it of g.items) {
      const mark = it.installed ? '✅' : '❌';
      const tail = it.installed
        ? `${it.version}${it.sizeMb ? `  ${it.sizeMb} MB` : ''}${it.tracked ? '' : '  未纳管'}`
        : `未安装  ~${it.estMb} MB`;
      log(`  ${mark} ${it.label.padEnd(16)} ${tail}`);
    }
  }
}

// ── 目标解析：item id / group:<id> / all ─────────────────────────────────────
function resolveTargets(list) {
  const out = [];
  for (const raw of list) {
    if (raw === 'all') { out.push(...ITEM.keys()); continue; }
    if (raw.startsWith('group:')) {
      const g = GROUPS.find((x) => x.id === raw.slice(6));
      if (!g) throw new Error(`不认识的组：${raw}`);
      out.push(...g.items.map((i) => i.id));
      continue;
    }
    if (!ITEM.has(raw)) throw new Error(`不认识的项：${raw}`);
    out.push(raw);
  }
  return [...new Set(out)];
}

// ── 调度：apt 串行，其余并行（对应 UI 的“支持并行安装”）──────────────────────
async function runTasks(ids, action) {
  const state = readState();
  const aptQueue = [];
  const fastQueue = [];
  for (const id of ids) {
    const it = ITEM.get(id);
    (it.kind === 'apt' ? aptQueue : fastQueue).push(it);
  }
  const say = (m) => log(`  ${m}`);

  const runOne = async (it) => {
    log(`→ ${action === 'install' ? '安装' : '卸载'} ${it.label}`);
    try {
      if (action === 'install') {
        const rec = await installItem(it, state, say);
        const prev = state.items[it.id] || {};
        state.items[it.id] = { ...prev, ...rec, installedAt: new Date().toISOString(), adopted: false };
      } else {
        await removeItem(it, state, say);
        delete state.items[it.id];
      }
      writeState(state);
      log(`  ✅ ${it.label} 完成`);
      return { id: it.id, ok: true };
    } catch (e) {
      log(`  ✗ ${it.label} 失败：${e.message}`);
      return { id: it.id, ok: false, error: e.message };
    }
  };

  const results = [];
  const aptLoop = (async () => { for (const it of aptQueue) results.push(await runOne(it)); })();
  const fastLoop = Promise.all(fastQueue.map(async (it) => results.push(await runOne(it))));
  await Promise.all([aptLoop, fastLoop]);
  return results;
}

// ── adopt：把“手动 apt 装的”纳入记录 ─────────────────────────────────────────
function adoptAll() {
  const state = readState();
  let n = 0;
  for (const it of ITEM.values()) {
    if (it.kind !== 'apt') continue;
    if (state.items[it.id]) continue;
    if (!probeOf(it).ok) continue;
    state.items[it.id] = {
      pkgs: [...it.pkgs], adopted: true,
      installedAt: new Date().toISOString(), version: probeOf(it).version,
    };
    n++;
  }
  if (n) writeState(state);
  return n;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
const [cmd = 'status', ...rest] = process.argv.slice(2);
const asJson = rest.includes('--json');

try {
  switch (cmd) {
    case 'status':
      if (asJson) console.log(JSON.stringify(statusData()));
      else printStatus();
      break;

    case 'install':
    case 'remove': {
      const targets = resolveTargets(rest.filter((x) => !x.startsWith('--')));
      if (targets.length === 0) throw new Error('没有指定目标');
      const results = await runTasks(targets, cmd);
      const failed = results.filter((r) => !r.ok);
      printStatus();
      if (failed.length) {
        log(`\n✗ ${failed.length} 项失败：` + failed.map((f) => f.id).join(', '));
        process.exitCode = 1;
      }
      break;
    }

    case 'reset': {
      const ids = [...ITEM.values()].filter((i) => !i.required && probeOf(i).ok).map((i) => i.id);
      if (ids.length === 0) { log('已经是最小环境'); break; }
      await runTasks(ids, 'remove');
      printStatus();
      break;
    }

    case 'adopt': {
      const n = adoptAll();
      log(`已纳管 ${n} 项`);
      printStatus();
      break;
    }

    case 'verify': {
      const id = rest[0];
      const it = ITEM.get(id);
      if (!it) throw new Error(`不认识的项：${id}`);
      const pr = probeOf(it);
      console.log(JSON.stringify({ id, ...pr }));
      process.exitCode = pr.ok ? 0 : 1;
      break;
    }

    default:
      throw new Error(`用法: dsh-env.mjs [status [--json]|install <id...>|remove <id...>|reset|adopt|verify <id>]`);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(2);
}