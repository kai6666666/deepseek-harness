#!/usr/bin/env node
/**
 * 桥资产的机械校验 —— 专治三类「静默炸掉整个文件」的注释/字符串陷阱。
 *
 * 这三类都踩过，症状都是「content script 整体不执行」，而**报错信息完全不指向真因**：
 *
 *   1. JS 的 `//` 注释里出现 `/*`（例如写 `/api/*`）→ 提前闭合块注释，
 *      后半段代码被吞进注释里。症状：脚本站点级不执行。
 *   2. 模板字符串（PAGE_SHIM_SOURCE / BRIDGE_INSTALLER_SOURCE 的内容）里出现反引号
 *      → 提前终止模板，字符串被截断成半截源码。**`node --check` 可能通过**，
 *      运行时才炸。
 *   3. 模板字符串的长度与预期严重不符（截断的间接信号）。
 *
 * Kotlin 侧还有第 4 类（块注释**会嵌套**，KDoc 里写 `files/mozilla/*​/…` 会吞掉
 * 文件后半段），那个由 `tools/scan-bridge.js --kotlin` 一并扫。
 *
 * 用法：node tools/scan-bridge.js [--kotlin]
 * 退出码：0 = 干净，1 = 发现问题。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = path.join(ROOT, 'app/src/gecko/assets/dsh-bridge/content.js');
const KOTLIN_DIR = path.join(ROOT, 'app/src/gecko/java/com/dsh/android/web');

const problems = [];

/** 逐行找「注释里出现了会破坏注释的词法」。 */
function scanComments(file, text) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    const trimmed = line.trim();
    const isLineComment = trimmed.startsWith('//');
    const isBlockBody = trimmed.startsWith('*') || trimmed.startsWith('/*');

    // ① // 或 * 打头的注释行里出现 /*（且不是行首那个）
    if ((isLineComment || isBlockBody) && line.includes('/*')) {
      const first = line.indexOf('/*');
      const atStart = line.slice(0, first).trim() === '' || line.slice(0, first).trim() === '//';
      if (!atStart) {
        problems.push(`${file}:${n} 注释里出现 /* —— 会提前闭合/嵌套块注释：${trimmed}`);
      }
    }
    // ② 注释行里出现 */（且不在行尾收尾）
    if (isLineComment && line.includes('*/')) {
      problems.push(`${file}:${n} 行注释里出现 */ —— 会提前闭合块注释：${trimmed}`);
    }
  });
}

/** 提取顶层 `const NAME = \`...\`;` 模板，检查反引号截断与语法。 */
function scanTemplates(file, text) {
  const re = /const\s+([A-Z0-9_]+)\s*=\s*`([\s\S]*?)`;/g;
  let m;
  let count = 0;
  while ((m = re.exec(text)) !== null) {
    count++;
    const [, name, body] = m;
    const n = text.slice(0, m.index).split('\n').length;
    // ③ 模板内容里出现裸反引号 = 已被截断（正则已经是最短匹配，能拿到说明是闭合点）
    //    真正的判据是：内容本身能否作为函数体解析。
    try {
      // 与运行时同样的方式解析（content.js 里就是 eval 成函数再调用）。
      new Function(body);
    } catch (e) {
      problems.push(`${file}:${n} 模板 ${name} 内容不是合法 JS —— 多半被反引号截断了：${e.message}`);
    }
    if (body.length < 40) {
      problems.push(`${file}:${n} 模板 ${name} 只有 ${body.length} 字符，疑似被提前截断`);
    }
    console.log(`  ${name}: ${body.length} 字符，语法 OK`);
  }
  if (count === 0) problems.push(`${file} 没找到任何模板字符串（结构变了？）`);
}

/** Kotlin 侧：扫 KDoc / 块注释里的 /*（嵌套注释会吞掉文件后半段）。 */
function scanKotlin() {
  if (!fs.existsSync(KOTLIN_DIR)) return;
  for (const f of fs.readdirSync(KOTLIN_DIR)) {
    if (!f.endsWith('.kt')) continue;
    const full = path.join(KOTLIN_DIR, f);
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))) return;
      const idx = line.indexOf('/*');
      if (idx < 0) return;
      const before = line.slice(0, idx).trim();
      if (before === '' || before === '//') return; // 行首那个才是真注释符
      problems.push(`${full}:${i + 1} KDoc 里出现 /* —— Kotlin 块注释会嵌套，会吞掉文件后半段：${trimmed}`);
    });
  }
}

console.log('== 扫 content.js ==');
const js = fs.readFileSync(BRIDGE, 'utf8');
scanComments(BRIDGE, js);
scanTemplates(BRIDGE, js);

console.log('== 扫 Kotlin ==');
scanKotlin();

console.log('');
if (problems.length === 0) {
  console.log('✅ 干净，没有发现注释/模板陷阱');
  process.exit(0);
}
console.log(`❌ 发现 ${problems.length} 处问题：`);
for (const p of problems) console.log('  - ' + p);
process.exit(1);
