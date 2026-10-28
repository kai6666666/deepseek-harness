#!/data/data/com.dsh.android/files/termux/usr/bin/node
// ─────────────────────────────────────────────────────────────────────────────
// check-devenv.mjs —— 按 docs/agents/verification.md ⑤ 的四条判据自动验收
//
// 用法（设备上，app 身份）：
//   node files/check-devenv.mjs
//
// 判据：
//   1. groups.length == 6，且每组 installedCount ≤ totalCount
//   2. 每个 unsupported 项必须 installed:false（rustup 的 ~/.cargo 残留不算）
//   3. 已装项的版本字符串非空（能读到版本才算真的可用）
//   4. 可选：传入 --expect python=5/5 之类的期望值做精确断言
//
// 退出码：0 全过；1 有断言失败。
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const FILES = process.env.DSH_FILES || '/data/user/0/com.dsh.android/files';
const SCRIPT = path.join(FILES, 'dsh-env.mjs');
const NODE = path.join(FILES, 'termux/usr/bin/node');

const r = spawnSync(NODE, [SCRIPT, 'status', '--json'], { encoding: 'utf8', timeout: 60000 });
if (r.status !== 0) {
  console.error('✗ status 调用失败：', (r.stderr || '').slice(0, 300));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(r.stdout);
} catch (e) {
  console.error('✗ status 输出不是合法 JSON');
  process.exit(1);
}

const fails = [];
const lines = [];
const groups = data.groups || [];

// ① 六组 + 计数范围
if (groups.length !== 6) fails.push(`groups.length=${groups.length}（期望 6）`);
for (const g of groups) {
  if (!(g.installedCount <= g.totalCount)) {
    fails.push(`${g.id}: installedCount ${g.installedCount} > totalCount ${g.totalCount}`);
  }
  lines.push(`${g.id.padEnd(7)} ${g.installedCount}/${g.totalCount}`);
}

// ② unsupported 必须 installed:false
const flat = groups.flatMap((g) => g.items || []);
for (const it of flat) {
  if (it.unsupported && it.installed) fails.push(`${it.id}: unsupported 但 installed=true`);
}

// ③ 已装项版本非空
for (const it of flat) {
  if (it.installed && !it.unsupported && !it.version) fails.push(`${it.id}: installed=true 但 version 为空`);
}

// ④ --expect group=installed/total
for (const arg of process.argv.slice(2)) {
  const m = /^--expect=([a-z]+)=(\d+)\/(\d+)$/.exec(arg);
  if (!m) continue;
  const [, id, got, want] = m;
  const g = groups.find((x) => x.id === id);
  if (!g) { fails.push(`expect: 没有组 ${id}`); continue; }
  if (`${g.installedCount}/${g.totalCount}` !== `${got}/${want}`) {
    fails.push(`${id}: 期望 ${got}/${want}，实际 ${g.installedCount}/${g.totalCount}`);
  }
}

console.log('── 开发环境验收（verification ⑤）──');
console.log(lines.join('\n'));
console.log(`unsupported: ${flat.filter((i) => i.unsupported).map((i) => i.id).join(', ') || '（无）'}`);
console.log(`占用: ${data.totalMb} MB`);

if (fails.length === 0) {
  console.log('✅ 四条判据全部通过');
  process.exit(0);
}
console.log('✗ 失败项：');
for (const f of fails) console.log('  - ' + f);
process.exit(1);