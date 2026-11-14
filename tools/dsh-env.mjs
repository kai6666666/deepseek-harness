#!/usr/local/bin/node
// ─────────────────────────────────────────────────────────────────────────────
// dsh-env.mjs (v2) —— DSH 开发环境：**分组 + 子项** 的体检 / 安装 / 卸载
//
// 0.5.0 起运行在 PRoot Ubuntu 24.04 (glibc) 中，同时保留对旧 Termux 目录的兼容。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const FILES = process.env.DSH_FILES || '/data/user/0/com.dsh.android/files';
const IS_PROOT = process.env.PREFIX === '/usr' || fs.existsSync('/etc/debian_version');
const PREFIX = process.env.PREFIX || (IS_PROOT ? '/usr' : path.join(FILES, 'termux/usr'));
const HOME = process.env.HOME || (IS_PROOT ? '/root' : path.join(FILES, 'termux/home'));
const STATE_FILE = IS_PROOT ? path.join(FILES, 'devenv/env-state.json') : path.join(FILES, 'env-state.json');
const BIN = path.join(PREFIX, 'bin');

function pickBin(...candidates) {
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile() || fs.lstatSync(c).isSymbolicLink()) return c; } catch {}
  }
  return candidates[0];
}

const CA_CRT = '/etc/ssl/certs/ca-certificates.crt';
const ENV = IS_PROOT
  ? {
      ...process.env,
      PREFIX,
      HOME,
      TMPDIR: process.env.TMPDIR || '/tmp',
      DEBIAN_FRONTEND: 'noninteractive',
      PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      ...(fs.existsSync(CA_CRT) ? {
        PIP_CERT: CA_CRT,
        SSL_CERT_FILE: CA_CRT,
        CURL_CA_BUNDLE: CA_CRT,
        REQUESTS_CA_BUNDLE: CA_CRT,
      } : {}),
    }
  : {
      ...process.env,
      PREFIX,
      HOME,
      TMPDIR: path.join(PREFIX, 'tmp'),
      PATH: `${BIN}:${process.env.PATH || '/system/bin:/system/xbin'}`,
      LD_LIBRARY_PATH: `${path.join(PREFIX, 'lib')}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`,
      PIP_CERT: path.join(PREFIX, 'etc/tls/cert.pem'),
      SSL_CERT_FILE: path.join(PREFIX, 'etc/tls/cert.pem'),
      REQUESTS_CA_BUNDLE: path.join(PREFIX, 'etc/tls/cert.pem'),
    };

// ── 保护名单：任何卸载路径都不许碰 ────────────────────────────────────────────
const PROTECTED = [
  'bash', 'coreutils', 'dash', 'dpkg', 'apt', 'libapt', 'base-files', 'base-passwd',
  'libc6', 'libc-bin', 'zlib', 'zlib1g', 'openssl', 'libcrypto', 'libssl', 'ca-certificates',
  'libandroid-support', 'libc++', 'libc++_shared', 'nodejs', 'nodejs-lts',
  'perl-base', 'tar', 'gzip', 'xz-utils', 'ubuntu-keyring',
];

const GROUPS = [
  {
    id: 'nodejs', label: 'Node.js 环境', desc: 'JavaScript 运行时', required: true,
    items: [
      {
        id: 'node', label: 'Node.js', desc: '内建运行时（不可卸载）', kind: 'builtin',
        probe: [pickBin('/usr/local/bin/node', '/usr/bin/node', path.join(BIN, 'node')), '-v'], required: true, estMb: 0,
      },
      {
        id: 'pnpm', label: 'PNPM', desc: '引擎自带的包管理器', kind: 'builtin',
        probe: [pickBin('/usr/local/bin/pnpm', '/usr/bin/pnpm', path.join(BIN, 'pnpm')), '-v'], required: true, estMb: 0,
      },
    ],
  },
  {
    id: 'python', label: 'Python 环境', desc: 'Python 开发环境',
    items: [
      {
        id: 'python.core', label: 'Python', desc: IS_PROOT ? 'Python 3 解释器' : '解释器（会连带 llvm/clang）', kind: 'apt',
        pkgs: [IS_PROOT ? 'python3' : 'python'], probe: [path.join(BIN, 'python3'), '-V'], estMb: IS_PROOT ? 45 : 690,
      },
      {
        id: 'python.link', label: 'Python 链接', desc: '把 python 命令链接到 python3', kind: 'link',
        link: { name: 'python', target: 'python3' }, probe: [path.join(BIN, 'python'), '-V'], estMb: 0,
      },
      IS_PROOT
        ? {
            id: 'python.venv', label: '虚拟环境', desc: 'python3-venv + ensurepip', kind: 'apt',
            pkgs: ['python3-venv'], probe: [path.join(BIN, 'python3'), '-c', 'import venv, ensurepip; print("ok")'],
            requires: ['python.core'], estMb: 12,
          }
        : {
            id: 'python.venv', label: '虚拟环境', desc: 'venv + ensurepip', kind: 'check',
            cmd: [path.join(BIN, 'python3'), '-c', 'import venv, ensurepip; print("ok")'],
            requires: ['python.core'], estMb: 0,
          },
      IS_PROOT
        ? {
            id: 'python.pip', label: 'Pip', desc: 'Python 包管理器 (python3-pip)', kind: 'apt',
            pkgs: ['python3-pip'], probe: [path.join(BIN, 'pip3'), '--version'],
            requires: ['python.core'], estMb: 35,
          }
        : {
            id: 'python.pip', label: 'Pip', desc: 'Python 包管理器', kind: 'check',
            cmd: [path.join(BIN, 'pip'), '--version'], requires: ['python.core'], estMb: 0,
          },
      IS_PROOT
        ? {
            id: 'python.uv', label: 'uv', desc: '极速 Python 包管理器 (pip 安装)', kind: 'pip',
            pipPkg: 'uv', probe: [pickBin('/usr/local/bin/uv', '/root/.local/bin/uv', path.join(BIN, 'uv')), '--version'],
            requires: ['python.pip'], estMb: 30,
          }
        : {
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
        pkgs: [IS_PROOT ? 'openssh-client' : 'openssh'], probe: [path.join(BIN, 'ssh'), '-V'], estMb: 12,
      },
      {
        id: 'ssh.sshpass', label: 'sshpass', desc: '密码认证（免交互）', kind: 'apt',
        pkgs: ['sshpass'], probe: [path.join(BIN, 'sshpass'), '-V'], estMb: 1,
      },
      IS_PROOT
        ? {
            id: 'ssh.sshd', label: 'OpenSSH 服务器', desc: 'openssh-server (sshd)', kind: 'apt',
            pkgs: ['openssh-server'], probe: ['/usr/sbin/sshd', '-V'], requires: ['ssh.client'], estMb: 5,
          }
        : {
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
        pkgs: [IS_PROOT ? 'openjdk-17-jdk' : 'openjdk-17'], probe: [path.join(BIN, 'java'), '-version'], estMb: 400,
      },
      {
        id: 'java.gradle', label: 'Gradle', desc: '构建自动化工具（apt 包）', kind: 'apt',
        pkgs: ['gradle'], probe: [path.join(BIN, 'gradle'), '-v'], requires: ['java.jdk'], estMb: 260,
        cleanupDirs: IS_PROOT ? [] : [path.join(PREFIX, 'opt/gradle')],
      },
    ],
  },
  {
    id: 'rust', label: 'Rust (Cargo) 环境', desc: 'Rust 开发环境和包管理器',
    items: [
      {
        id: 'rust.apt', label: 'Rust & Cargo', desc: 'apt 版工具链', kind: 'apt',
        pkgs: IS_PROOT ? ['rustc', 'cargo'] : ['rust'], probe: [path.join(BIN, 'rustc'), '--version'], estMb: 900,
      },
      {
        id: 'rust.rustup', label: 'rustup 工具链', desc: '保留给手动安装（推荐上方 apt 版 Rust & Cargo）', kind: 'custom',
        custom: 'rustup', unsupported: true,
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
  if (r.code !== 0 && !(item.id === 'ssh.sshd' && /OpenSSH/i.test(r.out))) return { ok: false, version: null };
  // 传**整段输出**：gradle 的第一行是分隔线，版本号在第 3 行。
  return { ok: true, version: normalizeVersion(item, r.out) };
}

function normalizeVersion(item, out) {
  const text = String(out || '');
  const s = (text.split('\n').find((l) => l.trim()) || '').trim();
  if (item.id === 'java.jdk') { const m = s.match(/version "([^"]+)"/); return m ? m[1] : s; }
  if (item.id === 'ssh.client') { const m = s.match(/OpenSSH[_\s]([^\s,]+)/); return m ? m[1] : s; }
  if (item.id === 'python.core' || item.id === 'python.link') { const m = s.match(/Python\s+([\w.]+)/); return m ? m[1] : s; }
  if (item.id === 'go.apt') return s.replace(/^go version\s+/, '').split(' ')[0];
  if (item.id === 'java.gradle') { const m = text.match(/Gradle\s+([\d.]+)/); return m ? m[1] : s.slice(0, 40); }
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
/**
 * 把 `$PREFIX/bin` 里脚本中的 `com.termux` 路径改成本 App 的路径。
 *
 * ⚠️ Termux 的 apt 包把前缀**写死**成 `/data/data/com.termux/files`（wrapper 脚本、
 *   shebang、`gradle` 这类启动器）。我们的包名是 `com.dsh.android`，于是包“装上了”
 *   却在 `$PREFIX/bin` 里找不到可执行文件 —— 真机上 `gradle` 就是这样报
 *   「装完了但探测不到可执行文件」。
 *
 * 只处理 bin 目录下的小文本文件（上限 256 KB），二进制一律跳过。
 */
/**
 * 把 gradle 的启动器指向**发行版自带的那份**。
 *
 * ⚠️ Termux 的 `gradle` 包在 `$PREFIX/bin/gradle` 放了一个 wrapper，它去找
 *   `$PREFIX/lib/gradle-gradle-cli-main-<ver>.jar`，而包里根本没这个 jar
 *   （只有 `$PREFIX/opt/gradle/` 下的完整发行版）→ 真机报
 *   “Unable to access jarfile …/lib/gradle-gradle-cli-main-9.8.2.jar”。
 *   正确做法：直接软链到 `$PREFIX/opt/gradle/bin/gradle`（实测 `gradle -v` 正常）。
 */
function fixGradleLauncher(say) {
  const dist = path.join(PREFIX, 'opt/gradle/bin/gradle');
  if (!fs.existsSync(dist)) return false;
  const link = path.join(BIN, 'gradle');
  try {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(dist, link);
    say('gradle 启动器已指向 opt/gradle/bin/gradle');
    return true;
  } catch { return false; }
}

function fixPrefixShims(say) {
  const mappings = [
    ['/data/data/com.termux/files', FILES],
    ['/data/data/com.termux', path.dirname(FILES)],
  ];
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(BIN);
  } catch { return; }
  for (const name of names) {
    const file = path.join(BIN, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || st.size > 256 * 1024) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes('com.termux')) continue;
    if (text.includes('')) continue; // 二进制
    let next = text;
    for (const [from, to] of mappings) next = next.split(from).join(to);
    if (next === text) continue;
    try { fs.writeFileSync(file, next); fs.chmodSync(file, st.mode); n += 1; } catch {}
  }
  if (n) say(`修正 ${n} 个脚本里的 com.termux 前缀`);
}

async function installApt(item, state, say) {
  const before = dpkgSnapshot();
  await ensureAptIndex(say);
  say(`apt-get install -y ${item.pkgs.join(' ')}`);
  const aptFlags = IS_PROOT ? ['install', '-y', '--no-install-recommends'] : ['install', '-y'];
  const r = await runStream('apt-get', [...aptFlags, ...item.pkgs], say);
  if (r.code !== 0) throw new Error(`apt 安装失败（exit ${r.code}）`);
  const after = dpkgSnapshot();
  const added = [...after.keys()].filter((p) => !before.has(p));
  if (!IS_PROOT) fixPrefixShims(say);
  let pr = probeOf(item);
  // ⚠️ Termux 的 gradle wrapper 找 `$PREFIX/lib/gradle-gradle-cli-main-<ver>.jar`，
  //   而包里实际把它放在 `$PREFIX/opt/gradle/lib/gradle-cli-main-<ver>.jar`
  //   → `gradle -v` 报 “Unable to access jarfile”。补一条软链即可。
  if (!pr.ok && item.id === 'java.gradle') {
    if (fixGradleLauncher(say)) pr = probeOf(item);
  }
  if (!pr.ok) throw new Error('装完了但探测不到可执行文件');
  return { pkgs: added, version: pr.version };
}

async function installPip(item, state, say) {
  const py = path.join(BIN, 'python3');
  if (!fileExists(py)) throw new Error('需要先安装 Python');
  say(`pip install ${item.pipPkg}`);
  const pipArgs = IS_PROOT ? ['-m', 'pip', 'install', '--break-system-packages', '--no-input', item.pipPkg] : ['-m', 'pip', 'install', '--no-input', item.pipPkg];
  const r = await runStream(py, pipArgs, say);
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
  // check 项本身不装东西：但它可以**把依赖装好**（例如 sshd 属于 openssh）。
  if (probeOf(item).ok) return { version: 'ok' };
  for (const dep of item.requires || []) {
    const d = ITEM.get(dep);
    if (!d) continue;
    if (probeOf(d).ok) continue;
    say(`先安装依赖：${d.label}`);
    const rec = await installItem(d, state, say);
    state.items[d.id] = {
      ...(state.items[d.id] || {}), ...rec,
      installedAt: new Date().toISOString(), adopted: false,
    };
    writeState(state);
  }
  const pr = probeOf(item);
  if (pr.ok) return { version: 'ok' };
  throw new Error('能力自检未通过（依赖装上了，但该内核不支持）');
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
  if (item.unsupported) throw new Error('Termux 上不支持该项');
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
    if (fileExists(py)) await runStream(py, IS_PROOT ? ['-m', 'pip', 'uninstall', '--break-system-packages', '-y', item.pipPkg] : ['-m', 'pip', 'uninstall', '-y', item.pipPkg], say, 300000);
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
  // 包自带的数据目录（Termux 的 gradle 是 /opt/gradle）apt 不一定会删干净
  for (const d of item.cleanupDirs || []) {
    try { fs.rmSync(d, { recursive: true, force: true }); say(`清理残留目录 ${d}`); } catch {}
  }

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
      // unsupported 的项即使有残留文件也不算“已安装”（例如 rustup 失败后留下的 ~/.cargo）
      const pr = it.unsupported ? { ok: false, version: null } : probeOf(it);
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
        unsupported: Boolean(it.unsupported),
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

  const DF_PATH = IS_PROOT ? '/' : FILES;
  const df = runSync('df', ['-k', DF_PATH], 20000);
  const last = (df.out || '').trim().split('\n').pop() || '';
  const parts = last.split(/\s+/);
  const freeMb = parts.length >= 4 ? Math.round(Number(parts[3]) / 1024) : null;

  return {
    version: 2,
    prefix: PREFIX,
    stateFile: STATE_FILE,
    builtin,
    totalMb: dirSizeMb(IS_PROOT ? '/usr' : FILES),
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