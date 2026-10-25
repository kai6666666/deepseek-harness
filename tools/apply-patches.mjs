#!/usr/bin/env node
/**
 * apply-patches.mjs —— 声明式补丁队列，构建期 fail-fast
 *
 * 目的：把「运行时 `if (!source.contains(ANCHOR)) { log; return }` 的静默跳过」
 *      变成「构建期命中数不符 → exit 1」。
 *
 * 用法：
 *   DSH_ENGINE_ROOT=/path/to/engine node tools/apply-patches.mjs --dry-run
 *   DSH_ENGINE_ROOT=/path/to/engine node tools/apply-patches.mjs
 *   node tools/apply-patches.mjs --manifest patches/manifest.json --root <engine>
 *
 * 退出码：0 全部应用；1 有 REQUIRED 补丁失败；2 参数/清单错误。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

// G-11：锚点重定位开关。默认开启；--no-relocate 回到「严格精确匹配」。
//   --min-similarity 0.8  行窗口相似度阈值（低于此值不重定位，直接失败并诊断）
const relocateOn = !flag("--no-relocate");
const minSimilarity = Number(value("--min-similarity", "0.8"));
const manifestPath = resolve(value("--manifest", "patches/manifest.json"));
if (!existsSync(manifestPath)) {
  console.error(`✗ manifest 不存在: ${manifestPath}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const dryRun = flag("--dry-run");

const root = resolve(
  value("--root", process.env.DSH_ENGINE_ROOT ?? ""),
  "",
);
if (!process.env.DSH_ENGINE_ROOT && !value("--root", "")) {
  console.error("✗ 需要 DSH_ENGINE_ROOT 或 --root 指向引擎解包目录（含 node_modules）");
  process.exit(2);
}
if (!existsSync(join(root, "node_modules"))) {
  console.error(`✗ ${root} 下没有 node_modules，确认是不是引擎根目录`);
  process.exit(2);
}

const home = process.env.DSH_HOME ?? join(process.env.HOME ?? "/tmp", ".dsh");
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

// ── 回滚模式：用 .dshbak 恢复，删掉 overlay ──────────────────────────
if (flag("--revert")) {
  let restored = 0;
  for (const patch of manifest.patches) {
    if (patch.kind === "text") {
      const target = join(root, patch.file);
      const bak = target + ".dshbak";
      if (existsSync(bak)) {
        writeFileSync(target, readFileSync(bak, "utf8"), "utf8");
        console.log(`↩ ${patch.id}  已从 ${bak} 恢复`);
        restored += 1;
      }
    }
    if (patch.kind === "overlay") {
      const out = resolve(join(home, patch.writesTo.replace("$DSH_HOME/", "")));
      if (existsSync(out)) {
        writeFileSync(out + ".reverted", readFileSync(out, "utf8"), "utf8");
        console.log(`↩ ${patch.id}  已备份为 ${out}.reverted（未删除，避免误删用户配置）`);
        restored += 1;
      }
    }
  }
  console.log(`\n回滚完成：${restored} 项`);
  process.exit(0);
}

let failed = 0;
let applied = 0;
let skipped = 0;

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) return n;
    n += 1;
    i = at + needle.length;
  }
}

/* ── G-11：锚点自动重定位 ──────────────────────────────────────────────
 * 上游只是把缩进改了、或锚点前后各插了一行注释，旧的「精确子串匹配」就整体
 * 失配并 fail-fast。这里用「行窗口 + 逐行相似度」找回最可能的区间，只替换
 * 该区间，并且**一定打印重定位信息**——绝不静默改到别的地方。
 */
const normLine = (l) => l.trim().replace(/[ \t]+/g, " ");

function lineSim(a, b) {
  const n = Math.max(a.length, b.length);
  if (!n) return 0;
  let same = 0;
  const k = Math.min(a.length, b.length);
  for (let i = 0; i < k; i += 1) if (a[i] === b[i]) same += 1;
  return same / n;
}

/** 返回 { start, span, sim }（行号 0 基），找不到或不达标返回 null。 */
function relocate(before, find, minSim) {
  const bRaw = before.split("\n");
  const fRaw = find.split("\n");
  while (fRaw.length && !normLine(fRaw[fRaw.length - 1])) fRaw.pop();
  if (!fRaw.length) return null;
  const fn = fRaw.map(normLine);
  const bn = bRaw.map(normLine);
  const span = fn.length;
  if (span > bn.length) return null;
  let best = { sim: 0, start: -1 };
  for (let s = 0; s + span <= bn.length; s += 1) {
    const sim = lineSim(bn.slice(s, s + span), fn);
    if (sim > best.sim) best = { sim, start: s };
  }
  if (best.start < 0 || best.sim < minSim) return null;
  return { start: best.start, span, sim: best.sim };
}

/** 失败诊断：给出最相似的 3 处，方便人肉判断是「上游真删了」还是「锚点过期」。 */
function diagnose(before, find) {
  const bRaw = before.split("\n");
  const fn = find.split("\n").map(normLine).filter(Boolean);
  if (!fn.length) return [];
  const bn = bRaw.map(normLine);
  const span = Math.max(1, Math.min(fn.length, bn.length));
  const out = [];
  for (let s = 0; s + span <= bn.length; s += 1) {
    const sim = lineSim(bn.slice(s, s + span), fn);
    if (sim > 0) out.push({ sim, line: s + 1, head: (bRaw[s] ?? "").trim().slice(0, 100) });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, 3);
}

console.log(`引擎根目录: ${root}`);
console.log(`清单:       ${manifestPath}`);
console.log(`模式:       ${dryRun ? "dry-run（不写盘）" : "apply"}\n`);

for (const patch of manifest.patches) {
  const label = `[${patch.kind}] ${patch.id}`;

  if (patch.kind === "text") {
    const target = join(root, patch.file);
    if (!existsSync(target)) {
      if (patch.optional) {
        console.log(`- ${label}  跳过（文件不存在，optional）`);
        skipped += 1;
        continue;
      }
      console.error(`✗ ${label}  缺文件: ${target}`);
      failed += 1;
      continue;
    }

    const before = readFileSync(target, "utf8");
    const count = countOccurrences(before, patch.find);
    // 幂等判据用「目标串是否已存在」。注意 find 往往是 replace 的子串，
    // 所以不能要求 count===0 —— 那样第二次会被判成「未应用」并重复追加。
    const already = before.includes(patch.appliedMarker ?? patch.replace);

    if (already) {
      console.log(`= ${label}  已应用，跳过`);
      skipped += 1;
      continue;
    }

    // 条件跳过：目标平台包已存在时，这条补丁本就不需要
    if (patch.skipIfExists) {
      const marker = join(root, patch.skipIfExists);
      if (existsSync(marker)) {
        console.log(`- ${label}  跳过（${patch.skipIfExists} 已存在）`);
        skipped += 1;
        continue;
      }
    }

    // ── G-11：先精确匹配；失配则尝试锚点自动重定位（只替换对上的行窗口） ──
    let after = null;
    if (count === patch.requireCount) {
      after = before.split(patch.find).join(patch.replace);
    } else if (relocateOn && patch.requireCount === 1) {
      const r = relocate(before, patch.find, minSimilarity);
      if (r) {
        const bLines = before.split("\n");
        after = [
          ...bLines.slice(0, r.start),
          ...patch.replace.split("\n"),
          ...bLines.slice(r.start + r.span),
        ].join("\n");
        console.log(
          `↻ ${label}  锚点重定位：行 ${r.start + 1}–${r.start + r.span}，` +
            `相似度 ${(r.sim * 100).toFixed(0)}%（精确匹配 miss，已按行窗口对齐）`,
        );
      }
    }
    if (after === null) {
      const msg = `${label}  命中 ${count} 次，期望 ${patch.requireCount}`;
      if (patch.optional) {
        console.log(`- ${msg}  跳过（optional）`);
        skipped += 1;
        continue;
      }
      console.error(`✗ ${msg}\n  锚点: ${JSON.stringify(patch.find)}\n  说明: ${patch.why}`);
      for (const c of diagnose(before, patch.find)) {
        console.error(`  候选 第${c.line}行  相似度 ${(c.sim * 100).toFixed(0)}%  ${c.head}`);
      }
      failed += 1;
      continue;
    }
    if (dryRun) {
      console.log(`~ ${label}  可应用（${before.length} → ${after.length} B, sha ${sha(Buffer.from(after))}）`);
      applied += 1;
      continue;
    }
    // 首次改动前留一份 .dshbak，供 --revert 与人工排查
    const bak = target + ".dshbak";
    if (!existsSync(bak)) writeFileSync(bak, before, "utf8");
    writeFileSync(target, after, "utf8");
    console.log(`✓ ${label}  已应用（sha ${sha(Buffer.from(after))}，备份 ${bak}）`);
    applied += 1;
    continue;
  }

  if (patch.kind === "overlay") {
    const out = resolve(join(home, patch.writesTo.replace("$DSH_HOME/", "")));
    const tmpl = resolve(dirname(manifestPath), patch.contentTemplate);
    if (dryRun) {
      console.log(`~ ${label}  可写入 ${out}（模板 ${existsSync(tmpl) ? "就位" : "缺失"}）`);
      applied += 1;
      continue;
    }
    if (!existsSync(tmpl)) {
      console.error(`✗ ${label}  缺模板: ${tmpl}`);
      failed += 1;
      continue;
    }
    const content = readFileSync(tmpl, "utf8");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content, "utf8");
    console.log(`✓ ${label}  已写入 ${out}`);
    applied += 1;
    continue;
  }

  if (patch.kind === "asset") {
    const asset = join(root, patch.asset);
    if (!existsSync(asset)) {
      console.error(`✗ ${label}  缺资产: ${asset}`);
      failed += 1;
      continue;
    }
    const size = statSync(asset).size;
    console.log(`✓ ${label}  资产就位（${size} B, sha ${sha(readFileSync(asset))}）`);
    applied += 1;
    continue;
  }

  console.warn(`? ${label}  未知 kind，忽略`);
}

// 后置校验：verify 命令
for (const patch of manifest.patches) {
  for (const cmd of patch.verify ?? []) {
    if (dryRun) continue;
    try {
      execSync(cmd, { cwd: root, stdio: "pipe", env: { ...process.env, DSH_HOME: home } });
      console.log(`✓ verify ${patch.id}`);
    } catch {
      console.error(`✗ verify 失败 ${patch.id}: ${cmd}`);
      failed += 1;
    }
  }
}

console.log(`\n结果: applied=${applied} skipped=${skipped} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);