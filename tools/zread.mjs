#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 读会话存档：session.v4.jsonl.zstd → 挑出 tool/call 与 tool/result
//
// 为什么需要它：设备上没有 `zstd` 命令，`cp` 到 /sdcard 又被 FUSE 权限挡住
// （/sdcard/Android/data/... 不可写）。而 app 自己的 node（含 zlib.zstd*）
// 可以就地解压 —— 这就是唯一能“在设备上审计会话”的通道。
//
// 用法（设备上，run-as 身份）：
//   $PREFIX/bin/node tools/zread.mjs <session.v4.jsonl.zstd> [末尾条数]
//
// 判据（见 docs/agents/verification.md ③）：
//   tool/call 与 tool/result 成对出现，且 result 正文是 `2000`
//   并且 stderr 带 `[dsh-adb] 通道: Shizuku（uid 2000）`。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const limit = Number(process.argv[3] || 8);

if (!file) {
  console.error('用法: node zread.mjs <session.v4.jsonl.zstd> [末尾条数]');
  process.exit(2);
}

let text;
try {
  text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
} catch (e) {
  console.error(`解压失败: ${e.message}`);
  console.error('提示：会话文件可能是上一版未压缩的 .jsonl，直接读即可。');
  process.exit(1);
}

const hit = text
  .split('\n')
  .filter((l) => l.includes('"tool/call"') || l.includes('"tool/result"'))
  .filter((l) => l.trim().length > 0);

if (hit.length === 0) {
  console.log('没有 tool/call 或 tool/result（这一轮模型没调工具）');
} else {
  for (const l of hit.slice(-limit)) console.log(l.slice(0, 400));
}

console.log(`--- 共 ${hit.length} 条 tool 事件 ---`);
