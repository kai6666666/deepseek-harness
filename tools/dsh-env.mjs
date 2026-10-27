#!/data/data/com.dsh.android/files/termux/usr/bin/node
// ─────────────────────────────────────────────────────────────────────────────
// dsh-env.mjs —— DSH 开发环境：体检 / 安装 / 卸载（六项，含差分回滚）
//
// 设计要点（对应 docs/agents/dev-env.md 的规则）：
//   1. **必装项永不参与卸载**：bootstrap 底座、四个核心库、node 运行时、引擎资产。
//   2. **卸载按差分回滚**：安装前后各取一次 `dpkg-query -W` 快照，只回滚「这次多出来的包」。
//      `apt-get remove python` 那种做法会留下 llvm/clang 等 600 MB 垃圾。
//   3. **共享依赖不误删**：`openssl` 同时被 ssh 与 rust 需要；只要还有别的可选项在用，
//      就把它从删除集合里摘掉。
//   4. **保护名单硬拦**：命中的包即使出现在差分里也不删，并明确报出原因。
//
// 用法（app 身份）：
//   node files/dsh-env.mjs status [--json]
//   node files/dsh-env.mjs install <id>...        # id ∈ python|ssh|java|rust|go|all
//   node files/dsh-env.mjs remove  <id>...        # 只删「我装的那批」，保护名单跳过
//   node files/dsh-env.mjs verify  <id>
//   node files/dsh-env.mjs reset                  # 回到最小环境：卸掉全部可选项
//
// 状态文件：$FILES/env-state.json（每个可选项装了哪些包、何时装、验过的版本）
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FILES = process.env.DSH_FILES || '/data/user/0/com.dsh.android/files';
const PREFIX = process.env.PREFIX || path.join(FILES, 'termux/usr');
const STATE_FILE = path.join(FILES, 'env-state.json');
const APT_ENV = {
  ...process.env,
  PREFIX,
  HOME: process.env.HOME || path.join(FILES, 'termux/home'),
  TMPDIR: path.join(PREFIX, 'tmp'),
  PATH: `${path.join(PREFIX, 'bin')}:${process.env.PATH || '/system/bin:/system/xbin'}`,
  LD_LIBRARY_PATH: `${path.join(PREFIX, 'lib')}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`,
};

// ── 保护名单：任何卸载路径都不许碰 ────────────────────────────────────────────
// 依据见 docs/agents/dev-env.md：bootstrap 底座 + 引擎四模块依赖的四个 so + node。
const PROTECTED = [
  'bash', 'coreutils', 'dash', 'dpkg', 'apt', 'libapt',
  'zlib', 'openssl', 'libcrypto', 'libssl', 'libandroid-support',
  'libc++', 'libc++_shared', 'nodejs', 'nodejs-lts',
];

// ── 可选项清单 ───────────────────────────────────────────────────────────────
const ITEMS = [
  {
    id: 'python', label: 'Python 环境', apt: ['python'],
    bins: [['python3', ['-V']], ['pip', ['--version']]],
    // Termux 的 python 依赖 llvm/clang，装卸都要带上；给 UI 一个体积预估
    estMb: 690,
  },
  {
    id: 'ssh', label: 'SSH 工具', apt: ['openssh'],
    bins: [['ssh', ['-V']]],
    estMb: 12,
  },
  {
    id: 'java', label: 'Java 环境', apt: ['openjdk-17'],
    bins: [['java', ['-version']]],
    estMb: 400,
  },
  {
    id: 'rust', label: 'Rust(Cargo) 环境', apt: ['rust'],
    bins: [['rustc', ['--version']], ['cargo', ['--version']]],
    estMb: 1100,
  },
  {
    id: 'go', label: 'Go 环境', apt: ['golang'],
    bins: [['go', ['version']]],
    estMb: 200,
  },
];

const BIDI = { python: 'python3', ssh: 'ssh', java: 'java', rust: 'rustc', go: 'go' };

// ── 小工具 ───────────────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { env: APT_ENV, encoding: 'utf8', timeout: opts.timeout || 120000 });
  return { code: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}
function log(...a) { console.log(...a); }
function die(msg, code = 1) { console.error(`✗ ${msg}`); process.exit(code); }

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/** 当前已安装的包集合（名字 → Installed-Size KB）。 */
function dpkgSnapshot() {
  const r = run('dpkg-query', ['-W', '-f=${Package}\t${Installed-Size}\n']);
  const map = new Map();
  if (r.code !== 0 && !r.out) return map;
  for (const line of r.out.split('\n')) {
    const [name, kb] = line.split('\t');
    if (!name) continue;
    map.set(name.trim(), Number(kb || 0));
  }
  return map;
}

/** 跑一项的版本探测，返回 {ok, version}。 */
function probe(item) {
  for (const [bin, args] of item.bins) {
    const p = path.join(PREFIX, 'bin', bin);
    if (!fs.existsSync(p)) return { ok: false, version: null, missing: bin };
    const r = run(p, args, { timeout: 20000 });
    const text = (r.out || '').trim().split('\n')[0] || '';
    if (!text) return { ok: false, version: null, missing: bin };
    // 简单归一：不同工具的输出格式差异只取有信息的一行
    if (item.id === 'java') {
      const m = text.match(/version "([^"]+)"/);
      return { ok: true, version: m ? m[1] : text };
    }
    if (item.id === 'ssh') return { ok: true, version: (text.match(/OpenSSH[_\s]([^\s,]+)/) || [, text])[1] };
    if (item.id === 'python') return { ok: true, version: (text.match(/Python\s+([\w.]+)/) || [, text])[1] };
    if (item.id === 'go') return { ok: true, version: text.replace(/^go version\s+/, '').split(' ')[0] };
    return { ok: true, version: text };
  }
  return { ok: false, version: null };
}

/** 该项「已装包」的真实占用（KB）。state 里有记录就按记录算，否则按 apt 依赖闭包粗估。 */
function installedKb(item, state, snap) {
  const st = state[item.id];
  if (!st?.pkgs?.length) return 0;
  let kb = 0;
  for (const p of st.pkgs) kb += snap.get(p) || 0;
  return kb;
}

function isProtected(pkg) {
  return PROTECTED.some((p) => pkg === p || pkg.startsWith(`${p}-`) || pkg.startsWith(`${p}+`) ||
    (p.startsWith('lib') && pkg.startsWith(p)));
}

function statusData() {
  const state = readState();
  const snap = dpkgSnapshot();
  const items = ITEMS.map((item) => {
    const pr = probe(item);
    const kb = installedKb(item, state, snap);
    return {
      id: item.id,
      label: item.label,
      installed: pr.ok,
      version: pr.version,
      missingBin: pr.missing || null,
      // 只有本工具装过的项才有精确差分占用；手动 apt 装的标 tracked:false，
      // 由 UI 显示「未纳管」而不是编一个体积出来。
      sizeMb: kb ? Math.round(kb / 1024) : null,
      estMb: item.estMb,
      tracked: Boolean(state[item.id]),
      packages: state[item.id]?.pkgs || [],
      installedAt: state[item.id]?.installedAt || null,
    };
  });
  const df = run('df', ['-k', FILES]);
  const lastLine = df.out.trim().split('\n').pop() || '';
  const parts = lastLine.split(/\s+/);
  const freeMb = parts.length >= 4 ? Math.round(Number(parts[3]) / 1024) : null;
  return {
    prefix: PREFIX,
    stateFile: STATE_FILE,
    // 内建运行时（必需项）：设置页第一行要显示它，且不给「卸载」按钮。
    builtin: { node: builtinVersion() },
    totalMb: dirSizeMb(FILES),
    freeMb,
    protectedList: PROTECTED,
    items,
  };
}

/** 内建 node 的版本（`v26.12.1` → `v26.12.1`）；没有就返回 null。 */
function builtinVersion() {
  const bin = path.join(PREFIX, 'bin', 'node');
  if (!fs.existsSync(bin)) return null;
  const r = run(bin, ['-v'], { timeout: 15000 });
  const v = (r.out || '').trim();
  return v || null;
}

function dirSizeMb(p) {
  const r = run('du', ['-sk', p], { timeout: 60000 });
  const kb = Number((r.out.trim().split(/\s+/)[0] || '0'));
  return kb ? Math.round(kb / 1024) : 0;
}

function printStatus() {
  const d = statusData();
  log('── DSH 开发环境 ─────────────────────────────');
  log(`PREFIX = ${d.prefix}`);
  log(`占用   = ${d.totalMb} MB` + (d.freeMb != null ? `   可用 = ${d.freeMb} MB` : ''));
  log('');
  for (const it of d.items) {
    const mark = it.installed ? '✅' : '❌';
    const tail = it.installed
      ? `${it.version}  ${it.sizeMb ? it.sizeMb + ' MB' : '未纳管'}`
      : `未安装  ~${it.estMb} MB`;
    log(`${it.label.padEnd(18)} ${mark} ${tail}`);
  }
  log('');
  log('必需项（不可卸载）：Node 运行时 / bootstrap 底座 / 引擎四模块');
}

// ── 安装 ─────────────────────────────────────────────────────────────────────
function doInstall(ids) {
  const state = readState();
  const targets = [];
  for (const id of ids) {
    if (id === 'all') { targets.push(...ITEMS.map((i) => i.id)); continue; }
    const item = ITEMS.find((i) => i.id === id);
    if (!item) die(`不认识的目标: ${id}（可用: ${ITEMS.map((i) => i.id).join('|')}|all）`, 2);
    if (!targets.includes(id)) targets.push(id);
  }

  const before = dpkgSnapshot();
  log('→ apt-get update');
  log(run('apt-get', ['update', '-y'], { timeout: 300000 }).out.trim().split('\n').slice(-2).join('\n'));

  for (const id of targets) {
    const item = ITEMS.find((i) => i.id === id);
    const pr = probe(item);
    if (pr.ok) { log(`· ${item.label} 已安装（${pr.version}），跳过`); continue; }

    log(`→ 安装 ${item.label}（${item.apt.join(', ')}）`);
    const r = run('apt-get', ['install', '-y', ...item.apt], { timeout: 1800000 });
    const tail = r.out.trim().split('\n').slice(-4).join('\n');
    if (r.code !== 0) { log(tail); die(`安装失败: ${item.label}`); }

    const after = dpkgSnapshot();
    const added = [...after.keys()].filter((p) => !before.has(p));
    const now = probe(item);
    if (!now.ok) { log(tail); die(`装完了但探测不到可执行文件: ${item.id}`); }

    state[id] = {
      pkgs: added,
      installedAt: new Date().toISOString(),
      version: now.version,
    };
    writeState(state);
    log(`  ✅ ${item.label} ${now.version}  （新增 ${added.length} 个包）`);
  }
  printStatus();
}

// ── 卸载 ─────────────────────────────────────────────────────────────────────
function doRemove(ids) {
  const state = readState();
  const targets = [];
  for (const id of ids) {
    if (id === 'all' || id === 'reset') { targets.push(...ITEMS.map((i) => i.id)); continue; }
    if (!ITEMS.find((i) => i.id === id)) die(`不认识的目标: ${id}`, 2);
    if (!targets.includes(id)) targets.push(id);
  }
  if (targets.length === 0) die('没有要卸载的东西', 2);

  // ① 集合：本次要删的包 = 目标项记录的包 − 其它仍保留项也记录的包
  const keep = new Set();
  for (const it of ITEMS) {
    if (targets.includes(it.id)) continue;
    for (const p of state[it.id]?.pkgs || []) keep.add(p);
  }
  const remove = new Set();
  const blocked = [];
  for (const id of targets) {
    for (const p of state[id]?.pkgs || []) {
      if (keep.has(p)) continue;              // 别的项还在用 → 不动
      if (isProtected(p)) { blocked.push(p); continue; }  // 保护名单 → 不动
      remove.add(p);
    }
  }

  if (remove.size === 0) {
    log('· 没有可删的包（可能从未通过本工具安装，或全部被保护/共享）');
    for (const id of targets) delete state[id];
    writeState(state);
    printStatus();
    return;
  }

  log(`→ 将删除 ${remove.size} 个包${blocked.length ? `（跳过受保护 ${blocked.length} 个）` : ''}`);
  const r = run('apt-get', ['remove', '--purge', '-y', ...remove], { timeout: 1800000 });
  log(r.out.trim().split('\n').slice(-3).join('\n'));
  if (r.code !== 0) die('卸载失败');

  log('→ apt-get autoremove --purge -y（回收无人依赖的包）');
  log(run('apt-get', ['autoremove', '--purge', '-y'], { timeout: 900000 }).out.trim().split('\n').slice(-2).join('\n'));

  for (const id of targets) delete state[id];
  writeState(state);
  printStatus();
}

// ── verify ───────────────────────────────────────────────────────────────────
function doVerify(id) {
  const item = ITEMS.find((i) => i.id === id);
  if (!item) die(`不认识的目标: ${id}`, 2);
  const pr = probe(item);
  console.log(JSON.stringify({ id, ...pr }));
  process.exit(pr.ok ? 0 : 1);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
const [cmd = 'status', ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'status':
    if (rest.includes('--json')) console.log(JSON.stringify(statusData()));
    else printStatus();
    break;
  case 'install':
    if (rest.length === 0) die('用法: install <python|ssh|java|rust|go|all>...', 2);
    doInstall(rest);
    break;
  case 'remove':
  case 'reset':
    doRemove(rest.length ? rest : ['all']);
    break;
  case 'verify':
    doVerify(rest[0]);
    break;
  default:
    die(`用法: dsh-env.mjs [status [--json]|install <id...>|remove <id...>|reset|verify <id>]`, 2);
}